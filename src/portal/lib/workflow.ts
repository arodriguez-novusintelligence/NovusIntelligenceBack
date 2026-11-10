import type { Actor, NodeState, NodeStatus, RequestEvent, RequestRecord, Workflow } from './requests';

/** Nodos que se re-ejecutan en una nueva iteración (lo anterior al desarrollo no se repite). */
const EXECUTION_NODES = [
  'prod-preflight',
  'planner-agent',
  'architect-agent',
  'frontend-integration-agent',
  'backend-agent',
  'preview',
  'qa-agent',
  'security-gate',
  'security-agent',
  'reviewer-agent',
  'pull-request',
  'human-approval',
  'rework',
  'release',
  'prod-verification',
  'result',
];

const now = () => new Date().toISOString();

function node(r: RequestRecord, id: string): NodeState {
  return structuredClone(r.nodeState?.[id] ?? { status: 'PENDING', attempts: [] });
}

function finish(n: NodeState, status: NodeStatus, text: string, output?: unknown, iteration = 1): NodeState {
  const at = now();
  return {
    ...n,
    status,
    startedAt: n.startedAt ?? at,
    endedAt: at,
    lastEvent: text,
    attempts: [...(n.attempts ?? []), { iteration, startedAt: at, endedAt: at, status, durationMs: 0, output }],
  };
}

const planned = (r: RequestRecord, id: string) => r.workflow?.nodes.find((n) => n.id === id);

/** Estados de nodo tras una decisión humana (mismo backend de aprobaciones; sin estados solo visuales). */
export function nodesAfterDecision(r: RequestRecord, decision: 'approve' | 'reject' | 'changes', by: Actor, comment?: string): Record<string, NodeState> {
  if (!r.workflow || r.workflow.legacy) return {};
  const who = by.name ?? by.email;
  const out: Record<string, NodeState> = {};
  if (decision === 'approve') {
    out['human-approval'] = finish(node(r, 'human-approval'), 'COMPLETED', `Aprobado por ${who} (MFA).`, { decision: 'aprobado', by, comment }, r.iteration);
    out.release = { ...node(r, 'release'), status: 'QUEUED', lastEvent: 'En cola para el release.' };
    out.rework = { ...node(r, 'rework'), status: 'SKIPPED', lastEvent: 'No aplica: se aprobó.' };
    return out;
  }
  if (r.status === 'awaiting_approval') {
    out['human-approval'] = finish(node(r, 'human-approval'), 'COMPLETED', decision === 'reject' ? `Rechazado por ${who}.` : `${who} pidió ajustes.`, { decision: decision === 'reject' ? 'rechazado' : 'ajustes', by, comment }, r.iteration);
  }
  out.rework = finish(node(r, 'rework'), 'COMPLETED', decision === 'reject' ? 'Solicitud cerrada.' : 'Nueva iteración solicitada.', { comment }, r.iteration);
  if (decision === 'reject') {
    for (const id of ['release', 'prod-verification']) if (planned(r, id)) out[id] = { ...node(r, id), status: 'SKIPPED', lastEvent: 'No aplica: rechazado.' };
    out.result = finish(node(r, 'result'), 'COMPLETED', 'Rechazado: no se desplegó.', { result: 'rechazado' }, r.iteration);
    return out;
  }
  // Ajustes / reintento: los nodos de ejecución vuelven a PENDING conservando sus intentos anteriores.
  for (const id of EXECUTION_NODES) {
    const p = planned(r, id);
    if (!p || p.planned === 'skip' || id === 'rework') continue;
    out[id] = { ...node(r, id), ...(out[id] ?? {}), status: 'PENDING', lastEvent: `Pendiente (iteración ${r.iteration + 1}).`, endedAt: null };
  }
  out['human-approval'] = { ...(out['human-approval'] ?? node(r, 'human-approval')), status: 'PENDING' };
  return out;
}

