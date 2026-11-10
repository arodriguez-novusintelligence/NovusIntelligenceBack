import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { appsForCompany, getApp, publicApp, type AppTarget } from '../lib/apps';
import { errorResponse, json, log } from '../lib/http';
import { principalFromClaims, type Principal } from '../lib/principal';
import { createDynamoRepository, type PortalRepository } from '../lib/repository';
import {
  createRequestRepository,
  decisionAllowed,
  sanitizePrompt,
  type Actor,
  type Decision,
  type RequestRecord,
  type RequestRepository,
} from '../lib/requests';
import { permissionsFor, type Permission } from '../lib/roles';
import { createAwsServices } from '../lib/services';

export interface PreviewSession {
  token: string;
  userId: string;
  platformRole?: string;
}

export interface RequestServices {
  /** Lanza el ejecutor NADF (CodeBuild) para una fase. Devuelve el id de la ejecución. */
  startRun(request: RequestRecord, phase: 'develop' | 'deploy'): Promise<string>;
  /** ¿El usuario tiene MFA (TOTP) activo en Cognito? */
  mfaEnabled(username: string): Promise<boolean>;
  /** Inicia sesión en la app con el usuario de vista previa (credenciales en Secrets Manager). */
  previewSession(app: AppTarget): Promise<PreviewSession>;
  /** URL firmada (corta) para una evidencia del bucket. */
  presign(key: string): Promise<string>;
}

interface Ctx {
  requestId: string;
  principal: Principal;
  permissions: Permission[];
  actor: Actor;
}

