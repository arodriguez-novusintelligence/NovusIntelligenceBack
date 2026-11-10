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
  type NodeState,
  type RequestRecord,
  type RequestRepository,
} from '../lib/requests';
import { permissionsFor, type Permission } from '../lib/roles';
import { createAwsServices } from '../lib/services';
import { legacyWorkflow, nodesAfterDecision, renderExportHtml, sanitize, validateRules, type ExportBundle } from '../lib/workflow';

export interface PreviewSession {
  token: string;
  userId: string;
  platformRole?: string;
}

export type RunPhase = 'plan' | 'develop' | 'deploy' | 'rollback';

export interface RequestServices {
  /** Lanza el ejecutor NADF (CodeBuild) para una fase. Devuelve el id de la ejecución. */
  startRun(request: RequestRecord, phase: RunPhase): Promise<string>;
  /** ¿El usuario tiene MFA (TOTP) activo en Cognito? */
  mfaEnabled(username: string): Promise<boolean>;
  /** Inicia sesión en la app con el usuario de vista previa (credenciales en Secrets Manager). */
  previewSession(app: AppTarget): Promise<PreviewSession>;
  /** URL firmada (corta) para una evidencia del bucket. */
  presign(key: string): Promise<string>;
  /** Lee una evidencia del bucket (null si no existe). */
  readEvidence(key: string): Promise<Buffer | null>;
}

interface Ctx {
  requestId: string;
  principal: Principal;
  permissions: Permission[];
  actor: Actor;
  username: string;
}

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

