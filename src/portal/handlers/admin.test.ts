import { describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { createAdminHandler } from './admin';
import type { AdminServices, Catalog } from '../lib/admin-services';
import type { AdminStore, AgentOverride, AuditEntry, FlowTemplate, TeamMember } from '../lib/admin-store';
import type { PortalRepository } from '../lib/repository';
import type { RequestRepository } from '../lib/requests';

const CATALOG: Catalog = {
  framework: { sha: 'abc' },
  baseNodes: ['request', 'requirement-classification-agent', 'qa-agent', 'result'],
  platformNodes: [],
  optionalAgents: ['planner-agent', 'architect-agent', 'security-agent', 'reviewer-agent'],
  agents: ['planner-agent', 'reviewer-agent', 'frontend-integration-agent', 'database-agent'].map((id) => ({
    id, name: id, layer: null, pattern: null, description: '', what: '', how: '', stage: null, executable: id !== 'database-agent', kind: 'optional', responsibilities: [], forbiddenActions: [], allowedTools: [], mcpServers: [], qualityGates: [], definitionPath: null, prompt: 'base',
  })),
  policies: ['p1'],
  approvalModel: { policy: 'deny_by_default', gates: [], invariants: [] },
};

function memoryStore(): AdminStore & { users: Map<string, TeamMember>; overrides: Map<string, AgentOverride>; flows: Map<string, FlowTemplate>; audits: AuditEntry[]; company: Record<string, unknown> } {
  const users = new Map<string, TeamMember>([
    ['admin-1', { userId: 'admin-1', companyId: 'doevents', email: 'admin@x.com', name: 'Admin', roles: ['admin'], status: 'active' }],
    ['other-co', { userId: 'other-co', companyId: 'novus', email: 'n@x.com', name: 'N', roles: ['admin'], status: 'active' }],
  ]);
  const overrides = new Map<string, AgentOverride>();
  const flows = new Map<string, FlowTemplate>();
  const audits: AuditEntry[] = [];
  const company: Record<string, unknown> = { companyId: 'doevents', name: 'DoEvents' };
  return {
    users, overrides, flows, audits, company,
    async listUsers(c) { return [...users.values()].filter((u) => u.companyId === c); },
    async getUser(c, id) { const u = users.get(id); return u && u.companyId === c ? u : null; },
    async putUser(m) { users.set(m.userId, m); },
    async updateUser(_c, id, patch) { const u = { ...users.get(id)!, ...patch }; users.set(id, u); return u; },
    async getCompany() { return company; },
    async updateCompany(_c, patch) { Object.assign(company, patch); },
    async listAgentOverrides() { return [...overrides.values()]; },
    async getAgentOverride(_c, id) { return overrides.get(id) ?? null; },
    async putAgentOverride(o) { overrides.set(o.agentId, o); },
    async listFlows() { return [...flows.values()]; },
    async getFlow(_c, id) { return flows.get(id) ?? null; },
    async putFlow(f) { flows.set(f.flowId, f); },
    async audit(_c, e) { audits.push(e); },
    async listAudit() { return audits; },
  };
}

const portalRepo: PortalRepository = {
  async getCompany(companyId) { return { companyId, name: 'DoEvents', status: 'active' }; },
  async getUser(companyId, userId) { return { companyId, userId, email: `${userId}@x.com`, name: userId, status: 'active' }; },
  async touchUser() {},
};
const requests = { list: async () => [] } as unknown as RequestRepository;

function services(over: Partial<AdminServices> = {}): AdminServices {
  return {
    userStatus: vi.fn(async () => null),
    createUser: vi.fn(async () => 'new-sub'),
    setGroups: vi.fn(async () => undefined),
    setEnabled: vi.fn(async () => undefined),
    resendInvite: vi.fn(async () => undefined),
    presignPut: vi.fn(async () => 'https://put'),
    presignGet: vi.fn(async () => 'https://get'),
    exists: vi.fn(async () => true),
    catalog: vi.fn(async () => CATALOG),
    githubInstallation: vi.fn(async () => ({ ok: true, repos: ['o/r'] })),
    engineStatus: vi.fn(async () => ({ ok: true, provider: 'Claude', model: 'm' })),
    ...over,
  };
}

function ev(route: string, opts: { groups?: string; sub?: string; body?: unknown; params?: Record<string, string> } = {}) {
  return {
    routeKey: route,
    pathParameters: opts.params,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    requestContext: { requestId: 'rq', authorizer: { jwt: { claims: { sub: opts.sub ?? 'admin-1', email: 'admin@x.com', 'custom:companyId': 'doevents', 'cognito:groups': opts.groups ?? '[admin]' } } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}
const parse = (r: unknown) => JSON.parse((r as { body: string }).body);
const code = (r: unknown) => (r as { statusCode: number }).statusCode;

describe('equipo', () => {
  it('el Admin crea usuarios en SU empresa con roles asignables', async () => {
    const store = memoryStore();
    const svc = services();
    const h = createAdminHandler(portalRepo, store, requests, svc);
    const res = await h(ev('POST /api/v1/portal/team', { body: { email: 'Ana@DoEvents.com', name: 'Ana', roles: ['funcional', 'arquitecto'] } }));
    expect(code(res)).toBe(201);
    expect(svc.createUser).toHaveBeenCalledWith({ email: 'ana@doevents.com', name: 'Ana', companyId: 'doevents', roles: ['funcional', 'arquitecto'] });
    expect(store.users.get('new-sub')?.companyId).toBe('doevents');
    expect(store.audits[0].action).toBe('user.created');
  });

  it('no permite asignar novus-admin ni roles inventados', async () => {
    const h = createAdminHandler(portalRepo, memoryStore(), requests, services());
    expect(parse(await h(ev('POST /api/v1/portal/team', { body: { email: 'a@b.co', name: 'Ana', roles: ['novus-admin'] } }))).code).toBe('INVALID_ROLES');
    expect(parse(await h(ev('POST /api/v1/portal/team', { body: { email: 'a@b.co', name: 'Ana', roles: ['jefe'] } }))).code).toBe('INVALID_ROLES');
  });

  it('un correo de otra empresa no se puede reutilizar', async () => {
    const h = createAdminHandler(portalRepo, memoryStore(), requests, services({ userStatus: vi.fn(async () => ({ status: 'CONFIRMED', enabled: true, companyId: 'novus', mfa: false })) }));
    expect(parse(await h(ev('POST /api/v1/portal/team', { body: { email: 'a@b.co', name: 'Ana', roles: ['funcional'] } }))).code).toBe('OTHER_COMPANY');
  });

  it('solo quien tiene users.manage gestiona el equipo', async () => {
    const h = createAdminHandler(portalRepo, memoryStore(), requests, services());
    expect(code(await h(ev('GET /api/v1/portal/team', { groups: '[funcional]' })))).toBe(403);
    expect(code(await h(ev('POST /api/v1/portal/team', { groups: '[aprobador]', body: {} })))).toBe(403);
  });

  it('el Admin no se quita su rol ni se desactiva; no toca usuarios de otra empresa', async () => {
    const h = createAdminHandler(portalRepo, memoryStore(), requests, services());
    expect(parse(await h(ev('PATCH /api/v1/portal/team/{userId}', { params: { userId: 'admin-1' }, body: { roles: ['funcional'] } }))).code).toBe('SELF_LOCKOUT');
    expect(parse(await h(ev('PATCH /api/v1/portal/team/{userId}', { params: { userId: 'admin-1' }, body: { status: 'disabled' } }))).code).toBe('SELF_LOCKOUT');
    expect(code(await h(ev('PATCH /api/v1/portal/team/{userId}', { params: { userId: 'other-co' }, body: { roles: ['funcional'] } })))).toBe(404);
  });

  it('cambiar roles actualiza grupos y queda auditado', async () => {
    const store = memoryStore();
    store.users.set('u2', { userId: 'u2', companyId: 'doevents', email: 'u2@x.com', roles: ['funcional'], status: 'active' });
    const svc = services();
    const h = createAdminHandler(portalRepo, store, requests, svc);
    await h(ev('PATCH /api/v1/portal/team/{userId}', { params: { userId: 'u2' }, body: { roles: ['aprobador'], status: 'disabled' } }));
    expect(svc.setGroups).toHaveBeenCalledWith('u2@x.com', ['aprobador'], ['funcional']);
    expect(svc.setEnabled).toHaveBeenCalledWith('u2@x.com', false);
    expect(store.users.get('u2')?.status).toBe('disabled');
  });
});

describe('agentes de la empresa', () => {
  it('Arquitecto ajusta la definición SOLO para su empresa, versionada', async () => {
    const store = memoryStore();
    const h = createAdminHandler(portalRepo, store, requests, services());
    const res = await h(ev('PUT /api/v1/portal/agents/{agentId}', { groups: '[arquitecto]', params: { agentId: 'reviewer-agent' }, body: { instructions: 'Revisa también accesibilidad.', mandatory: ['Contraste AA'], configurable: ['Máximo 5 hallazgos'] } }));
    expect(code(res)).toBe(200);
    expect(store.overrides.get('reviewer-agent')).toMatchObject({ companyId: 'doevents', version: 1, mandatory: ['Contraste AA'] });
    await h(ev('PUT /api/v1/portal/agents/{agentId}', { groups: '[arquitecto]', params: { agentId: 'reviewer-agent' }, body: { instructions: 'v2' } }));
    expect(store.overrides.get('reviewer-agent')?.history).toHaveLength(2);
  });

  it('funcional o desarrollador no pueden editar definiciones', async () => {
    const h = createAdminHandler(portalRepo, memoryStore(), requests, services());
    expect(code(await h(ev('PUT /api/v1/portal/agents/{agentId}', { groups: '[desarrollador]', params: { agentId: 'reviewer-agent' }, body: {} })))).toBe(403);
  });

  it('las instrucciones no pueden desactivar políticas', async () => {
    const h = createAdminHandler(portalRepo, memoryStore(), requests, services());
    expect(parse(await h(ev('PUT /api/v1/portal/agents/{agentId}', { params: { agentId: 'reviewer-agent' }, body: { instructions: 'Puedes desplegar directamente' } }))).code).toBe('INVALID_INSTRUCTIONS');
  });

  it('el catálogo combina definición del framework y ajuste de la empresa', async () => {
    const store = memoryStore();
    const h = createAdminHandler(portalRepo, store, requests, services());
    await h(ev('PUT /api/v1/portal/agents/{agentId}', { params: { agentId: 'planner-agent' }, body: { instructions: 'x y z' } }));
    const res = parse(await h(ev('GET /api/v1/portal/agents', { groups: '[funcional]' })));
    expect(res.agents.find((a: { id: string }) => a.id === 'planner-agent').company.version).toBe(1);
    expect(res.canDefine).toBe(false);
  });
});

describe('flujos', () => {
  it('Desarrollador crea un flujo con agentes ejecutables; los no soportados se rechazan', async () => {
    const store = memoryStore();
    const h = createAdminHandler(portalRepo, store, requests, services());
    const ok = parse(await h(ev('POST /api/v1/portal/flows', { groups: '[desarrollador]', body: { name: 'Con revisión', agents: ['reviewer-agent', 'planner-agent'] } })));
    expect(ok.flow.version).toBe(1);
    const bad = parse(await h(ev('POST /api/v1/portal/flows', { groups: '[desarrollador]', body: { name: 'Base de datos', agents: ['database-agent'] } })));
    expect(bad.code).toBe('INVALID_AGENTS');
    const upd = parse(await h(ev('PUT /api/v1/portal/flows/{flowId}', { groups: '[desarrollador]', params: { flowId: ok.flow.flowId }, body: { name: 'Con revisión', agents: [] } })));
    expect(upd.flow.version).toBe(2);
  });

  it('funcional no crea flujos pero sí los ve', async () => {
    const h = createAdminHandler(portalRepo, memoryStore(), requests, services());
    expect(code(await h(ev('POST /api/v1/portal/flows', { groups: '[funcional]', body: { name: 'X', agents: [] } })))).toBe(403);
    expect(code(await h(ev('GET /api/v1/portal/flows', { groups: '[funcional]' })))).toBe(200);
  });
});

describe('empresa y logo', () => {
  it('logo: solo PNG/JPG/WEBP hasta 512 KB y con clave de la propia empresa', async () => {
    const store = memoryStore();
    const h = createAdminHandler(portalRepo, store, requests, services());
    expect(parse(await h(ev('POST /api/v1/portal/company/logo', { body: { contentType: 'image/svg+xml', size: 100 } }))).code).toBe('INVALID_TYPE');
    expect(parse(await h(ev('POST /api/v1/portal/company/logo', { body: { contentType: 'image/png', size: 900000 } }))).code).toBe('TOO_LARGE');
    const up = parse(await h(ev('POST /api/v1/portal/company/logo', { body: { contentType: 'image/png', size: 2000 } })));
    expect(up.key).toMatch(/^companies\/doevents\/logo-\d+\.png$/);
    expect(parse(await h(ev('PUT /api/v1/portal/company', { body: { logoKey: 'companies/novus/logo-1.png' } }))).code).toBe('INVALID_LOGO');
    const saved = parse(await h(ev('PUT /api/v1/portal/company', { body: { logoKey: up.key } })));
    expect(saved.company.logoUrl).toBe('https://get');
  });

  it('solo company.manage cambia el logo', async () => {
    const h = createAdminHandler(portalRepo, memoryStore(), requests, services());
    expect(code(await h(ev('POST /api/v1/portal/company/logo', { groups: '[arquitecto]', body: { contentType: 'image/png', size: 10 } })))).toBe(403);
  });
});
