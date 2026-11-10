import { describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { createRequestsHandler, type RequestServices } from './requests';
import type { PortalRepository } from '../lib/repository';
import type { RequestEvent, RequestRecord, RequestRepository, RequestStatus } from '../lib/requests';

const ID = '11111111-2222-3333-4444-555555555555';

function memoryRequests(): RequestRepository & { items: Map<string, RequestRecord>; log: RequestEvent[] } {
  const items = new Map<string, RequestRecord>();
  const log: RequestEvent[] = [];
  return {
    items,
    log,
    async create(r) {
      items.set(r.requestId, structuredClone(r));
    },
    async get(companyId, id) {
      const r = items.get(id);
      return r && r.companyId === companyId ? structuredClone(r) : null;
    },
    async list(companyId) {
      return [...items.values()].filter((r) => r.companyId === companyId);
    },
    async transition(companyId, id, from: RequestStatus[], patch) {
      const r = items.get(id);
      if (!r || r.companyId !== companyId || !from.includes(r.status)) return false;
      items.set(id, { ...r, ...patch } as RequestRecord);
      return true;
    },
    async events() {
      return log;
    },
    async addEvent(_id, e) {
      log.push(e);
    },
  };
}

const portalRepo: PortalRepository = {
  async getCompany(companyId) {
    return { companyId, name: companyId === 'doevents' ? 'DoEvents' : 'Novus', status: 'active' };
  },
  async getUser(companyId, userId) {
    return { companyId, userId, email: `${userId}@x.com`, name: `User ${userId}`, status: 'active' };
  },
  async touchUser() {},
};

function services(over: Partial<RequestServices> = {}): RequestServices {
  return {
    startRun: vi.fn(async () => 'build-1'),
    mfaEnabled: vi.fn(async () => true),
    previewSession: vi.fn(async () => ({ token: 't', userId: 'u', platformRole: 'admin' })),
    presign: vi.fn(async (k: string) => `https://signed/${k}`),
    ...over,
  };
}

function ev(route: string, opts: { groups?: string; company?: string; sub?: string; body?: unknown; id?: string } = {}) {
  return {
    routeKey: route,
    pathParameters: opts.id ? { id: opts.id } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    requestContext: {
      requestId: 'rq',
      authorizer: {
        jwt: {
          claims: {
            sub: opts.sub ?? 'u1',
            email: 'a@x.com',
            'custom:companyId': opts.company ?? 'doevents',
            'cognito:groups': opts.groups ?? '[admin]',
          },
        },
      },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

const parse = (r: unknown) => JSON.parse((r as { body: string }).body);
const status = (r: unknown) => (r as { statusCode: number }).statusCode;

function seeded(st: RequestStatus, extra: Partial<RequestRecord> = {}) {
  const repo = memoryRequests();
  repo.items.set(ID, {
    requestId: ID,
    companyId: 'doevents',
    appId: 'doevents-web',
    prompt: 'Cambiar el texto del botón',
    status: st,
    iteration: 1,
    createdBy: { id: 'f1', email: 'f@x.com' },
    createdAt: '2026-11-10T00:00:00Z',
    updatedAt: '2026-11-10T00:00:00Z',
    previewUrl: 'https://web.doeventsapp.com/__nadf/preview/x/index.html',
    ...extra,
  });
  return repo;
}

describe('solicitudes', () => {
  it('crea una solicitud y lanza el agente en fase develop', async () => {
    const repo = memoryRequests();
    const svc = services();
    const h = createRequestsHandler(portalRepo, repo, svc, () => new Date('2026-11-10T10:00:00Z'), () => ID);
    const res = await h(ev('POST /api/v1/portal/requests', { body: { prompt: 'Agrega un botón de compartir en el evento' } }));
    expect(status(res)).toBe(201);
    expect(repo.items.get(ID)?.status).toBe('queued');
    expect(repo.items.get(ID)?.buildId).toBe('build-1');
    expect(svc.startRun).toHaveBeenCalledWith(expect.objectContaining({ requestId: ID, appId: 'doevents-web' }), 'develop');
  });

  it('rechaza un pedido vacío o muy corto', async () => {
    const h = createRequestsHandler(portalRepo, memoryRequests(), services());
    const res = await h(ev('POST /api/v1/portal/requests', { body: { prompt: 'hola' } }));
    expect(status(res)).toBe(400);
  });

  it('empresa sin apps no puede pedir', async () => {
    const h = createRequestsHandler(portalRepo, memoryRequests(), services());
    const res = await h(ev('POST /api/v1/portal/requests', { company: 'novus', body: { prompt: 'Agrega un botón de compartir' } }));
    expect(parse(res).code).toBe('NO_APP');
  });

  it('observador no puede crear', async () => {
    const h = createRequestsHandler(portalRepo, memoryRequests(), services());
    const res = await h(ev('POST /api/v1/portal/requests', { groups: '[observador]', body: { prompt: 'Agrega un botón de compartir' } }));
    expect(status(res)).toBe(403);
  });

  it('si el agente no arranca, la solicitud queda fallida', async () => {
    const repo = memoryRequests();
    const h = createRequestsHandler(portalRepo, repo, services({ startRun: vi.fn(async () => { throw new Error('x'); }) }), undefined, () => ID);
    const res = await h(ev('POST /api/v1/portal/requests', { body: { prompt: 'Agrega un botón de compartir' } }));
    expect(status(res)).toBe(502);
    expect(repo.items.get(ID)?.status).toBe('failed');
  });

  it('funcional solo ve sus solicitudes', async () => {
    const repo = seeded('awaiting_approval');
    const h = createRequestsHandler(portalRepo, repo, services());
    expect(parse(await h(ev('GET /api/v1/portal/requests', { groups: '[funcional]', sub: 'otro' }))).requests).toHaveLength(0);
    expect(parse(await h(ev('GET /api/v1/portal/requests', { groups: '[funcional]', sub: 'f1' }))).requests).toHaveLength(1);
    expect(status(await h(ev('GET /api/v1/portal/requests/{id}', { groups: '[funcional]', sub: 'otro', id: ID })))).toBe(404);
  });

  it('aprobar exige MFA activo', async () => {
    const repo = seeded('awaiting_approval');
    const h = createRequestsHandler(portalRepo, repo, services({ mfaEnabled: vi.fn(async () => false) }));
    const res = await h(ev('POST /api/v1/portal/requests/{id}/decision', { id: ID, body: { decision: 'approve' } }));
    expect(parse(res).code).toBe('MFA_REQUIRED');
    expect(repo.items.get(ID)?.status).toBe('awaiting_approval');
  });

  it('aprobar lanza el despliegue y no permite aprobar dos veces', async () => {
    const repo = seeded('awaiting_approval');
    const svc = services();
    const h = createRequestsHandler(portalRepo, repo, svc);
    const first = await h(ev('POST /api/v1/portal/requests/{id}/decision', { id: ID, body: { decision: 'approve' } }));
    expect(status(first)).toBe(200);
    expect(repo.items.get(ID)?.status).toBe('approved');
    expect(svc.startRun).toHaveBeenCalledWith(expect.objectContaining({ requestId: ID }), 'deploy');
    const second = await h(ev('POST /api/v1/portal/requests/{id}/decision', { id: ID, body: { decision: 'approve' } }));
    expect(status(second)).toBe(409);
  });

  it('funcional no puede aprobar', async () => {
    const h = createRequestsHandler(portalRepo, seeded('awaiting_approval'), services());
    const res = await h(ev('POST /api/v1/portal/requests/{id}/decision', { id: ID, groups: '[funcional]', sub: 'f1', body: { decision: 'approve' } }));
    expect(status(res)).toBe(403);
  });

  it('pedir ajustes crea una nueva iteración con el comentario', async () => {
    const repo = seeded('awaiting_approval');
    const svc = services();
    const h = createRequestsHandler(portalRepo, repo, svc);
    const res = await h(ev('POST /api/v1/portal/requests/{id}/decision', { id: ID, groups: '[funcional]', sub: 'f1', body: { decision: 'changes', comment: 'El botón debe ser azul' } }));
    expect(status(res)).toBe(200);
    const r = repo.items.get(ID)!;
    expect(r.iteration).toBe(2);
    expect(r.feedback?.[0].text).toBe('El botón debe ser azul');
    expect(svc.startRun).toHaveBeenCalledWith(expect.objectContaining({ iteration: 2 }), 'develop');
  });

  it('pedir ajustes sobre el informe exige comentario', async () => {
    const h = createRequestsHandler(portalRepo, seeded('awaiting_approval'), services());
    const res = await h(ev('POST /api/v1/portal/requests/{id}/decision', { id: ID, body: { decision: 'changes' } }));
    expect(parse(res).code).toBe('COMMENT_REQUIRED');
  });

  it('rechazar cierra la solicitud', async () => {
    const repo = seeded('awaiting_approval');
    const h = createRequestsHandler(portalRepo, repo, services());
    await h(ev('POST /api/v1/portal/requests/{id}/decision', { id: ID, body: { decision: 'reject', comment: 'No' } }));
    expect(repo.items.get(ID)?.status).toBe('rejected');
  });

  it('sesión de vista previa solo con vista previa lista', async () => {
    const h1 = createRequestsHandler(portalRepo, seeded('developing', { previewUrl: undefined }), services());
    expect(parse(await h1(ev('POST /api/v1/portal/requests/{id}/preview-session', { id: ID }))).code).toBe('NO_PREVIEW');
    const h2 = createRequestsHandler(portalRepo, seeded('awaiting_approval'), services());
    const ok = parse(await h2(ev('POST /api/v1/portal/requests/{id}/preview-session', { id: ID })));
    expect(ok.session.token).toBe('t');
    expect(ok.appOrigin).toBe('https://web.doeventsapp.com');
  });

  it('no cruza empresas', async () => {
    const h = createRequestsHandler(portalRepo, seeded('awaiting_approval'), services());
    expect(status(await h(ev('GET /api/v1/portal/requests/{id}', { company: 'novus', id: ID })))).toBe(404);
  });

  it('ids inválidos responden 404', async () => {
    const h = createRequestsHandler(portalRepo, memoryRequests(), services());
    expect(status(await h(ev('GET /api/v1/portal/requests/{id}', { id: '../x' })))).toBe(404);
  });
});