export function createRequestsHandler(
  repo: PortalRepository,
  requests: RequestRepository,
  services: RequestServices,
  now: () => Date = () => new Date(),
  newId: () => string = randomUUID,
) {
  async function authorize(event: Event): Promise<Ctx | APIGatewayProxyResultV2> {
    const requestId = event.requestContext.requestId;
    const claims = event.requestContext.authorizer?.jwt?.claims;
    const principal = principalFromClaims(claims);
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
      username: String(claims?.['cognito:username'] ?? principal.userId),
    };
  }

  const can = (ctx: Ctx, p: Permission) => ctx.permissions.includes(p);
  const canSee = (ctx: Ctx, r: RequestRecord) => can(ctx, 'reports.view') || (can(ctx, 'reports.viewOwn') && r.createdBy.id === ctx.actor.id);
  const isOwner = (ctx: Ctx, r: RequestRecord) => can(ctx, 'requests.create') && r.createdBy.id === ctx.actor.id;
  const who = (a: Actor) => a.name ?? a.email;

  function body(event: Event): Record<string, unknown> {
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
      profile: r.workflow?.profile ?? null,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      prUrl: r.prUrl ?? null,
    };
  }

  async function detail(r: RequestRecord) {
    const sign = async (items?: { key: string; label: string; kind?: string; route?: string }[]) =>
      Promise.all((items ?? []).map(async (s) => ({ label: s.label, kind: s.kind ?? null, route: s.route ?? null, url: await services.presign(s.key) })));
    const app = getApp(r.companyId, r.appId);
    const legacy = r.workflow ? null : legacyWorkflow(r);
    return {
      ...r,
      app: app ? publicApp(app) : null,
      workflow: r.workflow ?? legacy?.workflow ?? null,
      nodeState: r.workflow ? r.nodeState ?? {} : legacy?.nodeState ?? {},
      screenshots: await sign(r.screenshots),
      deployment: r.deployment ? { ...r.deployment, screenshots: await sign(r.deployment.screenshots) } : null,
    };
  }

  async function addEvent(requestId: string, text: string, kind: 'info' | 'stage' | 'success' | 'warning' | 'error' = 'info', extra: Record<string, string> = {}) {
    await requests.addEvent(requestId, { at: now().toISOString(), kind, text, stage: 'portal', ...extra });
  }

  async function launch(ctx: Ctx, record: RequestRecord, phase: RunPhase) {
    try {
      const buildId = await services.startRun(record, phase);
      await requests.transition(record.companyId, record.requestId, [record.status], { buildId, updatedAt: now().toISOString() });
      return null;
    } catch (error) {
      log({ level: 'error', requestId: ctx.requestId, event: 'runner.start_failed', message: (error as Error).message, req: record.requestId });
      await requests.transition(record.companyId, record.requestId, [record.status], {
        status: phase === 'rollback' ? 'deployed' : 'failed',
        error: { code: 'RUNNER_START_FAILED', message: 'No se pudo iniciar el agente. Intenta de nuevo en unos minutos.' },
        updatedAt: now().toISOString(),
      });
      await addEvent(record.requestId, 'No se pudo iniciar el agente de NADF.', 'error');
      return errorResponse(502, ctx.requestId, 'RUNNER_START_FAILED', 'No se pudo iniciar el agente. Intenta de nuevo en unos minutos.');
    }
  }

  async function load(ctx: Ctx, id: string) {
    const r = await requests.get(ctx.principal.companyId, id);
    return r && canSee(ctx, r) ? r : null;
  }
  const notFound = (ctx: Ctx) => errorResponse(404, ctx.requestId, 'NOT_FOUND', 'No encontramos esa solicitud.');
  const conflict = (ctx: Ctx, msg = 'La solicitud ya no está en un estado que permita esa acción.') => errorResponse(409, ctx.requestId, 'INVALID_STATE', msg);

  async function requireMfa(ctx: Ctx) {
    return (await services.mfaEnabled(ctx.username))
      ? null
      : errorResponse(403, ctx.requestId, 'MFA_REQUIRED', 'Para aprobar acciones sobre PROD activa la verificación en dos pasos en Seguridad.');
  }

  // ---------- rutas ----------

  async function listApps(ctx: Ctx) {
    return json(200, { ok: true, requestId: ctx.requestId, apps: appsForCompany(ctx.principal.companyId).map(publicApp) });
  }

  async function create(ctx: Ctx, event: Event) {
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
      status: 'planning',
      stage: 'planning',
      iteration: 1,
      createdBy: ctx.actor,
      createdAt: at,
      updatedAt: at,
      nodeState: {},
    };
    await requests.create(record);
    await addEvent(record.requestId, `Solicitud recibida de ${who(ctx.actor)} para ${app.name}. NADF está planificando.`, 'stage', { eventType: 'REQUEST_CREATED' });
    const failed = await launch(ctx, record, 'plan');
    if (failed) return failed;
    log({ level: 'info', requestId: ctx.requestId, event: 'request.created', req: record.requestId, app: app.id });
    return json(201, { ok: true, requestId: ctx.requestId, request: summary(record) });
  }

  async function list(ctx: Ctx) {
    if (!can(ctx, 'reports.view') && !can(ctx, 'reports.viewOwn')) return errorResponse(403, ctx.requestId, 'FORBIDDEN', 'Tu rol no permite ver solicitudes.');
    const all = await requests.list(ctx.principal.companyId);
    return json(200, { ok: true, requestId: ctx.requestId, requests: all.filter((r) => canSee(ctx, r)).map(summary) });
  }

  async function get(ctx: Ctx, event: Event, id: string) {
    const r = await load(ctx, id);
    if (!r) return notFound(ctx);
    const after = event.queryStringParameters?.after;
    const events = await requests.events(r.requestId, after && /^[0-9TZ:.\-#]+$/.test(after) ? after : undefined);
    return json(200, { ok: true, requestId: ctx.requestId, request: await detail(r), events });
  }

  /** Edición de reglas configurables: solo con el plan listo y antes de ejecutarlo. Queda auditada y versionada. */
  async function updateRules(ctx: Ctx, event: Event, id: string) {
    const r = await load(ctx, id);
    if (!r) return notFound(ctx);
    if (!(isOwner(ctx, r) || can(ctx, 'agents.manage') || can(ctx, 'approvals.decide'))) {
      return errorResponse(403, ctx.requestId, 'FORBIDDEN', 'Tu rol no permite editar las reglas de esta solicitud.');
    }
    if (r.status !== 'planned' || !r.rules || r.rules.locked) {
      return conflict(ctx, 'Las reglas solo se editan antes de ejecutar el plan. Para cambiarlas ahora, pide ajustes y se creará una nueva iteración.');
    }
    const input = body(event);
    const nodeId = typeof input.nodeId === 'string' ? input.nodeId : '';
    const current = r.rules.nodes[nodeId];
    if (!current) return errorResponse(400, ctx.requestId, 'UNKNOWN_NODE', 'Ese agente no está en el plan.');
    const invalid = validateRules(input.configurable);
    if (invalid) return errorResponse(400, ctx.requestId, 'INVALID_RULES', invalid);
    const after = (input.configurable as string[]).map((s) => s.trim());
    const at = now().toISOString();
    const version = r.rules.version + 1;
    const rules = {
      ...r.rules,
      version,
      nodes: { ...r.rules.nodes, [nodeId]: { ...current, configurable: after } },
      history: [...r.rules.history, { version, at, by: who(ctx.actor), nodeId, before: current.configurable, after }],
    };
    const ok = await requests.transition(r.companyId, r.requestId, ['planned'], { rules, updatedAt: at });
    if (!ok) return conflict(ctx);
    await addEvent(r.requestId, `${who(ctx.actor)} actualizó las reglas de ${nodeId} (versión ${version}).`, 'info', { nodeId, eventType: 'RULES_UPDATED' });
    return json(200, { ok: true, requestId: ctx.requestId, rules });
  }

  /** «Ejecutar plan» = gate plan del modelo de aprobación: congela reglas y lanza la ejecución. */
  async function start(ctx: Ctx, id: string) {
    const r = await load(ctx, id);
    if (!r) return notFound(ctx);
    if (!(isOwner(ctx, r) || can(ctx, 'approvals.decide'))) return errorResponse(403, ctx.requestId, 'FORBIDDEN', 'Tu rol no permite ejecutar este plan.');
    if (r.status !== 'planned' || !r.rules) return conflict(ctx);
    const at = now().toISOString();
    const rules = { ...r.rules, locked: true, lockedAt: at, lockedBy: ctx.actor };
    const next: Partial<RequestRecord> = { status: 'queued', stage: 'queued', rules, planApproval: { by: ctx.actor, at }, updatedAt: at };
    const ok = await requests.transition(r.companyId, r.requestId, ['planned'], next);
    if (!ok) return conflict(ctx);
    await addEvent(r.requestId, `${who(ctx.actor)} aprobó el plan (gate plan) y lo puso en ejecución. Reglas congeladas en la versión ${rules.version}.`, 'stage', { eventType: 'PLAN_APPROVED' });
    const failed = await launch(ctx, { ...r, ...next } as RequestRecord, 'develop');
    return failed ?? json(200, { ok: true, requestId: ctx.requestId, status: 'queued' });
  }

  async function decide(ctx: Ctx, event: Event, id: string) {
    const input = body(event);
    const decision = input.decision as Decision;
    if (!['approve', 'reject', 'changes', 'approve_rollback', 'reject_rollback'].includes(decision)) {
      return errorResponse(400, ctx.requestId, 'INVALID_DECISION', 'Decisión no válida.');
    }
    const comment = typeof input.comment === 'string' ? input.comment.trim().slice(0, 4000) : '';
    const r = await load(ctx, id);
    if (!r) return notFound(ctx);

    if (decision !== 'changes') {
      if (!can(ctx, 'approvals.decide')) return errorResponse(403, ctx.requestId, 'FORBIDDEN', 'Solo un aprobador puede tomar esta decisión.');
    } else if (!can(ctx, 'approvals.decide') && !isOwner(ctx, r)) {
      return errorResponse(403, ctx.requestId, 'FORBIDDEN', 'Tu rol no permite pedir ajustes sobre esta solicitud.');
    }
    if (!decisionAllowed(r.status, decision)) return conflict(ctx);
    if (decision === 'changes' && r.status === 'awaiting_approval' && !comment) {
      return errorResponse(400, ctx.requestId, 'COMMENT_REQUIRED', 'Cuéntale al agente qué ajustar.');
    }
    if (decision === 'approve' || decision === 'approve_rollback') {
      const mfa = await requireMfa(ctx);
      if (mfa) return mfa;
    }

    const at = now().toISOString();
    const decisionRecord = { by: ctx.actor, at, decision, comment: comment || undefined };

    if (decision === 'approve_rollback' || decision === 'reject_rollback') {
      const approve = decision === 'approve_rollback';
      const rollback = { ...r.rollback!, ...(approve ? { approvedBy: ctx.actor, approvedAt: at } : { rejectedBy: ctx.actor }) };
      const next: Partial<RequestRecord> = { status: approve ? 'rollback_approved' : 'deployed', stage: approve ? 'rollback_approved' : 'deployed', rollback, updatedAt: at };
      const ok = await requests.transition(r.companyId, r.requestId, ['rollback_requested'], next);
      if (!ok) return conflict(ctx, 'Otra persona ya decidió sobre este rollback.');
      if (r.workflow && !r.workflow.legacy) {
        await requests.setNodes(r.companyId, r.requestId, {
          rollback: { ...(r.nodeState?.rollback ?? { attempts: [] }), status: approve ? 'QUEUED' : 'CANCELLED', lastEvent: approve ? `Aprobado por ${who(ctx.actor)}.` : `Rechazado por ${who(ctx.actor)}.` } as NodeState,
        });
      }
      await addEvent(r.requestId, approve ? `${who(ctx.actor)} aprobó el rollback (con verificación en dos pasos).` : `${who(ctx.actor)} rechazó el rollback.`, approve ? 'success' : 'warning', { nodeId: 'rollback', eventType: approve ? 'ROLLBACK_APPROVED' : 'ROLLBACK_REJECTED' });
      if (!approve) return json(200, { ok: true, requestId: ctx.requestId, status: 'deployed' });
      const failed = await launch(ctx, { ...r, ...next } as RequestRecord, 'rollback');
      return failed ?? json(200, { ok: true, requestId: ctx.requestId, status: 'rollback_approved' });
    }

    if (decision === 'reject') {
      const ok = await requests.transition(r.companyId, r.requestId, [r.status], { status: 'rejected', stage: 'rejected', decision: decisionRecord, updatedAt: at });
      if (!ok) return conflict(ctx, 'Otra persona ya tomó una decisión sobre esta solicitud.');
      await requests.setNodes(r.companyId, r.requestId, nodesAfterDecision(r, 'reject', ctx.actor, comment)).catch(() => undefined);
      await addEvent(r.requestId, `${who(ctx.actor)} rechazó${r.status === 'awaiting_approval' ? ' el despliegue' : ' la solicitud'}${comment ? `: ${comment}` : '.'}`, 'warning', { nodeId: 'human-approval', eventType: 'APPROVAL_REJECTED' });
      return json(200, { ok: true, requestId: ctx.requestId, status: 'rejected' });
    }

    if (decision === 'changes') {
      const feedback = [...(r.feedback ?? []), ...(comment ? [{ at, by: ctx.actor, text: comment }] : [])];
      // Plan bloqueado (p. ej. ambiguo): se vuelve a planificar con la aclaración.
      const replan = Boolean(r.workflow?.blocked) || !r.workflow;
      const amendedPrompt = replan && comment ? `${r.prompt}\n\nAclaración de ${who(ctx.actor)}: ${comment}` : r.prompt;
      const next: Partial<RequestRecord> = replan
        ? { status: 'planning', stage: 'planning', prompt: amendedPrompt, feedback, decision: decisionRecord, error: null, updatedAt: at }
        : { status: 'queued', stage: 'queued', iteration: r.iteration + 1, feedback, decision: decisionRecord, error: null, updatedAt: at };
      const ok = await requests.transition(r.companyId, r.requestId, [r.status], next);
      if (!ok) return conflict(ctx, 'Otra persona ya tomó una decisión sobre esta solicitud.');
      if (!replan) await requests.setNodes(r.companyId, r.requestId, nodesAfterDecision(r, 'changes', ctx.actor, comment)).catch(() => undefined);
      await addEvent(r.requestId, comment ? `${who(ctx.actor)} pidió ajustes: ${comment}` : `${who(ctx.actor)} pidió reintentar.`, 'stage', { nodeId: 'rework', eventType: replan ? 'REPLAN_REQUESTED' : 'CHANGES_REQUESTED' });
      const failed = await launch(ctx, { ...r, ...next } as RequestRecord, replan ? 'plan' : 'develop');
      return failed ?? json(200, { ok: true, requestId: ctx.requestId, status: next.status });
    }

    // approve (gate deploy-prod)
    const ok = await requests.transition(r.companyId, r.requestId, ['awaiting_approval'], { status: 'approved', stage: 'approved', decision: decisionRecord, updatedAt: at });
    if (!ok) return conflict(ctx, 'Otra persona ya tomó una decisión sobre esta solicitud.');
    await requests.setNodes(r.companyId, r.requestId, nodesAfterDecision(r, 'approve', ctx.actor, comment)).catch(() => undefined);
    await addEvent(r.requestId, `${who(ctx.actor)} aprobó el despliegue a PROD (con verificación en dos pasos).`, 'success', { nodeId: 'human-approval', eventType: 'APPROVAL_GRANTED' });
    const failed = await launch(ctx, { ...r, status: 'approved' }, 'deploy');
    log({ level: 'info', requestId: ctx.requestId, event: 'request.approved', req: r.requestId, by: ctx.actor.email });
    return failed ?? json(200, { ok: true, requestId: ctx.requestId, status: 'approved' });
  }

  /** Solicitar rollback: valida que haya artefacto recuperable y registra riesgos; queda esperando aprobación. */
  async function requestRollback(ctx: Ctx, event: Event, id: string) {
    const r = await load(ctx, id);
    if (!r) return notFound(ctx);
    if (!can(ctx, 'deployments.operate')) return errorResponse(403, ctx.requestId, 'FORBIDDEN', 'Tu rol no permite solicitar un rollback.');
    if (r.status !== 'deployed') return conflict(ctx, 'Solo se puede revertir un despliegue en PROD.');
    const dep = r.deployment;
    if (!dep?.backupKey || !(await services.readEvidence(dep.backupKey))) {
      return errorResponse(409, ctx.requestId, 'NO_BACKUP', 'Este despliegue no tiene un artefacto recuperable registrado.');
    }
    const reason = typeof body(event).reason === 'string' ? String(body(event).reason).trim().slice(0, 2000) : '';
    if (reason.length < 5) return errorResponse(400, ctx.requestId, 'REASON_REQUIRED', 'Explica por qué hay que revertir.');
    const risks = [
      'Se restaura el index.html anterior; los archivos del despliegue siguen publicados pero dejan de usarse.',
      'Si alguien desplegó PROD después de este cambio, el rollback se detiene para no revertir su trabajo.',
      dep.mergeCommit ? 'main conserva el cambio hasta fusionar el PR de reversión que abre NADF.' : 'El PR no se había fusionado: main no cambia.',
      'Los datos creados en PROD mientras estuvo el cambio no se revierten.',
    ];
    const at = now().toISOString();
    const rollback = { requestedBy: ctx.actor, requestedAt: at, reason, risks };
    const ok = await requests.transition(r.companyId, r.requestId, ['deployed'], { status: 'rollback_requested', stage: 'rollback_requested', rollback, updatedAt: at });
    if (!ok) return conflict(ctx);
    if (r.workflow && !r.workflow.legacy && !r.workflow.nodes.some((n) => n.id === 'rollback')) {
      const workflow = {
        ...r.workflow,
        nodes: [...r.workflow.nodes, { id: 'rollback', agentId: 'devops-agent', label: 'Rollback', role: 'Restaura el artefacto respaldado, verifica PROD y abre el PR de reversión', kind: 'step', planned: 'conditional' as const, reason: 'Solicitado tras el despliegue.' }],
        edges: [...r.workflow.edges, { id: 'result->rollback', source: 'result', target: 'rollback', label: 'Rollback' }],
      };
      await requests.transition(r.companyId, r.requestId, ['rollback_requested'], { workflow });
      await requests.setNodes(r.companyId, r.requestId, { rollback: { status: 'WAITING_APPROVAL', attempts: [], lastEvent: `Solicitado por ${who(ctx.actor)}: ${reason}` } });
    }
    await addEvent(r.requestId, `${who(ctx.actor)} solicitó rollback: ${reason}`, 'warning', { nodeId: 'rollback', eventType: 'ROLLBACK_REQUESTED' });
    return json(200, { ok: true, requestId: ctx.requestId, status: 'rollback_requested', risks });
  }

  /** Entradas/salidas y prompt efectivo de un nodo (archivo de evidencias, ya saneado). */
  async function nodeIo(ctx: Ctx, event: Event, id: string, nodeId: string) {
    const r = await load(ctx, id);
    if (!r) return notFound(ctx);
    const state = r.nodeState?.[nodeId];
    if (!state) return errorResponse(404, ctx.requestId, 'NOT_FOUND', 'Ese nodo no tiene ejecuciones registradas.');
    const attempt = Number(event.queryStringParameters?.attempt ?? state.attempts.length);
    const key = state.attempts[attempt - 1]?.ioKey ?? state.ioKey;
    if (!key || !key.startsWith(`requests/${r.requestId}/`)) return json(200, { ok: true, requestId: ctx.requestId, io: null });
    const raw = await services.readEvidence(key);
    return json(200, { ok: true, requestId: ctx.requestId, io: raw ? sanitize(JSON.parse(raw.toString('utf8'))) : null });
  }

  async function exportRun(ctx: Ctx, event: Event, id: string) {
    const r = await load(ctx, id);
    if (!r) return notFound(ctx);
    const format = event.queryStringParameters?.format === 'html' ? 'html' : 'json';
    const legacy = r.workflow ? null : legacyWorkflow(r);
    const workflow = r.workflow ?? legacy?.workflow ?? null;
    const nodeState = r.workflow ? r.nodeState ?? {} : legacy?.nodeState ?? {};
    const events = await requests.events(r.requestId);
    const nodes = await Promise.all(
      (workflow?.nodes ?? []).map(async (n) => {
        const st = nodeState[n.id];
        const key = st?.ioKey;
        const raw = key && key.startsWith(`requests/${r.requestId}/`) ? await services.readEvidence(key) : null;
        return { id: n.id, label: n.label, status: st?.status ?? 'PENDING', planned: n.planned, reason: n.reason, attempts: st?.attempts ?? [], io: raw ? JSON.parse(raw.toString('utf8')) : null };
      }),
    );
    let budget = 4_000_000;
    const shots = [...(r.screenshots ?? []), ...(r.deployment?.screenshots ?? [])];
    const screenshots = await Promise.all(
      shots.map(async (s) => {
        if (format === 'json') return { label: s.label, key: s.key };
        const img = await services.readEvidence(s.key);
        if (!img || img.length > budget) return { label: s.label, key: s.key };
        budget -= img.length;
        return { label: s.label, key: s.key, dataUri: `data:image/png;base64,${img.toString('base64')}` };
      }),
    );
    const request: Partial<RequestRecord> = { ...r };
    delete request.nodeState;
    const bundle: ExportBundle = sanitize({ generatedAt: now().toISOString(), request, workflow, nodes, rules: r.rules ?? null, events, screenshots });
    await addEvent(r.requestId, `${who(ctx.actor)} exportó las evidencias (${format.toUpperCase()}).`, 'info', { eventType: 'EVIDENCE_EXPORTED' });
    if (format === 'html') {
      return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body: renderExportHtml(bundle) };
    }
    return json(200, { ok: true, requestId: ctx.requestId, export: bundle });
  }

  async function previewSession(ctx: Ctx, id: string) {
    const r = await load(ctx, id);
    if (!r) return notFound(ctx);
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

  return async (event: Event): Promise<APIGatewayProxyResultV2> => {
    const auth = await authorize(event).catch((error) => {
      log({ level: 'error', requestId: event.requestContext.requestId, event: 'auth.failed', message: (error as Error).message });
      return errorResponse(500, event.requestContext.requestId, 'INTERNAL', 'Error interno.');
    });
    if (!isCtx(auth)) return auth;
    const ctx = auth;
    const id = event.pathParameters?.id ?? '';
    const nodeId = event.pathParameters?.nodeId ?? '';
    if (id && !/^[0-9a-f-]{36}$/.test(id)) return notFound(ctx);
    if (nodeId && !/^[a-z0-9-]{2,60}$/.test(nodeId)) return notFound(ctx);
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
        case 'PUT /api/v1/portal/requests/{id}/rules':
          return await updateRules(ctx, event, id);
        case 'POST /api/v1/portal/requests/{id}/start':
          return await start(ctx, id);
        case 'POST /api/v1/portal/requests/{id}/decision':
          return await decide(ctx, event, id);
        case 'POST /api/v1/portal/requests/{id}/rollback':
          return await requestRollback(ctx, event, id);
        case 'GET /api/v1/portal/requests/{id}/nodes/{nodeId}':
          return await nodeIo(ctx, event, id, nodeId);
        case 'GET /api/v1/portal/requests/{id}/export':
          return await exportRun(ctx, event, id);
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

export const handler = (event: Event): Promise<APIGatewayProxyResultV2> => {
  if (!defaultHandler) {
    const table = process.env.PORTAL_TABLE;
    if (!table) throw new Error('Missing required environment variable: PORTAL_TABLE');
    defaultHandler = createRequestsHandler(createDynamoRepository(table), createRequestRepository(table), createAwsServices());
  }
  return defaultHandler(event);
};
