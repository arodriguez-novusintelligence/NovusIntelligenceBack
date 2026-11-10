// Catálogo de agentes para el portal: definición real del framework + explicación de qué hace y cómo funciona
// en el ejecutor del portal. Se genera al empaquetar el runner (scripts/portal/upload-runner.mjs).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORM_POLICIES, VENDOR, agentDefinition, approvalModel, manifest } from './framework.mjs';

/** Pasos del flujo base: siempre presentes (no se pueden quitar de un flujo). */
export const BASE_NODES = ['request', 'requirement-classification-agent', 'qa-agent', 'result'];
/** Controles de la plataforma: siempre presentes por seguridad (no se pueden quitar). */
export const PLATFORM_NODES = ['complexity-router', 'orchestrator', 'prod-preflight', 'frontend-integration-agent', 'preview', 'security-gate', 'pull-request', 'human-approval', 'rework', 'release', 'prod-verification'];
/** Agentes opcionales que el ejecutor del portal sabe ejecutar y un flujo puede incluir. */
export const OPTIONAL_AGENTS = ['planner-agent', 'architect-agent', 'security-agent', 'reviewer-agent'];

export const EXPLAIN = {
  request: { name: 'Solicitud', what: 'Es el pedido del funcional en lenguaje natural.', how: 'Se registra con su autor y fecha; todo el flujo parte de aquí.', stage: 'Entrada' },
  'requirement-classification-agent': { name: 'Analista', what: 'Entiende el pedido: tipo de cambio, capas afectadas, riesgo, criterios de aceptación y preguntas si algo es ambiguo.', how: 'Claude con el prompt del agente del framework y salida estructurada; sus señales alimentan al Complexity Router.', stage: 'Planificación' },
  'complexity-router': { name: 'Complexity Router', what: 'Elige el perfil mínimo suficiente (de cambio visual trivial a flujo completo, o bloqueado).', how: 'Función decideComplexity del framework, determinista; ante duda escala a FULL.', stage: 'Planificación' },
  orchestrator: { name: 'Orquestador', what: 'Arma el plan: qué agentes corren, cuáles se omiten y por qué.', how: 'Aplica el flujo elegido o los presets del proyecto; agrega los controles obligatorios de la plataforma.', stage: 'Planificación' },
  'prod-preflight': { name: 'Guardián PROD', what: 'Verifica que PROD coincide con main antes de trabajar, para no revertir cambios de otros.', how: 'Compila main y compara los textos del bundle con los de PROD usando el rol de lectura de la empresa.', stage: 'Control' },
  'planner-agent': { name: 'Planificador', what: 'Descompone el cambio en pasos y archivos candidatos.', how: 'Claude (modelo de análisis) con el prompt del planner, el listado de archivos y los criterios del Analista. Corre solo en funcionalidades nuevas grandes y cambios arquitectónicos: en lo demás, el Desarrollador planifica por sí mismo.', stage: 'Planificación' },
  'architect-agent': { name: 'Arquitecto', what: 'Propone el diseño técnico y exige ADR.', how: 'Claude (modelo de análisis). Corre solo en cambios arquitectónicos (nuevas dependencias o servicios, contratos entre capas, modelo de datos). Los evolutivos no lo necesitan ni requieren ADR.', stage: 'Planificación' },
  'frontend-integration-agent': { name: 'Desarrollador', what: 'Implementa el cambio en el repositorio real.', how: 'Claude Code headless en un contenedor aislado, con herramientas limitadas (leer, editar, build, lint); no hace commit ni despliega.', stage: 'Desarrollo' },
  preview: { name: 'Vista previa', what: 'Publica una versión privada con los cambios para revisarla.', how: 'Compila y sube solo archivos nuevos con hash; el index público de PROD no cambia.', stage: 'Desarrollo' },
  'qa-agent': { name: 'QA', what: 'Prueba el cambio: compilación, lint y capturas antes/después en escritorio y móvil.', how: 'Ejecuta los scripts del repo y Playwright con el usuario admin de la app.', stage: 'Validación' },
  'security-gate': { name: 'Guardas de seguridad', what: 'Aplica políticas obligatorias: revierte archivos protegidos y bloquea si hay secretos en el cambio.', how: 'Revisión determinista del diff; siempre corre.', stage: 'Validación' },
  'security-agent': { name: 'Seguridad', what: 'Revisa el diff buscando riesgos: secretos, autenticación, pagos, accesos no pedidos.', how: 'Claude (modelo de análisis). Corre solo si el Analista marca ámbito crítico (autenticación, pagos, datos personales, secretos, permisos o migración).', stage: 'Validación' },
  'reviewer-agent': { name: 'Revisor', what: 'Comprueba que el cambio cumple lo pedido y no rompe funcionalidades.', how: 'Claude (modelo de análisis) sobre el diff. Corre en evolutivos, funcionalidades nuevas y cambios arquitectónicos. Bloquea solo por defectos reales; lo no verificable son observaciones.', stage: 'Revisión' },
  'pull-request': { name: 'Pull request', what: 'Guarda el cambio en una rama y abre el PR en el repo de la empresa.', how: 'Conector GitHub App de NADF con permisos solo sobre los repos instalados.', stage: 'Entrega' },
  'human-approval': { name: 'Aprobación humana', what: 'Una persona aprueba, pide ajustes o rechaza el despliegue a PROD.', how: 'Gate deploy-prod del modelo de aprobación; aprobar exige verificación en dos pasos.', stage: 'Decisión' },
  rework: { name: 'Revisión', what: 'Recoge el rechazo o los ajustes pedidos.', how: 'Ajustes = nueva iteración conservando los intentos anteriores.', stage: 'Decisión' },
  release: { name: 'Release PROD', what: 'Publica en PROD exactamente lo revisado.', how: 'Verifica que PROD y main no cambiaron, respalda, publica e invalida el CDN con el rol de despliegue de la empresa.', stage: 'Producción' },
  'prod-verification': { name: 'Verificación PROD', what: 'Prueba PROD después del release y vuelve atrás si falla.', how: 'Playwright con el usuario admin sobre las rutas del cambio.', stage: 'Producción' },
  result: { name: 'Resultado final', what: 'Consolida el resultado de toda la ejecución.', how: 'Estado final, evidencias y exportación.', stage: 'Salida' },
};

