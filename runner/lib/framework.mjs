// Lee las definiciones REALES del framework NADF empaquetadas en vendor/ y arma el plan de ejecución
// a partir de la decisión del enrutador de complejidad (decideComplexity) y los presets del proyecto.
// No inventa agentes: cada nodo corresponde a un paso que el ejecutor realmente corre (o que omite, con motivo).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const VENDOR = fileURLToPath(new URL('../vendor/', import.meta.url));
const FW = join(VENDOR, 'framework');

const readYaml = (rel) => parse(readFileSync(join(FW, rel), 'utf8'));
const readText = (rel) => (existsSync(join(FW, rel)) ? readFileSync(join(FW, rel), 'utf8') : '');

export function manifest() {
  try {
    return JSON.parse(readFileSync(join(VENDOR, 'manifest.json'), 'utf8'));
  } catch {
    return { repo: 'NovusAIDevelopmentFramework', sha: 'desconocido' };
  }
}

/** Definición declarativa de un agente (skill-registry + .claude/agents). */
export function agentDefinition(agentId) {
  const rel = `.nadf/global/skill-registry/${agentId}.yml`;
  if (!existsSync(join(FW, rel))) return null;
  const a = readYaml(rel).agent ?? {};
  return {
    id: agentId,
    name: a.name ?? agentId,
    pattern: a.pattern ?? null,
    layer: a.layer ?? null,
    description: a.description ?? '',
    responsibilities: a.responsibilities ?? [],
    forbiddenActions: a.forbidden_actions ?? [],
    allowedTools: a.allowed_tools ?? [],
    mcpServers: a.mcp_servers ?? [],
    qualityGates: a.quality_gates ?? [],
    definitionPath: a.definition ?? `.claude/agents/${agentId}.md`,
    prompt: readText(a.definition ?? `.claude/agents/${agentId}.md`).replace(/<!--[\s\S]*?-->/g, '').trim(),
  };
}

export function profileCatalog() {
  return readYaml('.nadf/global/complexity-routing/execution-profiles.yml').profiles ?? {};
}

export function projectSelection(projectId) {
  const rel = `.nadf/projects/${projectId}/agent-selection.yml`;
  return existsSync(join(FW, rel)) ? readYaml(rel).presets ?? {} : {};
}

export function projectContext(projectId) {
  const rel = `.nadf/projects/${projectId}/project-context.yml`;
  return existsSync(join(FW, rel)) ? readYaml(rel) : {};
}

/** Política de agentes por naturaleza del cambio (.nadf/global/complexity-routing/agent-policy.yml). */
export function agentPolicy() {
  const rel = '.nadf/global/complexity-routing/agent-policy.yml';
  return existsSync(join(FW, rel)) ? readYaml(rel) : null;
}

const NATURALEZAS = ['ajuste_visual', 'evolutivo', 'nueva_funcionalidad', 'cambio_arquitectonico'];
const NATURALEZA_LABEL = { ajuste_visual: 'ajuste visual', evolutivo: 'evolutivo', nueva_funcionalidad: 'nueva funcionalidad', cambio_arquitectonico: 'cambio arquitectónico' };

/** Agentes opcionales, modelos y presupuesto según la política y la clasificación del Analista. */
export function policyDecision(signals = {}, policy = agentPolicy()) {
  if (!policy || !NATURALEZAS.includes(signals.naturaleza)) return null;
  const n = signals.naturaleza;
  const entry = policy.agents?.[n] ?? [];
  const list = Array.isArray(entry) ? entry : entry[signals.tamano === 'grande' ? 'grande' : 'pequena'] ?? [];
  const agents = new Set(list);
  if (signals.ambito_critico) for (const a of policy.critical?.add ?? []) agents.add(a);
  return {
    naturaleza: n,
    naturalezaLabel: NATURALEZA_LABEL[n],
    tamano: signals.tamano ?? null,
    critico: Boolean(signals.ambito_critico),
    motivoCritico: signals.motivo_critico || null,
    agents: [...agents],
    adrRequired: (policy.adr?.required_when ?? []).includes(n),
    models: policy.models ?? {},
    budgetUsd: policy.development_budget_usd?.[n] ?? null,
    limits: policy.context_limits ?? {},
    reviewer: policy.reviewer ?? {},
    stopCrossLayer: policy.cross_layer?.stop_at_plan !== false,
  };
}

export function approvalModel() {
  return readYaml('enterprise-governance/human-approval-model.yml');
}