export function createRequestsHandler(
  repo: PortalRepository,
  requests: RequestRepository,
  services: RequestServices,
  now: () => Date = () => new Date(),
  newId: () => string = randomUUID,
) {
  async function authorize(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<Ctx | APIGatewayProxyResultV2> {
    const requestId = event.requestContext.requestId;
    const principal = principalFromClaims(event.requestContext.authorizer?.jwt?.claims);
    if (!principal) return errorResponse(403, requestId, 'NO_COMPANY', 'Tu cuenta no está asociada a una empresa en NADF.');
    const [user, company] = await Promise.all([repo.getUser(principal.companyId, principal.userId), repo.getCompany(principal.companyId)]);
    if (!user || !company) return errorResponse(403, requestId, 'NOT_REGISTERED', 'Tu usuario no está registrado en NADF.');
    if (user.status === 'disabled' || company.status === 'disabled') {
      return errorResponse(403, requestId, 'DISABLED', 'Tu usuario o tu empresa están desactivados en NADF.');
    }
    return {
      requestId,
      principal,
      permissions: permissionsFor(principal.roles),
      actor: { id: principal.userId, email: principal.email, name: user.name ?? principal.name ?? null },
    };
  }

  const can = (ctx: Ctx, p: Permission) => ctx.permissions.includes(p);
  const canSee = (ctx: Ctx, r: RequestRecord) => can(ctx, 'reports.view') || (can(ctx, 'reports.viewOwn') && r.createdBy.id === ctx.actor.id);

  function body(event: APIGatewayProxyEventV2WithJWTAuthorizer): Record<string, unknown> {
    if (!event.body) return {};
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  function summary(r: RequestRecord) {
    return {
      requestId: r.requestId,
      appId: r.appId,
      title: r.title ?? r.prompt.slice(0, 90),
      status: r.status,
      stage: r.stage ?? null,
      iteration: r.iteration,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      prUrl: r.prUrl ?? null,
    };
  }

  async function detail(r: RequestRecord) {
    const sign = async (list?: { key: string; label: string }[]) =>
      Promise.all((list ?? []).map(async (s) => ({ label: s.label, url: await services.presign(s.key) })));
    const app = getApp(r.companyId, r.appId);
    return {
      ...r,
      app: app ? publicApp(app) : null,
      screenshots: await sign(r.screenshots),
      deployment: r.deployment ? { ...r.deployment, screenshots: await sign(r.deployment.screenshots) } : null,
    };
  }

  async function addEvent(requestId: string, text: string, kind: 'info' | 'stage' | 'success' | 'warning' | 'error' = 'info') {
    await requests.addEvent(requestId, { at: now().toISOString(), kind, text, stage: 'portal' });
  }

  async function launch(ctx: Ctx, record: RequestRecord, phase: 'develop' | 'deploy') {
    try {
      const buildId = await services.startRun(record, phase);
      await requests.transition(record.companyId, record.requestId, [record.status], { buildId, updatedAt: now().toISOString() });
      return null;
    } catch (error) {
      log({ level: 'error', requestId: ctx.requestId, event: 'runner.start_failed', message: (error as Error).message, req: record.requestId });
      await requests.transition(record.companyId, record.requestId, [record.status], {
        status: 'failed',
        error: { code: 'RUNNER_START_FAILED', message: 'No se pudo iniciar el agente. Intenta de nuevo en unos minutos.' },
        updatedAt: now().toISOString(),
      });
      await addEvent(record.requestId, 'No se pudo iniciar el agente de NADF.', 'error');
      return errorResponse(502, ctx.requestId, 'RUNNER_START_FAILED', 'No se pudo iniciar el agente. Intenta de nuevo en unos minutos.');
    }
  }

  // ---------- rutas ----------

  async function listApps(ctx: Ctx) {
    return json(200, { ok: true, requestId: ctx.requestId, apps: appsForCompany(ctx.principal.companyId).map(publicApp) });
  }

  async function create(ctx: Ctx, event: APIGatewayProxyEventV2WithJWTAuthorizer) {
    if (!can(ctx, 'requests.create')) return errorResponse(403, ctx.requestId, 'FORBIDDEN', 'Tu rol no permite crear solicitudes.');
    const input = body(event);
    const prompt = sanitizePrompt(input.prompt);
    if (!prompt) return errorResponse(400, ctx.requestId, 'INVALID_PROMPT', 'Describe el ajuste con al menos 10 caracteres (máximo 6000).');
    const apps = appsForCompany(ctx.principal.companyId);
    const appId = typeof input.appId === 'string' && input.appId ? input.appId : apps[0]?.id;
    const app = appId ? getApp(ctx.principal.companyId, appId) : null;
    if (!app) return errorResponse(400, ctx.requestId, 'NO_APP', 'Tu empresa todavía no tiene una aplicación conectada a NADF.');

    const at = now().toISOString();
    const record: RequestRecord = {
      requestId: newId(),
      companyId: ctx.principal.companyId,
      appId: app.id,
      prompt,
      status: 'queued',
      stage: 'queued',
      iteration: 1,
      createdBy: ctx.actor,
      createdAt: at,
      updatedAt: at,
    };
    await requests.create(record);
    await addEvent(record.requestId, `Solicitud recibida de ${ctx.actor.name ?? ctx.actor.email} para ${app.name}.`, 'stage');
    const failed = await launch(ctx, record, 'develop');
    if (failed) return failed;
    log({ level: 'info', requestId: ctx.requestId, event: 'request.created', req: record.requestId, app: app.id });
    return json(201, { ok: true, requestId: ctx.requestId, request: summary(record) });
  }

  async function list(ctx: Ctx) {
    if (!can(ctx, 'reports.view') && !can(ctx, 'reports.viewOwn')) return errorResponse(403, ctx.requestId, 'FORBIDDEN', 'Tu rol no permite ver solicitudes.');
    const all = await requests.list(ctx.principal.companyId);
    return json(200, { ok: true, requestId: ctx.requestId, requests: all.filter((r) => canSee(ctx, r)).map(summary) });
  }

  async function get(ctx: Ctx, event: APIGatewayProxyEventV2WithJWTAuthorizer, id: string) {
    const r = await requests.get(ctx.principal.companyId, id);
    if (!r || !canSee(ctx, r)) return errorResponse(404, ctx.requestId, 'NOT_FOUND', 'No encontramos esa solicitud.');
    const after = event.queryStringParameters?.after;
    const events = await requests.events(r.requestId, after && /^[0-9TZ:.\-#]+$/.test(after) ? after : undefined);
    return json(200, { ok: true, requestId: ctx.requestId, request: await detail(r), events });
  }

  async function decide(ctx: Ctx, event: APIGatewayProxyEventV2WithJWTAuthorizer, id: string) {
    const input = body(event);
    const decision = input.decision as Decision;
    if (!['approve', 'reject', 'changes'].includes(decision)) return errorResponse(400, ctx.requestId, 'INVALID_DECISION', 'Decisión no válida.');
    const comment = typeof input.comment === 'string' ? input.comment.trim().slice(0, 4000) : '';

    const r = await requests.get(ctx.principal.companyId, id);
    if (!r || !canSee(ctx, r)) return errorResponse(404, ctx.requestId, 'NOT_FOUND', 'No encontramos esa solicitud.');

    if (decision === 'approve' || decision === 'reject') {
      if (!can(ctx, 'approvals.decide')) return errorResponse(403, ctx.requestId, 'FORBIDDEN', 'Solo un aprobador puede aprobar o rechazar.');
    } else if (!can(ctx, 'approvals.decide') && !(can(ctx, 'requests.create') && r.createdBy.id === ctx.actor.id)) {
      return errorResponse(403, ctx.requestId, 'FORBIDDEN', 'Tu rol no permite pedir ajustes sobre esta solicitud.');
    }
    if (!decisionAllowed(r.status, decision)) {
      return errorResponse(409, ctx.requestId, 'INVALID_STATE', 'La solicitud ya no está en un estado que permita esa acción.');
    }
    if (decision === 'changes' && r.status === 'awaiting_approval' && !comment) {
      return errorResponse(400, ctx.requestId, 'COMMENT_REQUIRED', 'Cuéntale al agente qué ajustar.');
    }
    if (decision === 'approve') {
      const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
      const username = String(claims['cognito:username'] ?? ctx.principal.userId);
      if (!(await services.mfaEnabled(username))) {
        return errorResponse(403, ctx.requestId, 'MFA_REQUIRED', 'Para aprobar un despliegue a PROD activa la verificación en dos pasos en Seguridad.');
      }
    }

    const at = now().toISOString();
    const decisionRecord = { by: ctx.actor, at, decision, comment: comment || undefined };

    if (decision === 'reject') {
      const ok = await requests.transition(r.companyId, r.requestId, [r.status], { status: 'rejected', stage: 'rejected', decision: decisionRecord, updatedAt: at });
      if (!ok) return errorResponse(409, ctx.requestId, 'INVALID_STATE', 'Otra persona ya tomó una decisión sobre esta solicitud.');
      await addEvent(r.requestId, `${ctx.actor.name ?? ctx.actor.email} rechazó el despliegue${comment ? `: ${comment}` : '.'}`, 'warning');
      return json(200, { ok: true, requestId: ctx.requestId, status: 'rejected' });
    }

    if (decision === 'changes') {
      const feedback = [...(r.feedback ?? []), ...(comment ? [{ at, by: ctx.actor, text: comment }] : [])];
      const next: Partial<RequestRecord> = { status: 'queued', stage: 'queued', iteration: r.iteration + 1, feedback, decision: decisionRecord, error: undefined, updatedAt: at };
      const ok = await requests.transition(r.companyId, r.requestId, [r.status], next);
      if (!ok) return errorResponse(409, ctx.requestId, 'INVALID_STATE', 'Otra persona ya tomó una decisión sobre esta solicitud.');
      await addEvent(r.requestId, comment ? `${ctx.actor.name ?? ctx.actor.email} pidió ajustes: ${comment}` : `${ctx.actor.name ?? ctx.actor.email} pidió reintentar.`, 'stage');
      const failed = await launch(ctx, { ...r, ...next } as RequestRecord, 'develop');
      return failed ?? json(200, { ok: true, requestId: ctx.requestId, status: 'queued' });
    }

    // approve
    const ok = await requests.transition(r.companyId, r.requestId, ['awaiting_approval'], { status: 'approved', stage: 'approved', decision: decisionRecord, updatedAt: at });
    if (!ok) return errorResponse(409, ctx.requestId, 'INVALID_STATE', 'Otra persona ya tomó una decisión sobre esta solicitud.');
    await addEvent(r.requestId, `${ctx.actor.name ?? ctx.actor.email} aprobó el despliegue a PROD (con verificación en dos pasos).`, 'success');
    const failed = await launch(ctx, { ...r, status: 'approved' }, 'deploy');
    log({ level: 'info', requestId: ctx.requestId, event: 'request.approved', req: r.requestId, by: ctx.actor.email });
    return failed ?? json(200, { ok: true, requestId: ctx.requestId, status: 'approved' });
  }

  async function previewSession(ctx: Ctx, id: string) {
    const r = await requests.get(ctx.principal.companyId, id);
    if (!r || !canSee(ctx, r)) return errorResponse(404, ctx.requestId, 'NOT_FOUND', 'No encontramos esa solicitud.');
    if (!r.previewUrl) return errorResponse(409, ctx.requestId, 'NO_PREVIEW', 'Esta solicitud todavía no tiene vista previa.');
    const app = getApp(r.companyId, r.appId);
    if (!app) return errorResponse(409, ctx.requestId, 'NO_APP', 'La aplicación ya no está conectada.');
    try {
      const session = await services.previewSession(app);
      log({ level: 'info', requestId: ctx.requestId, event: 'preview.session', req: r.requestId, by: ctx.actor.email });
      return json(200, { ok: true, requestId: ctx.requestId, previewUrl: r.previewUrl, appOrigin: new URL(app.prod.url).origin, session });
    } catch (error) {
      log({ level: 'error', requestId: ctx.requestId, event: 'preview.session_failed', message: (error as Error).message });
      return errorResponse(502, ctx.requestId, 'PREVIEW_LOGIN_FAILED', 'No pudimos iniciar sesión en la aplicación para la vista previa.');
    }
  }

  return async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const auth = await authorize(event).catch((error) => {
      log({ level: 'error', requestId: event.requestContext.requestId, event: 'auth.failed', message: (error as Error).message });
      return errorResponse(500, event.requestContext.requestId, 'INTERNAL', 'Error interno.');
    });
    if (!isCtx(auth)) return auth;
    const ctx = auth;
    const id = event.pathParameters?.id ?? '';
    if (id && !/^[0-9a-f-]{36}$/.test(id)) return errorResponse(404, ctx.requestId, 'NOT_FOUND', 'No encontramos esa solicitud.');
    try {
      switch (event.routeKey) {
        case 'GET /api/v1/portal/apps':
          return await listApps(ctx);
        case 'POST /api/v1/portal/requests':
          return await create(ctx, event);
        case 'GET /api/v1/portal/requests':
          return await list(ctx);
        case 'GET /api/v1/portal/requests/{id}':
          return await get(ctx, event, id);
        case 'POST /api/v1/portal/requests/{id}/decision':
          return await decide(ctx, event, id);
        case 'POST /api/v1/portal/requests/{id}/preview-session':
          return await previewSession(ctx, id);
        default:
          return errorResponse(404, ctx.requestId, 'NOT_FOUND', 'Ruta no encontrada.');
      }
    } catch (error) {
      log({ level: 'error', requestId: ctx.requestId, event: 'requests.failed', route: event.routeKey, message: (error as Error).message });
      return errorResponse(500, ctx.requestId, 'INTERNAL', 'Ocurrió un error. Intenta de nuevo.');
    }
  };
}

function isCtx(value: unknown): value is Ctx {
  return typeof value === 'object' && value !== null && 'principal' in value;
}

let defaultHandler: ReturnType<typeof createRequestsHandler> | undefined;

export const handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  if (!defaultHandler) {
    const table = process.env.PORTAL_TABLE;
    if (!table) throw new Error('Missing required environment variable: PORTAL_TABLE');
    defaultHandler = createRequestsHandler(createDynamoRepository(table), createRequestRepository(table), createAwsServices());
  }
  return defaultHandler(event);
};
