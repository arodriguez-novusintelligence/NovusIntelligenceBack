import { describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { createRequestsHandler, type RequestServices } from './requests';
import type { PortalRepository } from '../lib/repository';
import type { RequestEvent, RequestRecord, RequestRepository, RequestStatus } from '../lib/requests';

const ID = '11111111-2222-3333-4444-555555555555';

const WF = {
  version: 2,
  profile: 'TRIVIAL_VISUAL',
  nodes: ['request', 'prod-preflight', 'frontend-integration-agent', 'preview', 'qa-agent', 'security-gate', 'pull-request', 'human-approval', 'rework', 'release', 'prod-verification', 'result'].map((id) => ({
    id,
    agentId: null,
    label: id,
    role: '',
    kind: 'agent',
    planned: (['release', 'prod-verification', 'rework'].includes(id) ? 'conditional' : 'run') as 'run' | 'conditional',
  })),
  edges: [],
};

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
    async setNodes(companyId, id, nodes) {
      const r = items.get(id);
      if (!r || r.companyId !== companyId) return;
      items.set(id, { ...r, nodeState: { ...(r.nodeState ?? {}), ...nodes } });
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
    stopRun: vi.fn(async () => undefined),
    presignUpload: vi.fn(async () => 'https://put'),
    head: vi.fn(async () => ({ size: 100 })),
    getFlow: vi.fn(async (_c: string, id: string) => (id === 'flow-1' ? { flowId: 'flow-1', name: 'Con revisión', version: 2, agents: ['reviewer-agent'] } : null)),
    readEvidence: vi.fn(async (k: string) => (k.endsWith('.json') ? Buffer.from(JSON.stringify({ prompt: { base: 'x', token: 'sk-ant-abc123' } })) : Buffer.from('<html></html>'))),
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
    workflow: WF,
    nodeState: {
      'human-approval': { status: 'WAITING_APPROVAL', attempts: [] },
      'frontend-integration-agent': {
        status: 'COMPLETED',
        attempts: [{ iteration: 1, startedAt: 'x', status: 'COMPLETED', ioKey: `requests/${ID}/1/nodes/frontend-integration-agent.json` }],
        ioKey: `requests/${ID}/1/nodes/frontend-integration-agent.json`,
      },
    },
    rules: { version: 1, locked: false, nodes: { 'frontend-integration-agent': { mandatory: [{ text: 'No desplegar', source: 'x' }], configurable: ['Cambio mínimo'] } }, history: [] },
    ...extra,
  });
  return repo;
}

