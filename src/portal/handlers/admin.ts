import { randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { appsForCompany } from '../lib/apps';
import { errorResponse, json, log } from '../lib/http';
import { principalFromClaims, type Principal } from '../lib/principal';
import { createDynamoRepository, type PortalRepository } from '../lib/repository';
import { createRequestRepository, type Actor, type RequestRepository } from '../lib/requests';
import { ASSIGNABLE_ROLES, isRole, permissionsFor, type Permission, type Role } from '../lib/roles';
import { createAdminStore, type AdminStore, type AgentOverride, type FlowTemplate, type TeamMember } from '../lib/admin-store';
import { createAdminServices, type AdminServices } from '../lib/admin-services';
import { validateRules } from '../lib/workflow';

type Event = APIGatewayProxyEventV2WithJWTAuthorizer;

interface Ctx {
  requestId: string;
  principal: Principal;
  permissions: Permission[];
  actor: Actor;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const FORBIDDEN_TEXT = /(sin aprobaci[oó]n|omit[ea]r? (la )?aprobaci|ignora(r)? (las )?(reglas|pol[ií]ticas)|desplega(r)? directamente|saltar(se)? (el )?(bloqueo|gate)|desactivar (la )?seguridad|incluir (la )?(clave|contrase|secret|token))/i;

/**
 * Administración de la empresa: equipo, perfil y logo, definiciones de agentes (ajustes SOLO de la empresa),
 * flujos, conectores y gobierno. Toda operación queda limitada a la empresa del token y se audita.
 */
export function createAdminHandler(repo: PortalRepository, store: AdminStore, requests: RequestRepository, services: AdminServices, now: () => Date = () => new Date()) {
  async function authorize(event: Event): Promise<Ctx | APIGatewayProxyResultV2> {
    const requestId = event.requestContext.requestId;
    const principal = principalFromClaims(event.requestContext.authorizer?.jwt?.claims);
    if (!principal) return errorResponse(403, requestId, 'NO_COMPANY', 'Tu cuenta no está asociada a una empresa en NADF.');
    const [user, company] = await Promise.all([repo.getUser(principal.companyId, principal.userId), repo.getCompany(principal.companyId)]);
    if (!user || !company || user.status === 'disabled' || company.status === 'disabled') {
      return errorResponse(403, requestId, 'NOT_REGISTERED', 'Tu usuario no está habilitado en NADF.');
    }
    return { requestId, principal, permissions: permissionsFor(principal.roles), actor: { id: principal.userId, email: principal.email, name: user.name ?? principal.name ?? null } };
  }
  const can = (ctx: Ctx, p: Permission) => ctx.permissions.includes(p);
  const forbid = (ctx: Ctx, msg = 'Tu rol no permite esta acción.') => errorResponse(403, ctx.requestId, 'FORBIDDEN', msg);
  const bad = (ctx: Ctx, code: string, msg: string) => errorResponse(400, ctx.requestId, code, msg);
  const who = (a: Actor) => a.name ?? a.email;
  const body = (event: Event): Record<string, unknown> => {
    try {
      const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '{}';
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  };
  const audit = (ctx: Ctx, action: string, detail: Record<string, unknown>) => store.audit(ctx.principal.companyId, { at: now().toISOString(), by: ctx.actor, action, detail });

  // ---------- Equipo ----------

  async function listTeam(ctx: Ctx) {
    if (!can(ctx, 'users.manage')) return forbid(ctx);
    const members = await store.listUsers(ctx.principal.companyId);
    const withStatus = await Promise.all(members.map(async (m) => ({ ...m, cognito: await services.userStatus(m.email).catch(() => null) })));
    return json(200, { ok: true, requestId: ctx.requestId, members: withStatus, assignableRoles: ASSIGNABLE_ROLES });
  }

  function parseRoles(raw: unknown): Role[] | null {
    if (!Array.isArray(raw) || !raw.length) return null;
    const roles = [...new Set(raw.map(String))];
    return roles.every((r) => isRole(r) && (ASSIGNABLE_ROLES as readonly string[]).includes(r)) ? (roles as Role[]) : null;
  }

  async function createMember(ctx: Ctx, event: Event) {
    if (!can(ctx, 'users.manage')) return forbid(ctx);
    const input = body(event);
    const email = String(input.email ?? '').trim().toLowerCase();
    const name = String(input.name ?? '').trim().slice(0, 120);
    const roles = parseRoles(input.roles);
    if (!EMAIL.test(email)) return bad(ctx, 'INVALID_EMAIL', 'Escribe un correo válido.');
    if (name.length < 2) return bad(ctx, 'INVALID_NAME', 'Escribe el nombre de la persona.');
    if (!roles) return bad(ctx, 'INVALID_ROLES', `Elige al menos un rol válido: ${ASSIGNABLE_ROLES.join(', ')}.`);
    const existing = await services.userStatus(email).catch(() => null);
    if (existing) {
      if (existing.companyId && existing.companyId !== ctx.principal.companyId) return errorResponse(409, ctx.requestId, 'OTHER_COMPANY', 'Ese correo ya pertenece a otra empresa en NADF.');
      return errorResponse(409, ctx.requestId, 'EXISTS', 'Esa persona ya tiene acceso. Edita sus roles en la lista.');
    }
    const userId = await services.createUser({ email, name, companyId: ctx.principal.companyId, roles });
    const member: TeamMember = { userId, companyId: ctx.principal.companyId, email, name, roles, status: 'active', createdAt: now().toISOString(), createdBy: ctx.actor };
    await store.putUser(member);
    await audit(ctx, 'user.created', { email, roles });
    log({ level: 'info', requestId: ctx.requestId, event: 'team.created', email, roles });
    return json(201, { ok: true, requestId: ctx.requestId, member });
  }

  async function updateMember(ctx: Ctx, event: Event, userId: string) {
    if (!can(ctx, 'users.manage')) return forbid(ctx);
    const member = await store.getUser(ctx.principal.companyId, userId);
    if (!member) return errorResponse(404, ctx.requestId, 'NOT_FOUND', 'No encontramos a esa persona en tu empresa.');
    if (member.roles.includes('novus-admin') && !ctx.principal.roles.includes('novus-admin')) return forbid(ctx, 'Solo Novus puede modificar a un Admin Novus.');
    const input = body(event);
    const patch: Partial<TeamMember> = {};
    if (input.roles !== undefined) {
      const roles = parseRoles(input.roles);
      if (!roles) return bad(ctx, 'INVALID_ROLES', 'Roles no válidos.');
      if (userId === ctx.actor.id && !roles.includes('admin') && ctx.principal.roles.includes('admin')) return bad(ctx, 'SELF_LOCKOUT', 'No puedes quitarte el rol Admin a ti mismo.');
      const keep = member.roles.filter((r) => r === 'novus-admin');
      await services.setGroups(member.email, [...keep, ...roles], member.roles);
      patch.roles = [...keep, ...roles];
    }
    if (input.status !== undefined) {
      if (!['active', 'disabled'].includes(String(input.status))) return bad(ctx, 'INVALID_STATUS', 'Estado no válido.');
      if (userId === ctx.actor.id) return bad(ctx, 'SELF_LOCKOUT', 'No puedes desactivarte a ti mismo.');
      await services.setEnabled(member.email, input.status === 'active');
      patch.status = input.status as 'active' | 'disabled';
    }
    if (typeof input.name === 'string' && input.name.trim().length >= 2) patch.name = input.name.trim().slice(0, 120);
    const updated = await store.updateUser(ctx.principal.companyId, userId, { ...patch, updatedAt: now().toISOString() });
    await audit(ctx, 'user.updated', { email: member.email, ...patch });
    return json(200, { ok: true, requestId: ctx.requestId, member: updated });
  }

  async function reinvite(ctx: Ctx, userId: string) {
    if (!can(ctx, 'users.manage')) return forbid(ctx);
    const member = await store.getUser(ctx.principal.companyId, userId);
    if (!member) return errorResponse(404, ctx.requestId, 'NOT_FOUND', 'No encontramos a esa persona en tu empresa.');
    const status = await services.userStatus(member.email);
    if (status?.status !== 'FORCE_CHANGE_PASSWORD') return errorResponse(409, ctx.requestId, 'ALREADY_ACTIVE', 'Esa persona ya activó su acceso.');
    await services.resendInvite(member.email);
    await audit(ctx, 'user.reinvited', { email: member.email });
    return json(200, { ok: true, requestId: ctx.requestId });
  }

  // ---------- Empresa y logo ----------

  async function getCompany(ctx: Ctx) {
    const c = await store.getCompany(ctx.principal.companyId);
    return json(200, { ok: true, requestId: ctx.requestId, company: { ...c, logoUrl: typeof c?.logoKey === 'string' ? await services.presignGet(c.logoKey) : null } });
  }

  async function logoUpload(ctx: Ctx, event: Event) {
    if (!can(ctx, 'company.manage')) return forbid(ctx);
    const input = body(event);
    const ext = LOGO_TYPES[String(input.contentType)];
    const size = Number(input.size);
    if (!ext) return bad(ctx, 'INVALID_TYPE', 'El logo debe ser PNG, JPG o WEBP.');
    if (!(size > 0 && size <= 512 * 1024)) return bad(ctx, 'TOO_LARGE', 'El logo puede pesar hasta 512 KB.');
    const key = `companies/${ctx.principal.companyId}/logo-${now().getTime()}.${ext}`;
    return json(200, { ok: true, requestId: ctx.requestId, key, uploadUrl: await services.presignPut(key, String(input.contentType), size) });
  }

  async function updateCompany(ctx: Ctx, event: Event) {
    if (!can(ctx, 'company.manage')) return forbid(ctx);
    const input = body(event);
    const patch: Record<string, unknown> = {};
    if (typeof input.name === 'string' && input.name.trim().length >= 2) patch.name = input.name.trim().slice(0, 120);
    if (typeof input.logoKey === 'string') {
      if (!input.logoKey.startsWith(`companies/${ctx.principal.companyId}/logo-`) || !(await services.exists(input.logoKey))) return bad(ctx, 'INVALID_LOGO', 'Sube el logo antes de guardarlo.');
      patch.logoKey = input.logoKey;
    }
    if (!Object.keys(patch).length) return bad(ctx, 'NOTHING', 'No hay cambios.');
    await store.updateCompany(ctx.principal.companyId, { ...patch, updatedAt: now().toISOString() });
    await audit(ctx, 'company.updated', patch);
    return getCompany(ctx);
  }

  // ---------- Agentes (definición del framework + ajustes de la empresa) ----------

  async function listAgents(ctx: Ctx) {
    const [catalog, overrides] = await Promise.all([services.catalog(), store.listAgentOverrides(ctx.principal.companyId)]);
    const byId = new Map(overrides.map((o) => [o.agentId, o]));
    return json(200, {
      ok: true,
      requestId: ctx.requestId,
      framework: catalog.framework,
      baseNodes: catalog.baseNodes,
      optionalAgents: catalog.optionalAgents,
      agents: catalog.agents.map((a) => ({ ...a, company: byId.get(a.id) ?? null })),
      canDefine: can(ctx, 'agents.define'),
    });
  }

  async function defineAgent(ctx: Ctx, event: Event, agentId: string) {
    if (!can(ctx, 'agents.define')) return forbid(ctx, 'Solo un Arquitecto o un Admin pueden ajustar la definición de un agente.');
    const catalog = await services.catalog();
    if (!catalog.agents.some((a) => a.id === agentId)) return errorResponse(404, ctx.requestId, 'NOT_FOUND', 'Ese agente no existe en el framework.');
    const input = body(event);
    const instructions = typeof input.instructions === 'string' ? input.instructions.trim().slice(0, 4000) : '';
    const mandatory = Array.isArray(input.mandatory) ? input.mandatory.map((x) => String(x).trim()).filter(Boolean) : [];
    const configurable = Array.isArray(input.configurable) ? input.configurable.map((x) => String(x).trim()).filter(Boolean) : [];
    for (const list of [mandatory, configurable]) {
      const invalid = validateRules(list);
      if (invalid) return bad(ctx, 'INVALID_RULES', invalid);
    }
    if (FORBIDDEN_TEXT.test(instructions)) return bad(ctx, 'INVALID_INSTRUCTIONS', 'Las instrucciones no pueden desactivar políticas obligatorias de NADF.');
    const current = await store.getAgentOverride(ctx.principal.companyId, agentId);
    const at = now().toISOString();
    const version = (current?.version ?? 0) + 1;
    const next: AgentOverride = {
      agentId,
      companyId: ctx.principal.companyId,
      version,
      instructions,
      mandatory,
      configurable,
      updatedAt: at,
      updatedBy: ctx.actor,
      history: [...(current?.history ?? []), { version, at, by: who(ctx.actor), instructions, mandatory, configurable }].slice(-50),
    };
    await store.putAgentOverride(next);
    await audit(ctx, 'agent.defined', { agentId, version, scope: 'empresa' });
    return json(200, { ok: true, requestId: ctx.requestId, company: next });
  }

  // ---------- Flujos ----------

  async function listFlows(ctx: Ctx) {
    return json(200, { ok: true, requestId: ctx.requestId, flows: (await store.listFlows(ctx.principal.companyId)).filter((f) => !f.archived), canManage: can(ctx, 'workflows.manage') });
  }

  async function saveFlow(ctx: Ctx, event: Event, flowId?: string) {
    if (!can(ctx, 'workflows.manage')) return forbid(ctx, 'Solo un Desarrollador, Arquitecto o Admin pueden crear flujos.');
    const catalog = await services.catalog();
    const input = body(event);
    const name = String(input.name ?? '').trim().slice(0, 80);
    const description = String(input.description ?? '').trim().slice(0, 600);
    const agents = Array.isArray(input.agents) ? [...new Set(input.agents.map(String))] : [];
    if (name.length < 3) return bad(ctx, 'INVALID_NAME', 'Ponle un nombre al flujo.');
    const invalid = agents.filter((a) => !catalog.optionalAgents.includes(a));
    if (invalid.length) return bad(ctx, 'INVALID_AGENTS', `Estos agentes no se pueden agregar al flujo todavía: ${invalid.join(', ')}.`);
    const at = now().toISOString();
    const current = flowId ? await store.getFlow(ctx.principal.companyId, flowId) : null;
    if (flowId && !current) return errorResponse(404, ctx.requestId, 'NOT_FOUND', 'Ese flujo no existe.');
    const flow: FlowTemplate = {
      flowId: flowId ?? randomUUID(),
      companyId: ctx.principal.companyId,
      name,
      description,
      agents,
      version: (current?.version ?? 0) + 1,
      createdAt: current?.createdAt ?? at,
      createdBy: current?.createdBy ?? ctx.actor,
      updatedAt: at,
      updatedBy: ctx.actor,
      archived: false,
    };
    await store.putFlow(flow);
    await audit(ctx, flowId ? 'flow.updated' : 'flow.created', { flowId: flow.flowId, name, agents, version: flow.version });
    return json(flowId ? 200 : 201, { ok: true, requestId: ctx.requestId, flow });
  }

  async function archiveFlow(ctx: Ctx, flowId: string) {
    if (!can(ctx, 'workflows.manage')) return forbid(ctx);
    const current = await store.getFlow(ctx.principal.companyId, flowId);
    if (!current) return errorResponse(404, ctx.requestId, 'NOT_FOUND', 'Ese flujo no existe.');
    await store.putFlow({ ...current, archived: true, updatedAt: now().toISOString(), updatedBy: ctx.actor });
    await audit(ctx, 'flow.archived', { flowId, name: current.name });
    return json(200, { ok: true, requestId: ctx.requestId });
  }

  // ---------- Conectores y gobierno ----------

  async function connectors(ctx: Ctx) {
    const apps = appsForCompany(ctx.principal.companyId);
    const all = await requests.list(ctx.principal.companyId);
    const lastPreflight = all.find((r) => r.nodeState?.['prod-preflight']?.status === 'COMPLETED');
    const out = await Promise.all(
      apps.map(async (app) => ({
        app: { id: app.id, name: app.name, url: app.prod.url },
        github: await services.githubInstallation(app.repo.installationId, `${app.repo.owner}/${app.repo.name}`).catch((e) => ({ ok: false, error: (e as Error).message })),
        cloud: {
          provider: 'AWS',
          role: app.prod.deployRoleArn.split('/').pop(),
          environment: 'PROD',
          lastVerified: lastPreflight ? { at: lastPreflight.nodeState?.['prod-preflight']?.endedAt ?? lastPreflight.updatedAt, requestId: lastPreflight.requestId } : null,
        },
      })),
    );
    return json(200, { ok: true, requestId: ctx.requestId, engine: await services.engineStatus().catch(() => ({ ok: false })), apps: out });
  }

  async function governance(ctx: Ctx) {
    if (!can(ctx, 'audit.view') && !can(ctx, 'usage.view')) return forbid(ctx);
    const [catalog, auditItems, all] = await Promise.all([services.catalog(), store.listAudit(ctx.principal.companyId, 150), requests.list(ctx.principal.companyId)]);
    const byStatus: Record<string, number> = {};
    for (const r of all) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const decisions = all
      .filter((r) => r.decision || r.planApproval || r.rollback || r.riskAcceptance)
      .flatMap((r) => [
        ...(r.planApproval ? [{ at: r.planApproval.at, by: r.planApproval.by, action: 'plan.approved', detail: { requestId: r.requestId, title: r.title } }] : []),
        ...(r.decision ? [{ at: r.decision.at, by: r.decision.by, action: `deploy.${r.decision.decision}`, detail: { requestId: r.requestId, title: r.title } }] : []),
        ...(r.rollback ? [{ at: r.rollback.requestedAt, by: r.rollback.requestedBy, action: 'rollback.requested', detail: { requestId: r.requestId, title: r.title } }] : []),
        ...(r.riskAcceptance ? [{ at: r.riskAcceptance.at, by: r.riskAcceptance.by, action: 'risk.accepted', detail: { requestId: r.requestId, title: r.title, justification: r.riskAcceptance.justification } }] : []),
      ]);
    return json(200, {
      ok: true,
      requestId: ctx.requestId,
      policies: catalog.policies,
      approvalModel: catalog.approvalModel,
      framework: catalog.framework,
      audit: [...auditItems, ...decisions].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200),
      usage: {
        requests: all.length,
        byStatus,
        costUsd: Math.round(all.reduce((acc, r) => acc + (r.costUsd ?? 0), 0) * 100) / 100,
        costNote: 'Suma del costo reportado por Claude Code; los agentes por API reportan tokens, no costo.',
      },
    });
  }

  return async (event: Event): Promise<APIGatewayProxyResultV2> => {
    const auth = await authorize(event).catch(() => errorResponse(500, event.requestContext.requestId, 'INTERNAL', 'Error interno.'));
    if (typeof auth !== 'object' || auth === null || !('principal' in auth)) return auth as APIGatewayProxyResultV2;
    const ctx = auth as Ctx;
    const p = event.pathParameters ?? {};
    for (const v of Object.values(p)) if (v && !/^[a-z0-9-]{2,64}$/i.test(v)) return errorResponse(404, ctx.requestId, 'NOT_FOUND', 'No encontrado.');
    try {
      switch (event.routeKey) {
        case 'GET /api/v1/portal/team':
          return await listTeam(ctx);
        case 'POST /api/v1/portal/team':
          return await createMember(ctx, event);
        case 'PATCH /api/v1/portal/team/{userId}':
          return await updateMember(ctx, event, p.userId!);
        case 'POST /api/v1/portal/team/{userId}/reinvite':
          return await reinvite(ctx, p.userId!);
        case 'GET /api/v1/portal/company':
          return await getCompany(ctx);
        case 'PUT /api/v1/portal/company':
          return await updateCompany(ctx, event);
        case 'POST /api/v1/portal/company/logo':
          return await logoUpload(ctx, event);
        case 'GET /api/v1/portal/agents':
          return await listAgents(ctx);
        case 'PUT /api/v1/portal/agents/{agentId}':
          return await defineAgent(ctx, event, p.agentId!);
        case 'GET /api/v1/portal/flows':
          return await listFlows(ctx);
        case 'POST /api/v1/portal/flows':
          return await saveFlow(ctx, event);
        case 'PUT /api/v1/portal/flows/{flowId}':
          return await saveFlow(ctx, event, p.flowId!);
        case 'DELETE /api/v1/portal/flows/{flowId}':
          return await archiveFlow(ctx, p.flowId!);
        case 'GET /api/v1/portal/connectors':
          return await connectors(ctx);
        case 'GET /api/v1/portal/governance':
          return await governance(ctx);
        default:
          return errorResponse(404, ctx.requestId, 'NOT_FOUND', 'Ruta no encontrada.');
      }
    } catch (error) {
      log({ level: 'error', requestId: ctx.requestId, event: 'admin.failed', route: event.routeKey, message: (error as Error).message });
      return errorResponse(500, ctx.requestId, 'INTERNAL', 'Ocurrió un error. Intenta de nuevo.');
    }
  };
}

let defaultHandler: ReturnType<typeof createAdminHandler> | undefined;
export const handler = (event: Event) => {
  if (!defaultHandler) {
    const table = process.env.PORTAL_TABLE;
    if (!table) throw new Error('Missing required environment variable: PORTAL_TABLE');
    defaultHandler = createAdminHandler(createDynamoRepository(table), createAdminStore(table), createRequestRepository(table), createAdminServices());
  }
  return defaultHandler(event);
};