export function buildCatalog() {
  const agents = readdirSync(join(VENDOR, 'framework/.nadf/global/skill-registry'))
    .filter((f) => f.endsWith('.yml'))
    .map((f) => f.replace(/\.yml$/, ''));
  const executable = new Set([...Object.keys(EXPLAIN), 'devops-agent']);
  const entries = agents.map((id) => {
    const def = agentDefinition(id);
    const ex = EXPLAIN[id];
    return {
      id,
      name: ex?.name ?? def?.name ?? id,
      registryName: def?.name ?? id,
      layer: def?.layer ?? null,
      pattern: def?.pattern ?? null,
      description: def?.description ?? '',
      what: ex?.what ?? def?.description ?? '',
      how: ex?.how ?? `Definido en el framework (${def?.pattern ?? 'patrón'}); aún no lo ejecuta el portal.`,
      stage: ex?.stage ?? def?.layer ?? null,
      executable: executable.has(id),
      kind: BASE_NODES.includes(id) ? 'base' : PLATFORM_NODES.includes(id) ? 'platform' : OPTIONAL_AGENTS.includes(id) ? 'optional' : 'framework',
      responsibilities: def?.responsibilities ?? [],
      forbiddenActions: def?.forbiddenActions ?? [],
      allowedTools: def?.allowedTools ?? [],
      mcpServers: def?.mcpServers ?? [],
      qualityGates: def?.qualityGates ?? [],
      definitionPath: def?.definitionPath ?? null,
      prompt: def?.prompt ?? '',
    };
  });
  // Pasos de plataforma que no son agentes del registro.
  for (const id of Object.keys(EXPLAIN)) {
    if (entries.some((e) => e.id === id)) continue;
    const ex = EXPLAIN[id];
    entries.push({ id, name: ex.name, registryName: null, layer: 'Plataforma NADF', pattern: null, description: ex.what, what: ex.what, how: ex.how, stage: ex.stage, executable: true, kind: BASE_NODES.includes(id) ? 'base' : 'platform', responsibilities: [], forbiddenActions: [], allowedTools: [], mcpServers: [], qualityGates: [], definitionPath: null, prompt: '' });
  }
  const am = approvalModel();
  return { framework: manifest(), baseNodes: BASE_NODES, platformNodes: PLATFORM_NODES, optionalAgents: OPTIONAL_AGENTS, agents: entries, policies: PLATFORM_POLICIES, approvalModel: { policy: am.policy, gates: am.gates ?? [], invariants: am.invariants ?? [] } };
}