/**
 * Solicitudes anteriores al plan (versión 0): reconstruye el pipeline FIJO que realmente ejecutaron,
 * con estados deducidos de lo persistido. Se marca como legacy en la interfaz.
 */
export function legacyWorkflow(r: RequestRecord): { workflow: Workflow; nodeState: Record<string, NodeState> } {
  const steps: [string, string, string, string[]][] = [
    ['request', 'Solicitud', 'input', []],
    ['prod-preflight', 'Guardián PROD', 'gate', ['queued', 'preparing', 'cloning', 'installing', 'preflight']],
    ['frontend-integration-agent', 'Desarrollador', 'agent', ['developing']],
    ['qa-agent', 'QA', 'agent', ['testing']],
    ['preview', 'Vista previa', 'step', ['preview', 'screenshots']],
    ['pull-request', 'Pull request', 'step', ['pr']],
    ['human-approval', 'Aprobación humana', 'approval', ['awaiting_approval', 'approved']],
    ['release', 'Release PROD', 'step', ['deploy_checks', 'deploying']],
    ['prod-verification', 'Verificación PROD', 'gate', ['verifying']],
    ['result', 'Resultado final', 'output', ['deployed']],
  ];
  const stage = r.stage ?? r.status;
  let reached = steps.findIndex(([, , , stages]) => stages.includes(stage));
  if (r.status === 'deployed') reached = steps.length - 1;
  if (r.status === 'no_changes') reached = 2;
  const stopped = ['failed', 'blocked', 'rolled_back', 'rejected', 'no_changes'].includes(r.status);
  const nodeState: Record<string, NodeState> = {};
  steps.forEach(([id], i) => {
    let status: NodeStatus = 'PENDING';
    if (i === 0 || i < reached || (r.status === 'deployed' && i <= reached)) status = 'COMPLETED';
    else if (i === reached) status = stopped ? (r.status === 'blocked' ? 'BLOCKED' : r.status === 'no_changes' ? 'COMPLETED' : 'FAILED') : r.status === 'awaiting_approval' ? 'WAITING_APPROVAL' : 'RUNNING';
    else if (stopped) status = 'SKIPPED';
    nodeState[id] = { status, attempts: [], lastEvent: i === reached ? r.error?.message ?? undefined : undefined };
  });
  return {
    workflow: {
      version: 0,
      legacy: true,
      profile: 'PIPELINE_FIJO_V0',
      rationale: ['Solicitud creada antes del plan dinámico: ejecutó el pipeline fijo de la versión 0.'],
      nodes: steps.map(([id, label, kind]) => ({ id, agentId: null, label, role: '', kind, planned: 'run' })),
      edges: steps.slice(1).map(([id], i) => ({ id: `${steps[i][0]}->${id}`, source: steps[i][0], target: id })),
    },
    nodeState,
  };
}

const FORBIDDEN_OVERRIDES =
  /(sin aprobaci[oó]n|omit[ea]r? (la )?aprobaci|ignora(r)? (las )?(reglas|pol[ií]ticas)|desplega(r)? directamente|saltar(se)? (el )?(bloqueo|gate)|deshabilitar|desactivar (la )?seguridad|incluir (la )?(clave|contrase|secret|token))/i;

/** Igual que runner/lib/framework.mjs#validateRules: las reglas configurables no pueden desactivar políticas. */
export function validateRules(list: unknown): string | null {
  if (!Array.isArray(list)) return 'Las reglas deben ser una lista.';
  if (list.length > 20) return 'Máximo 20 reglas por agente.';
  for (const r of list) {
    if (typeof r !== 'string' || !r.trim()) return 'Hay una regla vacía.';
    if (r.length > 300) return 'Cada regla puede tener hasta 300 caracteres.';
    if (FORBIDDEN_OVERRIDES.test(r)) return `La regla «${r.slice(0, 60)}» intenta desactivar una política obligatoria.`;
  }
  return null;
}

// ---------------------------------------------------------------- exportación