const SHORT_TO_AGENT = {
  planner: 'planner-agent',
  architect: 'architect-agent',
  frontend: 'frontend-integration-agent',
  backend: 'backend-agent',
  qa: 'qa-agent',
  security: 'security-agent',
  reviewer: 'reviewer-agent',
};

/** Políticas de la plataforma que aplican siempre (no editables desde la interfaz). */
export const PLATFORM_POLICIES = [
  'Nada se despliega a PROD sin aprobación humana con verificación en dos pasos (gate deploy-prod).',
  'Antes de trabajar y antes de desplegar, PROD debe coincidir con main; si no, se bloquea.',
  'No se modifican .env*, infrastructure/, .github/, scripts de despliegue ni package-lock.json (se revierten).',
  'No se introducen secretos ni credenciales en código o logs.',
  'El agente no hace commit, push ni despliegues: lo hace la plataforma después de la revisión.',
  'Las reglas de una ejecución quedan congeladas al iniciarla.',
];

/** Reglas configurables por defecto (editables antes de ejecutar; quedan versionadas). */
export const DEFAULT_CONFIGURABLE = {
  'requirement-classification-agent': [
    'Si falta información para implementar con seguridad, marcar la solicitud como ambigua y formular preguntas concretas.',
  ],
  'planner-agent': ['El plan debe tener como máximo 6 pasos y mencionar los archivos candidatos.'],
  'architect-agent': ['Proponer el diseño más simple compatible con la arquitectura existente; sin nuevas dependencias.'],
  'frontend-integration-agent': [
    'Implementar solo lo pedido, con el cambio más pequeño y seguro; sin refactors ni renombres.',
    'Reutilizar componentes y estilos existentes.',
    'Textos en español correcto (con tildes); revisar vista móvil y escritorio.',
    'Leer CLAUDE.md, ReglasAgente/ y reglasActuacion/ antes de editar.',
    'Ejecutar npm run build:prod y corregir errores antes de terminar.',
  ],
  'qa-agent': ['Tomar capturas antes y después en escritorio y una en móvil.', 'Revisar como máximo 4 rutas.'],
  'security-agent': ['Revisar el diff en busca de secretos, cambios de autenticación o pagos y accesos a datos no pedidos.'],
  'reviewer-agent': ['Revisar que el diff cumpla los criterios de aceptación y no toque funcionalidades ajenas.'],
};

/** Pasos de plataforma que no son agentes del registro pero sí se ejecutan. */
const PLATFORM_NODES = {
  request: { label: 'Solicitud', role: 'Pedido del funcional en lenguaje natural', kind: 'input' },
  'complexity-router': { label: 'Complexity Router', role: 'decideComplexity del framework: elige el perfil mínimo suficiente', kind: 'router' },
  orchestrator: { label: 'Orquestador', role: 'Arma el plan con los presets del proyecto y el perfil elegido', kind: 'orchestrator' },
  'prod-preflight': { label: 'Guardián PROD', role: 'Verifica que PROD coincide con main antes de tocar nada', kind: 'gate', agentId: 'devops-agent' },
  preview: { label: 'Vista previa', role: 'Publica una versión privada en PROD sin cambiar el index público', kind: 'step', agentId: 'devops-agent' },
  'security-gate': { label: 'Guardas de seguridad', role: 'Políticas obligatorias sobre el diff: rutas protegidas y secretos', kind: 'gate' },
  'pull-request': { label: 'Pull request', role: 'Rama nadf/req-* y PR en el repo real (conector GitHub App)', kind: 'step', agentId: 'devops-agent' },
  'human-approval': { label: 'Aprobación humana', role: 'Gate deploy-prod del modelo de aprobación (deny by default)', kind: 'approval' },
  rework: { label: 'Revisión', role: 'Rechazo o ajustes: nueva iteración o cierre', kind: 'outcome' },
  release: { label: 'Release PROD', role: 'Respaldo, publicación del build revisado e invalidación del CDN', kind: 'step', agentId: 'devops-agent' },
  'prod-verification': { label: 'Verificación PROD', role: 'Prueba de humo en PROD con el usuario admin; rollback si falla', kind: 'gate', agentId: 'qa-agent' },
  result: { label: 'Resultado final', role: 'Estado final de la ejecución', kind: 'output' },
};