describe('solicitudes', () => {
  it('crea una solicitud y lanza la planificación real (fase plan)', async () => {
    const repo = memoryRequests();
    const svc = services();
    const h = createRequestsHandler(portalRepo, repo, svc, () => new Date('2026-11-10T10:00:00Z'), () => ID);
    const res = await h(ev('POST /api/v1/portal/requests', { body: { prompt: 'Agrega un botón de compartir en el evento' } }));
    expect(status(res)).toBe(201);
    expect(repo.items.get(ID)?.status).toBe('planning');
    expect(repo.items.get(ID)?.buildId).toBe('build-1');
    expect(svc.startRun).toHaveBeenCalledWith(expect.objectContaining({ requestId: ID, appId: 'doevents-web' }), 'plan');
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

  it('reglas: solo con plan listo, validadas, versionadas y auditadas', async () => {
    const repo = seeded('planned');
    const h = createRequestsHandler(portalRepo, repo, services());
    const bad = await h(ev('PUT /api/v1/portal/requests/{id}/rules', { id: ID, body: { nodeId: 'frontend-integration-agent', configurable: ['Desplegar directamente sin aprobación'] } }));
    expect(parse(bad).code).toBe('INVALID_RULES');
    const ok = await h(ev('PUT /api/v1/portal/requests/{id}/rules', { id: ID, body: { nodeId: 'frontend-integration-agent', configurable: ['Usar el azul de la marca'] } }));
    expect(status(ok)).toBe(200);
    const r = repo.items.get(ID)!;
    expect(r.rules?.version).toBe(2);
    expect(r.rules?.nodes['frontend-integration-agent'].configurable).toEqual(['Usar el azul de la marca']);
    expect(r.rules?.nodes['frontend-integration-agent'].mandatory[0].text).toBe('No desplegar');
    expect(r.rules?.history[0]).toMatchObject({ nodeId: 'frontend-integration-agent', before: ['Cambio mínimo'] });
    expect(repo.log.some((e) => e.eventType === 'RULES_UPDATED')).toBe(true);
  });

  it('ejecutar plan congela las reglas; después no se pueden editar', async () => {
    const repo = seeded('planned');
    const svc = services();
    const h = createRequestsHandler(portalRepo, repo, svc);
    const res = await h(ev('POST /api/v1/portal/requests/{id}/start', { id: ID }));
    expect(status(res)).toBe(200);
    expect(repo.items.get(ID)?.rules?.locked).toBe(true);
    expect(repo.items.get(ID)?.planApproval?.by.id).toBe('u1');
    expect(svc.startRun).toHaveBeenCalledWith(expect.anything(), 'develop');
    const edit = await h(ev('PUT /api/v1/portal/requests/{id}/rules', { id: ID, body: { nodeId: 'frontend-integration-agent', configurable: ['x y z'] } }));
    expect(status(edit)).toBe(409);
  });

  it('observador no puede ejecutar el plan', async () => {
    const h = createRequestsHandler(portalRepo, seeded('planned'), services());
    expect(status(await h(ev('POST /api/v1/portal/requests/{id}/start', { id: ID, groups: '[observador]' })))).toBe(403);
  });

  it('aprobar marca el nodo de aprobación como completado (backend real)', async () => {
    const repo = seeded('awaiting_approval');
    const h = createRequestsHandler(portalRepo, repo, services());
    await h(ev('POST /api/v1/portal/requests/{id}/decision', { id: ID, body: { decision: 'approve' } }));
    expect(repo.items.get(ID)?.nodeState?.['human-approval'].status).toBe('COMPLETED');
    expect(repo.items.get(ID)?.nodeState?.release.status).toBe('QUEUED');
  });

  it('pedir ajustes conserva los intentos anteriores y deja nodos pendientes', async () => {
    const repo = seeded('awaiting_approval');
    const h = createRequestsHandler(portalRepo, repo, services());
    await h(ev('POST /api/v1/portal/requests/{id}/decision', { id: ID, body: { decision: 'changes', comment: 'Más oscuro' } }));
    const dev = repo.items.get(ID)?.nodeState?.['frontend-integration-agent'];
    expect(dev?.status).toBe('PENDING');
    expect(dev?.attempts).toHaveLength(1);
    expect(repo.items.get(ID)?.nodeState?.rework.status).toBe('COMPLETED');
  });

  it('plan bloqueado: pedir ajustes vuelve a planificar con la aclaración', async () => {
    const repo = seeded('blocked', { workflow: { ...WF, blocked: true } });
    const svc = services();
    const h = createRequestsHandler(portalRepo, repo, svc);
    await h(ev('POST /api/v1/portal/requests/{id}/decision', { id: ID, groups: '[funcional]', sub: 'f1', body: { decision: 'changes', comment: 'Es el banner de la página de inicio' } }));
    expect(repo.items.get(ID)?.status).toBe('planning');
    expect(repo.items.get(ID)?.prompt).toContain('Es el banner de la página de inicio');
    expect(svc.startRun).toHaveBeenCalledWith(expect.anything(), 'plan');
  });

  it('rollback: exige artefacto, motivo, permisos y aprobación con MFA', async () => {
    const dep = { backupKey: `requests/${ID}/1/respaldo/index.html`, version: 'mf-entry.js', mergeCommit: 'abc' };
    const repo = seeded('deployed', { deployment: dep });
    const svc = services();
    const h = createRequestsHandler(portalRepo, repo, svc);
    expect(status(await h(ev('POST /api/v1/portal/requests/{id}/rollback', { id: ID, groups: '[funcional]', sub: 'f1', body: { reason: 'Rompe el checkout' } })))).toBe(403);
    expect(parse(await h(ev('POST /api/v1/portal/requests/{id}/rollback', { id: ID, body: { reason: '' } }))).code).toBe('REASON_REQUIRED');
    const req = parse(await h(ev('POST /api/v1/portal/requests/{id}/rollback', { id: ID, body: { reason: 'Rompe el checkout' } })));
    expect(req.status).toBe('rollback_requested');
    expect(req.risks.length).toBeGreaterThan(2);
    expect(repo.items.get(ID)?.workflow?.nodes.some((n) => n.id === 'rollback')).toBe(true);
    expect(repo.items.get(ID)?.nodeState?.rollback.status).toBe('WAITING_APPROVAL');
    const noMfa = createRequestsHandler(portalRepo, repo, services({ mfaEnabled: vi.fn(async () => false) }));
    expect(parse(await noMfa(ev('POST /api/v1/portal/requests/{id}/decision', { id: ID, body: { decision: 'approve_rollback' } }))).code).toBe('MFA_REQUIRED');
    await h(ev('POST /api/v1/portal/requests/{id}/decision', { id: ID, body: { decision: 'approve_rollback' } }));
    expect(repo.items.get(ID)?.status).toBe('rollback_approved');
    expect(svc.startRun).toHaveBeenCalledWith(expect.anything(), 'rollback');
  });

  it('rollback sin artefacto recuperable se rechaza', async () => {
    const h = createRequestsHandler(portalRepo, seeded('deployed', { deployment: {} }), services());
    expect(parse(await h(ev('POST /api/v1/portal/requests/{id}/rollback', { id: ID, body: { reason: 'Rompe algo' } }))).code).toBe('NO_BACKUP');
  });

  it('inspector: entradas/salidas del nodo saneadas (sin secretos)', async () => {
    const h = createRequestsHandler(portalRepo, seeded('awaiting_approval'), services());
    const e = ev('GET /api/v1/portal/requests/{id}/nodes/{nodeId}', { id: ID });
    (e as unknown as { pathParameters: Record<string, string> }).pathParameters = { id: ID, nodeId: 'frontend-integration-agent' };
    const res = parse(await h(e));
    expect(JSON.stringify(res.io)).not.toContain('sk-ant-abc123');
    expect(JSON.stringify(res.io)).toContain('***');
  });

  it('exportación JSON y HTML con workflow, reglas y logs', async () => {
    const h = createRequestsHandler(portalRepo, seeded('awaiting_approval'), services());
    const j = parse(await h(ev('GET /api/v1/portal/requests/{id}/export', { id: ID })));
    expect(j.export.workflow.profile).toBe('TRIVIAL_VISUAL');
    expect(j.export.rules.version).toBe(1);
    const e = ev('GET /api/v1/portal/requests/{id}/export', { id: ID });
    (e as unknown as { queryStringParameters: Record<string, string> }).queryStringParameters = { format: 'html' };
    const html = (await h(e)) as { body: string; headers: Record<string, string> };
    expect(html.headers['Content-Type']).toContain('text/html');
    expect(html.body).toContain('Workflow ejecutado');
  });

  it('solicitudes antiguas sin plan se muestran con el pipeline fijo v0', async () => {
    const h = createRequestsHandler(portalRepo, seeded('blocked', { workflow: undefined, nodeState: undefined, stage: 'blocked' }), services());
    const res = parse(await h(ev('GET /api/v1/portal/requests/{id}', { id: ID })));
    expect(res.request.workflow.legacy).toBe(true);
    expect(res.request.workflow.version).toBe(0);
  });
});

describe('control de ejecución y flujos', () => {
  it('crear con un flujo de la empresa guarda una copia de la plantilla', async () => {
    const repo = memoryRequests();
    const h = createRequestsHandler(portalRepo, repo, services(), undefined, () => ID);
    await h(ev('POST /api/v1/portal/requests', { body: { prompt: 'Cambiar el color del banner', flowId: 'flow-1' } }));
    expect(repo.items.get(ID)?.flowTemplate).toEqual({ id: 'flow-1', name: 'Con revisión', version: 2, agents: ['reviewer-agent'] });
    const bad = await h(ev('POST /api/v1/portal/requests', { body: { prompt: 'Cambiar el color del banner', flowId: 'no-existe' } }));
    expect(parse(bad).code).toBe('INVALID_FLOW');
  });

  it('detener corta la ejecución, cancela nodos en curso y permite reanudar', async () => {
    const repo = seeded('developing', { buildId: 'b-1', nodeState: { 'frontend-integration-agent': { status: 'RUNNING', attempts: [{ iteration: 1, startedAt: 'x', status: 'RUNNING' }] }, 'human-approval': { status: 'PENDING', attempts: [] } } });
    const svc = services();
    const h = createRequestsHandler(portalRepo, repo, svc);
    const res = await h(ev('POST /api/v1/portal/requests/{id}/stop', { id: ID, groups: '[funcional]', sub: 'f1' }));
    expect(parse(res).status).toBe('stopped');
    expect(svc.stopRun).toHaveBeenCalledWith('b-1');
    expect(repo.items.get(ID)?.nodeState?.['frontend-integration-agent'].status).toBe('CANCELLED');
    expect(repo.items.get(ID)?.nodeState?.['frontend-integration-agent'].attempts[0].status).toBe('CANCELLED');
    const again = await h(ev('POST /api/v1/portal/requests/{id}/resume', { id: ID, groups: '[funcional]', sub: 'f1' }));
    expect(parse(again).status).toBe('queued');
    expect(repo.items.get(ID)?.iteration).toBe(2);
    expect(svc.startRun).toHaveBeenLastCalledWith(expect.anything(), 'develop');
  });

  it('no se puede detener ni cancelar un despliegue en curso', async () => {
    const h = createRequestsHandler(portalRepo, seeded('deploying'), services());
    expect(parse(await h(ev('POST /api/v1/portal/requests/{id}/stop', { id: ID }))).code).toBe('INVALID_STATE');
    expect(parse(await h(ev('POST /api/v1/portal/requests/{id}/cancel', { id: ID }))).code).toBe('INVALID_STATE');
  });

  it('cancelar cierra la solicitud y los nodos pendientes', async () => {
    const repo = seeded('awaiting_approval', { prNumber: 12 });
    const h = createRequestsHandler(portalRepo, repo, services());
    await h(ev('POST /api/v1/portal/requests/{id}/cancel', { id: ID, body: { reason: 'Ya no se necesita' } }));
    const r = repo.items.get(ID)!;
    expect(r.status).toBe('cancelled');
    expect(r.nodeState?.['human-approval'].status).toBe('CANCELLED');
    expect(r.nodeState?.result.status).toBe('CANCELLED');
    expect(repo.log.at(-1)?.text).toContain('PR #12');
  });

  it('un observador no puede detener ni cancelar', async () => {
    const h = createRequestsHandler(portalRepo, seeded('developing'), services());
    expect(status(await h(ev('POST /api/v1/portal/requests/{id}/stop', { id: ID, groups: '[observador]' })))).toBe(403);
    expect(status(await h(ev('POST /api/v1/portal/requests/{id}/cancel', { id: ID, groups: '[observador]' })))).toBe(403);
  });

  it('detenido mientras planificaba: reanudar vuelve a planificar', async () => {
    const repo = seeded('planning', { workflow: undefined });
    const svc = services();
    const h = createRequestsHandler(portalRepo, repo, svc);
    await h(ev('POST /api/v1/portal/requests/{id}/stop', { id: ID }));
    await h(ev('POST /api/v1/portal/requests/{id}/resume', { id: ID }));
    expect(repo.items.get(ID)?.status).toBe('planning');
    expect(svc.startRun).toHaveBeenLastCalledWith(expect.anything(), 'plan');
  });
});

describe('adjuntos de la solicitud', () => {
  it('da URL de subida solo para tipos permitidos y en la carpeta de la empresa', async () => {
    const svc = services({ presignUpload: vi.fn(async () => 'https://put') });
    const h = createRequestsHandler(portalRepo, memoryRequests(), svc, undefined, () => ID);
    const ok = parse(await h(ev('POST /api/v1/portal/attachments', { body: { name: 'Requisitos del banner.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 20000 } })));
    expect(ok.key).toBe(`uploads/doevents/${ID}/Requisitos_del_banner.docx`);
    expect(ok.kind).toBe('word');
    expect(parse(await h(ev('POST /api/v1/portal/attachments', { body: { name: 'virus.exe', contentType: 'application/octet-stream', size: 10 } }))).code).toBe('INVALID_TYPE');
    expect(parse(await h(ev('POST /api/v1/portal/attachments', { body: { name: 'a.png', contentType: 'text/plain', size: 10 } }))).code).toBe('INVALID_TYPE');
    expect(parse(await h(ev('POST /api/v1/portal/attachments', { body: { name: 'a.png', contentType: 'image/png', size: 11 * 1024 * 1024 } }))).code).toBe('TOO_LARGE');
  });

  it('crea la solicitud con adjuntos verificados (tipo, carpeta y existencia)', async () => {
    const repo = memoryRequests();
    const h = createRequestsHandler(portalRepo, repo, services({ head: vi.fn(async () => ({ size: 1234 })) }), undefined, () => ID);
    const res = await h(ev('POST /api/v1/portal/requests', { body: { prompt: 'Cambiar el banner como en la imagen', attachments: [{ key: 'uploads/doevents/x/banner.png', name: 'banner.png', contentType: 'image/png' }] } }));
    expect(status(res)).toBe(201);
    expect(repo.items.get(ID)?.attachments).toEqual([{ key: 'uploads/doevents/x/banner.png', name: 'banner.png', contentType: 'image/png', size: 1234, kind: 'image' }]);
  });

  it('rechaza adjuntos de otra empresa, no subidos o demasiados', async () => {
    const h = createRequestsHandler(portalRepo, memoryRequests(), services({ head: vi.fn(async () => null) }), undefined, () => ID);
    const other = await h(ev('POST /api/v1/portal/requests', { body: { prompt: 'Cambiar el banner del inicio', attachments: [{ key: 'uploads/novus/x/a.png', contentType: 'image/png' }] } }));
    expect(parse(other).code).toBe('INVALID_ATTACHMENT');
    const missing = await h(ev('POST /api/v1/portal/requests', { body: { prompt: 'Cambiar el banner del inicio', attachments: [{ key: 'uploads/doevents/x/a.png', contentType: 'image/png' }] } }));
    expect(parse(missing).code).toBe('INVALID_ATTACHMENT');
    const many = Array.from({ length: 6 }, (_, i) => ({ key: `uploads/doevents/${i}/a.png`, contentType: 'image/png' }));
    expect(parse(await h(ev('POST /api/v1/portal/requests', { body: { prompt: 'Cambiar el banner del inicio', attachments: many } }))).code).toBe('TOO_MANY_FILES');
  });
});