export interface ExportBundle {
  generatedAt: string;
  request: Record<string, unknown>;
  workflow: Workflow | null;
  nodes: { id: string; label: string; status: string; planned: string; reason?: string | null; attempts: unknown[]; io: unknown }[];
  rules: unknown;
  events: RequestEvent[];
  screenshots: { label: string; dataUri?: string; key: string }[];
}

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const list = (items?: unknown[]) => (items?.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="muted">—</p>');

// El HTML se arma desde el JSON persistido (estructura abierta por diseño).
/* eslint-disable @typescript-eslint/no-explicit-any */
export function renderExportHtml(b: ExportBundle): string {
  const r = b.request as Record<string, any>;
  const rep = (r.report ?? {}) as Record<string, string[] | string>;
  const dep = r.deployment as Record<string, any> | null;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Evidencias NADF · ${esc(r.title ?? r.requestId)}</title>
<style>
:root{--bg:#fff;--fg:#1b1530;--muted:#6b6580;--line:#e4e0ee;--ok:#11823b;--bad:#b42318;--warn:#a15c00;--acc:#3b5bdb}
body{font:14px/1.55 Inter,system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:1040px;margin:32px auto;padding:0 20px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.muted{color:var(--muted)}.chip{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:12px}
.COMPLETED{color:var(--ok)}.FAILED,.BLOCKED{color:var(--bad)}.SKIPPED{color:var(--muted)}.WAITING_APPROVAL{color:var(--warn)}
pre{white-space:pre-wrap;background:#f6f4fb;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;max-height:420px;overflow:auto}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}.shots img{width:100%;border:1px solid var(--line);border-radius:8px}
@media print{pre{max-height:none}h2{break-after:avoid}}
</style></head><body>
<p class="muted">NADF · Novus Intelligence — Evidencias de ejecución · generado ${esc(b.generatedAt)}</p>
<h1>${esc(r.title ?? r.prompt?.slice(0, 90))}</h1>
<p><span class="chip">${esc(r.status)}</span> <span class="chip">Perfil ${esc(b.workflow?.profile ?? '—')}</span> <span class="chip">Iteración ${esc(r.iteration)}</span> <span class="chip">${esc(r.appId)}</span></p>
<h2>Solicitud original</h2><pre>${esc(r.prompt)}</pre>
<p class="muted">Pedida por ${esc(r.createdBy?.name ?? r.createdBy?.email)} el ${esc(r.createdAt)}</p>
${r.feedback?.length ? `<h2>Comentarios y ajustes</h2>${list(r.feedback.map((f: any) => `${f.by?.name ?? f.by?.email}: ${f.text}`))}` : ''}
<h2>Workflow ejecutado</h2>
<p>${esc((b.workflow?.rationale ?? []).join(' '))}</p>
<table><tr><th>Nodo</th><th>Estado</th><th>Plan</th><th>Intentos</th><th>Detalle</th></tr>
${b.nodes.map((n) => `<tr><td>${esc(n.label)}<div class="muted">${esc(n.id)}</div></td><td class="${esc(n.status)}">${esc(n.status)}</td><td>${esc(n.planned)}</td><td>${n.attempts.length}</td><td>${esc(n.reason ?? '')}</td></tr>`).join('')}
</table>
<h2>Resultado del agente</h2><p>${esc(rep.resumen)}</p>
<h3>Hecho</h3>${list(rep.hecho as string[])}<h3>No hecho</h3>${list(rep.no_hecho as string[])}<h3>Limitaciones</h3>${list(rep.limitaciones as string[])}<h3>Preguntas</h3>${list(rep.preguntas as string[])}
<h2>Archivos modificados</h2>${list(r.changedFiles ?? (rep.archivos as string[]))}
${r.diffStat ? `<pre>${esc(r.diffStat)}</pre>` : ''}
<p>Pull request: ${r.prUrl ? `<a href="${esc(r.prUrl)}">${esc(r.prUrl)}</a>` : '—'} · Rama: ${esc(r.branch ?? '—')} · Commit: ${esc(r.headSha ?? '—')}</p>
<h2>Pruebas</h2><table><tr><th>Prueba</th><th>Resultado</th><th>Detalle</th></tr>${(r.tests ?? []).map((t: any) => `<tr><td>${esc(t.name)}</td><td>${esc(t.status)}</td><td>${esc(t.detail)}</td></tr>`).join('')}</table>
<h2>Capturas</h2><div class="shots">${b.screenshots.map((s) => `<figure>${s.dataUri ? `<img src="${s.dataUri}" alt="${esc(s.label)}">` : `<p class="muted">(${esc(s.key)})</p>`}<figcaption class="muted">${esc(s.label)}</figcaption></figure>`).join('')}</div>
<h2>Aprobaciones</h2>
<p>Plan (gate plan): ${r.planApproval ? `${esc(r.planApproval.by?.name ?? r.planApproval.by?.email)} · ${esc(r.planApproval.at)}` : '—'}</p>
<p>Despliegue (gate deploy-prod): ${r.decision ? `${esc(r.decision.decision)} por ${esc(r.decision.by?.name ?? r.decision.by?.email)} · ${esc(r.decision.at)}${r.decision.comment ? ` — ${esc(r.decision.comment)}` : ''}` : '—'}</p>
<h2>Despliegue</h2>${dep ? `<table>${Object.entries({ Entorno: dep.environment ?? 'PROD', URL: dep.url, Rama: dep.branch, Commit: dep.commit, 'Commit de merge': dep.mergeCommit, Versión: dep.version, Pipeline: dep.buildId, Inicio: dep.startedAt, Fin: dep.finishedAt, Aprobador: dep.approvedBy?.name ?? dep.approvedBy?.email, Verificado: dep.verified ? 'sí' : 'no' }).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v ?? '—')}</td></tr>`).join('')}</table>${(dep.smoke ?? []).length ? `<h3>Verificación</h3>${list(dep.smoke.map((s: any) => `${s.status} · ${s.name}`))}` : ''}` : '<p class="muted">No desplegado.</p>'}
${r.rollback ? `<h2>Rollback</h2><p>Solicitado por ${esc(r.rollback.requestedBy?.name ?? r.rollback.requestedBy?.email)} (${esc(r.rollback.requestedAt)}): ${esc(r.rollback.reason)}</p><p>Aprobado por ${esc(r.rollback.approvedBy?.name ?? r.rollback.approvedBy?.email ?? '—')} · terminado ${esc(r.rollback.finishedAt ?? '—')} · PR de reversión ${esc(r.rollback.revertPrUrl ?? '—')}</p>` : ''}
<h2>Reglas aplicadas</h2><pre>${esc(JSON.stringify(b.rules, null, 2))}</pre>
<h2>Prompts y entradas/salidas por agente</h2>${b.nodes.filter((n) => n.io).map((n) => `<h3>${esc(n.label)}</h3><pre>${esc(JSON.stringify(n.io, null, 2))}</pre>`).join('')}
<h2>Logs (saneados)</h2><pre>${esc(b.events.map((e) => `${e.at} [${e.nodeId ?? '-'}] ${e.kind}: ${e.text}`).join('\n'))}</pre>
<h2>Resultado final</h2><p><strong>${esc(r.status)}</strong>${r.error ? ` — ${esc(r.error.message)}` : ''}</p>
</body></html>`;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/** Limpia secretos residuales de cualquier texto exportado. */
export function sanitize<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value)
      .replace(/sk-ant-[\w-]+/g, 'sk-ant-***')
      .replace(/gh[pousr]_[\w]+/g, 'gh*_***')
      .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA***')
      .replace(/("(?:token|password|secret|privateKey|private_key)"\s*:\s*)"[^"]*"/gi, '$1"***"'),
  );
}