const AGENT_LABEL = {
  'requirement-classification-agent': 'Analista',
  'planner-agent': 'Planificador',
  'architect-agent': 'Arquitecto',
  'frontend-integration-agent': 'Desarrollador',
  'backend-agent': 'Backend',
  'qa-agent': 'QA',
  'security-agent': 'Seguridad',
  'reviewer-agent': 'Revisor',
};

const LLM_AGENTS = new Set(['requirement-classification-agent', 'planner-agent', 'architect-agent', 'security-agent', 'reviewer-agent']);

/**
 * Plan de ejecución.
 * @param decision RoutingDecision de decideComplexity
 * @param opts { projectId, appLayers: ['frontend'], model }
 */
export function buildPlan(decision, { projectId, appLayers = ['frontend'], model, flow = null, signals = null, policy = undefined }) {
  const presets = projectSelection(projectId);
  // Política por naturaleza (si el Analista la entregó y no hay un flujo explícito de la empresa).
  const pol = flow ? null : policyDecision(signals ?? {}, policy === undefined ? agentPolicy() : policy);
  // Flujo personalizado de la empresa: decide los agentes opcionales; los pasos base y los controles de la plataforma se mantienen.
  const OPTIONALS = ['planner-agent', 'architect-agent', 'security-agent', 'reviewer-agent'];
  const enabledShort = flow || pol ? [] : presets[decision.profile]?.enabled ?? [];
  const enabled = flow
    ? new Set(['frontend-integration-agent', 'qa-agent', ...(flow.agents ?? []).filter((a) => OPTIONALS.includes(a))])
    : pol
      ? new Set(['frontend-integration-agent', 'qa-agent', ...pol.agents])
      : new Set(enabledShort.map((s) => SHORT_TO_AGENT[s]).filter(Boolean));
  const fullSet = flow || pol ? new Set(OPTIONALS) : new Set((presets.FULL?.enabled ?? []).map((s) => SHORT_TO_AGENT[s]).filter(Boolean));
  const catalog = profileCatalog();
  const profileInfo = catalog[decision.profile] ?? {};
  const blocked = decision.profile === 'BLOCKED';
  const needsBackend = (enabled.has('backend-agent') && !enabled.has('frontend-integration-agent')) || Boolean(pol?.stopCrossLayer && signals?.backendRequired === true);
  const unsupported = needsBackend && !appLayers.includes('backend');

  const nodes = [];
  const edges = [];
  const add = (id, extra = {}) => {
    const p = PLATFORM_NODES[id];
    const agentId = extra.agentId ?? p?.agentId ?? (p ? null : id);
    const def = agentId ? agentDefinition(agentId) : null;
    nodes.push({
      id,
      agentId,
      label: extra.label ?? p?.label ?? AGENT_LABEL[id] ?? def?.name ?? id,
      role: extra.role ?? p?.role ?? def?.description ?? '',
      kind: extra.kind ?? p?.kind ?? 'agent',
      layer: def?.layer ?? null,
      pattern: def?.pattern ?? null,
      model: LLM_AGENTS.has(id) ? pol?.models?.analysis ?? model : id === 'frontend-integration-agent' ? `${pol?.models?.development ?? model} (Claude Code${pol?.budgetUsd ? `, tope ${pol.budgetUsd} USD` : ''})` : null,
      planned: extra.planned ?? 'run',
      reason: extra.reason ?? null,
      definition: def ? { path: def.definitionPath, responsibilities: def.responsibilities, allowedTools: def.allowedTools, mcpServers: def.mcpServers, qualityGates: def.qualityGates } : null,
    });
  };
  const link = (from, to, label) => edges.push({ id: `${from}->${to}`, source: from, target: to, label: label ?? null });
  const choose = (agentId, why) => {
    if (blocked || unsupported) return { planned: 'skip', reason: blocked ? 'El perfil BLOCKED no ejecuta agentes.' : 'La app conectada no incluye backend.' };
    if (enabled.has(agentId)) {
      if (why) return { planned: 'run', reason: why };
      if (flow) return { planned: 'run', reason: `Incluido por el flujo «${flow.name}».` };
      if (pol) return { planned: 'run', reason: agentId === 'security-agent' ? `Incluido: toca un ámbito crítico${pol.motivoCritico ? ` (${pol.motivoCritico})` : ''}.` : `Incluido por la política para un cambio «${pol.naturalezaLabel}»${pol.tamano ? ` (${pol.tamano})` : ''}.` };
      return { planned: 'run', reason: `Incluido en el perfil ${decision.profile} (preset del proyecto).` };
    }
    if (flow) return { planned: 'skip', reason: `Omitido: el flujo «${flow.name}» no lo incluye.` };
    if (pol) {
      if (agentId === 'security-agent') return { planned: 'skip', reason: 'Omitido: el cambio no toca autenticación, pagos, datos personales, secretos ni permisos.' };
      if (agentId === 'architect-agent') return { planned: 'skip', reason: `Omitido: un cambio «${pol.naturalezaLabel}» no requiere diseño de arquitectura ni ADR.` };
      return { planned: 'skip', reason: `Omitido: la política no lo requiere para un cambio «${pol.naturalezaLabel}» (ahorro de tokens).` };
    }
    const excluded = profileInfo.excluded_domains?.length ? ` (excluye ${profileInfo.excluded_domains.join(', ')})` : '';
    return { planned: 'skip', reason: `Omitido: el perfil ${decision.profile}${excluded} no lo requiere.` };
  };

  add('request', { planned: 'done' });
  add('requirement-classification-agent', { planned: 'done', reason: 'Clasifica el pedido y entrega las señales al router.' });
  add('complexity-router', { planned: 'done', reason: `Perfil ${decision.profile} · confianza ${decision.confidence}` });
  add('orchestrator', { planned: 'done', reason: flow ? `Flujo de la empresa «${flow.name}» (v${flow.version ?? 1})` : pol ? `Política por naturaleza: ${pol.naturalezaLabel}${pol.critico ? ' · crítico' : ''}` : `Preset ${projectId}: ${enabledShort.join(', ') || 'ninguno'}` });
  link('request', 'requirement-classification-agent');
  link('requirement-classification-agent', 'complexity-router');
  link('complexity-router', 'orchestrator');

  const gated = blocked || unsupported;
  add('prod-preflight', gated ? { planned: 'skip', reason: 'No se ejecuta: el plan está bloqueado.' } : {});
  link('orchestrator', 'prod-preflight');

  let prev = 'prod-preflight';
  for (const agentId of ['planner-agent', 'architect-agent']) {
    if (!fullSet.has(agentId) && !enabled.has(agentId)) continue;
    add(agentId, choose(agentId));
    link(prev, agentId);
    prev = agentId;
  }
  add('frontend-integration-agent', choose('frontend-integration-agent', 'Implementa el cambio con Claude Code en el repo real.'));
  link(prev, 'frontend-integration-agent');
  if (enabled.has('backend-agent') || fullSet.has('backend-agent')) {
    add('backend-agent', enabled.has('backend-agent') && !appLayers.includes('backend')
      ? { planned: 'skip', reason: 'La app conectada (solo frontend) no expone backend a NADF; no se modifica.' }
      : choose('backend-agent'));
    link(prev, 'backend-agent');
  }

  add('preview', gated ? { planned: 'skip', reason: 'No se ejecuta: el plan está bloqueado.' } : {});
  link('frontend-integration-agent', 'preview');

  // Validación en paralelo: QA, guardas obligatorias y, si el perfil lo incluye, el agente de seguridad.
  const parallel = ['qa-agent', 'security-gate'];
  add('qa-agent', gated ? { planned: 'skip', reason: 'No se ejecuta: el plan está bloqueado.' } : { planned: 'run', reason: 'Build, lint, capturas antes/después y prueba de la vista previa.' });
  add('security-gate', gated ? { planned: 'skip', reason: 'No se ejecuta: el plan está bloqueado.' } : { planned: 'run', reason: 'Política obligatoria de la plataforma (siempre corre).' });
  if (enabled.has('security-agent') || fullSet.has('security-agent')) {
    add('security-agent', choose('security-agent'));
    parallel.push('security-agent');
  }
  for (const id of parallel) link('preview', id);

  let join = 'pull-request';
  if (enabled.has('reviewer-agent') || fullSet.has('reviewer-agent')) {
    add('reviewer-agent', choose('reviewer-agent'));
    for (const id of parallel) link(id, 'reviewer-agent');
    link('reviewer-agent', 'pull-request');
  } else {
    for (const id of parallel) link(id, 'pull-request');
  }
  add('pull-request', gated ? { planned: 'skip', reason: 'No se ejecuta: el plan está bloqueado.' } : {});
  add('human-approval', gated ? { planned: 'skip', reason: 'No hay cambio que aprobar.' } : { reason: 'Gate deploy-prod: required (human-approval-model.yml).' });
  link(join, 'human-approval');
  add('rework', { planned: 'conditional', reason: 'Solo si se rechaza o se piden ajustes.' });
  add('release', gated ? { planned: 'skip', reason: 'No se ejecuta: el plan está bloqueado.' } : { planned: 'conditional', reason: 'Solo si se aprueba.' });
  link('human-approval', 'release', 'Aprobar');
  link('human-approval', 'rework', 'Rechazar / ajustes');
  add('prod-verification', gated ? { planned: 'skip', reason: 'No se ejecuta: el plan está bloqueado.' } : { planned: 'conditional', reason: 'Tras el release; rollback automático si falla.' });
  link('release', 'prod-verification');
  add('result', {});
  link('prod-verification', 'result');
  link('rework', 'result');

  return {
    version: 2,
    profile: decision.profile,
    level: decision.level,
    mode: decision.mode,
    confidence: decision.confidence,
    rationale: decision.rationale,
    selectedAgents: decision.selectedAgents,
    excludedDomains: decision.excludedDomains,
    escalationOn: decision.escalationOn,
    flow: flow ? { id: flow.id, name: flow.name, version: flow.version ?? 1 } : null,
    policy: pol ? { naturaleza: pol.naturaleza, tamano: pol.tamano, critico: pol.critico, motivoCritico: pol.motivoCritico, adrRequired: pol.adrRequired, models: pol.models, budgetUsd: pol.budgetUsd, limits: pol.limits, reviewer: pol.reviewer } : null,
    blocked: gated,
    blockReason: blocked
      ? 'El enrutador marcó la solicitud como BLOCKED (información insuficiente o riesgo no evaluable).'
      : unsupported
        ? 'El pedido necesita cambios en el backend y en este pipeline solo está conectada la web. Para no gastar en un cambio que quedaría a medias, se detuvo en el plan. Opciones: pide ajustes con «solo la parte web» (si tiene sentido por sí sola) o conecta el backend al pipeline.'
        : null,
    nodes,
    edges,
  };
}

/** Reglas de cada nodo: obligatorias (no editables) y configurables (editables antes de ejecutar). */
export function rulesFor(plan, projectId, companyAgents = {}) {
  const ctx = projectContext(projectId);
  const projectForbidden = ctx.scope?.forbidden ?? [];
  const out = {};
  for (const node of plan.nodes) {
    const def = node.agentId ? agentDefinition(node.agentId) : null;
    const mandatory = [
      ...PLATFORM_POLICIES.map((text) => ({ text, source: 'Plataforma NADF' })),
      ...(def?.forbiddenActions ?? []).map((a) => ({ text: `Prohibido: ${a}`, source: `skill-registry/${node.agentId}.yml` })),
      ...(node.agentId === 'frontend-integration-agent' ? projectForbidden.map((f) => ({ text: `Prohibido: ${f}`, source: `projects/${projectId}/project-context.yml` })) : []),
    ];
    // Ajustes de la empresa (versionados): se suman a las obligatorias y reemplazan las configurables por defecto.
    const company = companyAgents[node.agentId ?? node.id] ?? companyAgents[node.id];
    if (company) mandatory.push(...(company.mandatory ?? []).map((text) => ({ text, source: `Empresa · v${company.version}` })));
    out[node.id] = {
      mandatory: node.kind === 'input' || node.kind === 'output' ? [] : mandatory,
      configurable: company?.configurable?.length ? company.configurable : DEFAULT_CONFIGURABLE[node.id] ?? [],
    };
  }
  return out;
}

const FORBIDDEN_OVERRIDES = /(sin aprobaci[oó]n|omit[ea]r? (la )?aprobaci|ignora(r)? (las )?(reglas|pol[ií]ticas)|desplega(r)? directamente|saltar(se)? (el )?(bloqueo|gate)|deshabilitar|desactivar (la )?seguridad|incluir (la )?(clave|contrase|secret|token))/i;

/** Valida reglas configurables propuestas por el usuario. */
export function validateRules(list) {
  if (!Array.isArray(list)) return 'Las reglas deben ser una lista.';
  if (list.length > 20) return 'Máximo 20 reglas por agente.';
  for (const r of list) {
    if (typeof r !== 'string' || !r.trim()) return 'Hay una regla vacía.';
    if (r.length > 300) return 'Cada regla puede tener hasta 300 caracteres.';
    if (FORBIDDEN_OVERRIDES.test(r)) return `La regla «${r.slice(0, 60)}» intenta desactivar una política obligatoria.`;
  }
  return null;
}
