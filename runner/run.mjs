// NADF runner — ejecuta el plan REAL de una solicitud (pipeline PROD con revisión humana).
//   plan:     Analista (requirement-classification-agent, Claude) → decideComplexity (framework) → Orquestador
//             (presets del proyecto) → plan persistido; queda "planned" hasta que una persona lo ejecuta (gate plan).
//   develop:  Guardián PROD → [Planificador] → [Arquitecto] → Desarrollador (Claude Code) → Vista previa →
//             QA ‖ Guardas de seguridad ‖ [Seguridad] → [Revisor] → Pull request → espera aprobación (gate deploy-prod).
//   deploy:   (aprobado con MFA) Release PROD → Verificación PROD (rollback automático si falla) → merge → resultado.
//   rollback: (solicitado y aprobado) restaura el artefacto respaldado, verifica y abre el PR de reversión.
// Cada paso es un nodo con estado, intentos, entradas/salidas, herramientas, logs y métricas reales.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { appSession, capture } from './lib/browser.mjs';
import { attachmentBlocks, attachmentsText, loadAttachments } from './lib/attachments.mjs';
import { diffStrings, crawl, localFetcher, previewIndex, uiStrings, entryScripts } from './lib/bundle.mjs';
import { runClaude } from './lib/claude.mjs';
import { agentDefinition, buildPlan, manifest, rulesFor } from './lib/framework.mjs';
import { api, gitAuthArgs, installationToken } from './lib/github.mjs';
import { createLlm, SCHEMAS } from './lib/llm.mjs';
import {
  assumeProd,
  getText,
  invalidate,
  lastInvalidation,
  previewPolicy,
  prodClients,
  put,
  uploadAll,
  uploadPlan,
  uploadPreview,
  waitInvalidation,
} from './lib/prod.mjs';
import { must, run } from './lib/sh.mjs';
import { NODE, createState } from './lib/state.mjs';

const E = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Falta la variable ${name}`);
  return v;
};

const cfg = {
  table: E('PORTAL_TABLE'),
  evidence: E('EVIDENCE_BUCKET'),
  requestId: E('NADF_REQUEST_ID'),
  companyId: E('NADF_COMPANY_ID'),
  phase: E('NADF_PHASE'),
  iteration: Number(E('NADF_ITERATION', '1')),
  app: JSON.parse(E('NADF_APP_JSON')),
  origins: E('PORTAL_ORIGINS', 'http://localhost:5174').split(',').map((s) => s.trim()).filter(Boolean),
  model: E('CLAUDE_MODEL', 'claude-opus-5-5'),
  budgetUsd: Number(E('CLAUDE_BUDGET_USD', '25')),
  dryRun: process.env.NADF_DRY_RUN === '1',
  buildId: process.env.CODEBUILD_BUILD_ID ?? null,
  work: join(process.env.CODEBUILD_SRC_DIR || '/tmp', 'nadf-work'),
  runnerDir: new URL('.', import.meta.url).pathname,
};

const s3 = new S3Client({});
const sm = new SecretsManagerClient({});
const state = createState({ table: cfg.table, companyId: cfg.companyId, requestId: cfg.requestId, iteration: cfg.iteration, buildId: cfg.buildId });
const repoDir = join(cfg.work, 'repo');
const prefix = `requests/${cfg.requestId}/${cfg.iteration}`;
const tests = [];
const fw = manifest();

class Stop extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

async function secret(id, json = false) {
  try {
    const out = await sm.send(new GetSecretValueCommand({ SecretId: id }));
    return json ? JSON.parse(out.SecretString) : out.SecretString;
  } catch (error) {
    throw new Stop('failed', 'CONFIG_MISSING', `Falta la configuración ${id} (${error.name}).`);
  }
}

async function putEvidence(key, body, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: cfg.evidence, Key: key, Body: body, ContentType: contentType }));
  return key;
}

/** Guarda prompt efectivo, entradas, salidas y artefactos de un nodo (sin secretos). */
async function saveIo(nodeId, io) {
  const key = `${prefix}/nodes/${nodeId}.json`;
  const body = JSON.stringify({ nodeId, iteration: cfg.iteration, savedAt: new Date().toISOString(), framework: fw, ...io }, null, 2)
    .replace(/sk-ant-[\w-]+/g, 'sk-ant-***')
    .replace(/ghs_[\w]+/g, 'ghs_***');
  await putEvidence(key, body, 'application/json');
  return key;
}

async function git(args, opts = {}) {
  return must('git', args, { cwd: repoDir, quiet: true, label: `git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''}`, ...opts });
}

function lintCount(out) {
  let problems = 0;
  for (const m of out.matchAll(/✖ (\d+) problems? \((\d+) errors?/g)) problems += Number(m[2]);
  return problems;
}

async function buildProd(label) {
  const res = await run('npm', ['run', 'build:prod'], { cwd: repoDir, quiet: true, timeoutMs: 20 * 60 * 1000 });
  if (res.code !== 0) {
    throw new Stop('failed', 'BUILD_FAILED', `${label}: la compilación de producción falló.`, { tail: res.out.split('\n').slice(-30).join('\n') });
  }
}

async function prodStrings(clients) {
  const index = await getText(clients.s3, cfg.app.prod.bucket, 'index.html');
  if (!index) throw new Stop('failed', 'PROD_UNREADABLE', 'No se pudo leer el index.html de PROD.');
  const files = await crawl(index.body, async (key) => (await getText(clients.s3, cfg.app.prod.bucket, key))?.body ?? null);
  return { index, strings: uiStrings(files), files: files.size };
}

/** Ajustes de agentes de la empresa (AGENTDEF#<agente>, versión vigente). Nunca modifican el NADF global. */
async function companyAgents() {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const out = await doc.send(new QueryCommand({ TableName: cfg.table, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': `COMPANY#${cfg.companyId}`, ':sk': 'AGENTDEF#' } }));
  const map = {};
  for (const item of out.Items ?? []) map[item.agentId] = { version: item.version, instructions: item.instructions ?? '', mandatory: item.mandatory ?? [], configurable: item.configurable ?? [], updatedBy: item.updatedBy, updatedAt: item.updatedAt };
  return map;
}

/** Prompt efectivo: definición del framework + instrucciones de la empresa congeladas en la ejecución. */
function promptOf(req, id) {
  const base = agentDefinition(id)?.prompt ?? '';
  const company = req.agentOverrides?.[id];
  return company?.instructions ? `${base}\n\n## Instrucciones de la empresa (v${company.version})\n${company.instructions}` : base;
}

const planned = (req, id) => req.workflow?.nodes?.find((n) => n.id === id);
const willRun = (req, id) => planned(req, id)?.planned === 'run' || planned(req, id)?.planned === 'conditional';
const rulesOf = (req, id) => req.rules?.nodes?.[id] ?? { mandatory: [], configurable: [] };
const ruleText = (r) => [...r.mandatory.map((m) => `- [obligatoria] ${m.text}`), ...r.configurable.map((c) => `- ${c}`)].join('\n');

/** Ejecuta un nodo: registra inicio/fin reales; si falla, deja el error en el nodo. */
async function step(id, startText, fn) {
  await state.nodeStart(id, startText);
  try {
    const result = (await fn(state.emitter(id))) ?? {};
    await state.nodeEnd(id, result.status ?? NODE.COMPLETED, result.text ?? 'Completado.', result);
    return result;
  } catch (error) {
    const stop = error instanceof Stop ? error : null;
    await state.nodeEnd(id, stop?.status === 'blocked' ? NODE.BLOCKED : NODE.FAILED, stop?.message ?? `Error: ${error.message}`, {
      error: { code: stop?.code ?? error.code ?? 'NODE_ERROR', message: stop?.message ?? error.message },
    });
    throw error;
  }
}

async function skipRest(req, ids, why) {
  for (const id of ids) if (planned(req, id) && state.nodeStatus(id) !== NODE.COMPLETED) await state.nodeSet(id, NODE.SKIPPED, `${planned(req, id).label} — ${why}`);
}

// ---------------------------------------------------------------- plan

async function plan() {
  const req = await state.get();
  if (!(await state.update({ status: 'planning', stage: 'planning', error: null }, ['planning', 'queued_plan']))) return console.log('La solicitud no está para planificar; se ignora.');
  const claudeKey = await secret('/nadf/platform/claude-api-key');
  const llm = createLlm({ apiKey: claudeKey, model: cfg.model });
  state.initNodes({});
  await state.update({ nodeState: {} });

  await state.nodeStart('request', 'Solicitud registrada.');
  await state.nodeEnd('request', NODE.COMPLETED, `Pedido de ${req.createdBy?.name ?? req.createdBy?.email}.`, { output: { prompt: req.prompt } });

  const overrides = await companyAgents();
  const analyst = { ...agentDefinition('requirement-classification-agent'), prompt: promptOf({ agentOverrides: overrides }, 'requirement-classification-agent') };
  const classification = await step('requirement-classification-agent', 'El Analista está clasificando tu solicitud.', async (emit) => {
    const ctx = `Aplicación: ${cfg.app.name} (${cfg.app.repo.owner}/${cfg.app.repo.name}), React + Vite, solo frontend conectado. URL: ${cfg.app.prod.url}.`;
    const system = [
      analyst.prompt,
      '',
      'Contexto de la plataforma NADF (portal):',
      ctx,
      'Responde SOLO con el JSON pedido. "changeTypes" usa estos valores cuando apliquen: visual, content, cosmetic, copy, typography, color, asset, image, banner, spacing, style, static_page, navigation, component, frontend_validation, accessibility, query, read_endpoint, backend_config, business_logic, integration.',
      '"layers" usa: frontend, backend, database, api, cloud. "ambiguous" = true solo si sin preguntar no se puede implementar con seguridad.',
      'Escribe "resumen", "criterios_aceptacion" y "preguntas" en español, para una persona no técnica.',
    ].join('\n');
    const att = await loadAttachments({ s3, bucket: cfg.evidence, list: req.attachments ?? [], dir: join(cfg.work, 'adjuntos') });
    const { blocks, skipped } = await attachmentBlocks(att.files);
    if (att.files.length) await emit('tool', `Leyendo ${att.files.length} adjunto(s): ${att.files.map((f) => f.name).join(', ')}`);
    if (skipped.length) await emit('warning', `Adjuntos demasiado grandes para el análisis visual: ${skipped.join(', ')}.`);
    const user = [`Solicitud del funcional:\n"""\n${req.prompt}\n"""`, attachmentsText(att.files).replace(/ → .*$/gm, '')].filter(Boolean).join('\n\n');
    const { data, metrics } = await llm.json({ system, user, blocks, schema: SCHEMAS.classification });
    await emit('thought', data.resumen);
    const ioKey = await saveIo('requirement-classification-agent', {
      prompt: { base: analyst.prompt, instrucciones: system.slice(analyst.prompt.length).trim(), solicitud: user, contexto: { app: cfg.app.name, repo: `${cfg.app.repo.owner}/${cfg.app.repo.name}` }, version: `${fw.branch ?? ''}@${(fw.sha ?? '').slice(0, 7)}` },
      input: { prompt: req.prompt, adjuntos: att.files.map((f) => ({ nombre: f.name, tipo: f.kind, kb: Math.round(f.bytes / 1024) })) },
      output: data,
    });
    return { text: `Clasificado: ${data.changeTypes.join(', ') || 'sin tipo'} · riesgo ${data.riesgo}.`, output: data, metrics, ioKey, data };
  });
  const signals = classification.data;

  const { decideComplexity } = await import('./vendor/routing.mjs');
  const decision = await step('complexity-router', 'El Complexity Router elige el perfil mínimo suficiente.', async () => {
    const input = { source: 'nadf-portal', description: `${req.prompt}\n${signals.description}`, changeTypes: signals.changeTypes, layers: signals.layers, backendRequired: signals.backendRequired, frontendRequired: signals.frontendRequired, ambiguous: signals.ambiguous };
    const d = decideComplexity(input);
    const ioKey = await saveIo('complexity-router', { prompt: null, input, output: d, tool: 'decideComplexity (prototypes/m6-cloud-agent/src/complexity-routing)' });
    return { text: `Perfil ${d.profile} (${d.level}) · confianza ${d.confidence}. ${d.rationale[0] ?? ''}`, output: d, ioKey, d };
  });

  const result = await step('orchestrator', 'El Orquestador arma el plan con los presets del proyecto.', async () => {
    const p = buildPlan(decision.d, { projectId: cfg.companyId, appLayers: ['frontend'], model: cfg.model, flow: req.flowTemplate ?? null });
    const rules = rulesFor(p, cfg.companyId, overrides);
    const ioKey = await saveIo('orchestrator', { prompt: null, input: { decision: decision.d, project: cfg.companyId }, output: { nodes: p.nodes.map((n) => ({ id: n.id, planned: n.planned, reason: n.reason })), edges: p.edges } });
    return { text: `Plan listo: ${p.nodes.filter((n) => n.planned === 'run').length} pasos a ejecutar, ${p.nodes.filter((n) => n.planned === 'skip').length} omitidos.`, ioKey, p, rules };
  });

  const p = result.p;
  for (const n of p.nodes) {
    if (['request', 'requirement-classification-agent', 'complexity-router', 'orchestrator'].includes(n.id)) continue;
    await state.nodeSet(n.id, n.planned === 'skip' ? NODE.SKIPPED : NODE.PENDING, n.planned === 'skip' ? `${n.label} — ${n.reason}` : undefined);
  }
  const workflow = { ...p, framework: fw, createdAt: new Date().toISOString(), executionId: cfg.buildId };
  const rules = { version: 1, locked: false, nodes: result.rules, history: [{ version: 1, at: new Date().toISOString(), by: 'NADF (valores por defecto del framework)', note: 'Reglas iniciales del plan' }] };
  await state.update({
    status: p.blocked ? 'blocked' : 'planned',
    stage: p.blocked ? 'blocked' : 'planned',
    workflow,
    rules,
    agentOverrides: overrides,
    classification: signals,
    title: req.title ?? signals.resumen?.slice(0, 90),
    error: p.blocked ? { code: 'PLAN_BLOCKED', message: `${p.blockReason}${signals.preguntas?.length ? ` Preguntas: ${signals.preguntas.join(' ')}` : ''}` } : null,
  }, ['planning']);
  await state.emit(p.blocked ? 'warning' : 'success', p.blocked ? p.blockReason : 'Plan listo. Revisa los agentes y sus reglas; cuando quieras, pulsa «Ejecutar plan».', { eventType: p.blocked ? 'PLAN_BLOCKED' : 'PLAN_READY' });
}

// ---------------------------------------------------------------- develop

async function develop() {
  const req = await state.get();
  if (req.iteration !== cfg.iteration) return console.log('Ejecución obsoleta (iteración distinta); se ignora.');
  if (!(await state.update({ status: 'developing', stage: 'preparing', error: null }, ['queued']))) return console.log('La solicitud ya no está en cola; se ignora.');
  const legacy = !req.workflow;
  if (legacy) throw new Stop('failed', 'NO_PLAN', 'Esta solicitud no tiene plan (versión anterior). Crea una solicitud nueva.');

  const [claudeKey, ghApp, envProd, appUser] = await Promise.all([
    secret('/nadf/platform/claude-api-key'),
    secret('/nadf/platform/github-app', true),
    secret(`/nadf/${cfg.companyId}/web-env-prod`),
    secret(cfg.app.previewUserSecret, true),
  ]);
  const llm = createLlm({ apiKey: claudeKey, model: cfg.model });
  const { owner, name, defaultBranch, installationId } = cfg.app.repo;
  const ghToken = await installationToken(ghApp, installationId, name);
  const auth = gitAuthArgs(ghToken);
  const branch = `nadf/req-${cfg.requestId.slice(0, 8)}`;
  const criteria = req.classification?.criterios_aceptacion ?? [];

  // ---- Guardián PROD (incluye preparar el repo).
  let clients;
  let prod;
  let baseSha;
  let remoteBranch;
  let lintBefore = 0;
  await step('prod-preflight', cfg.iteration > 1 ? `Iteración ${cfg.iteration}: verifico PROD y retomo la rama.` : 'Clonando el repo y verificando que PROD coincide con main.', async (emit) => {
    await rm(cfg.work, { recursive: true, force: true });
    await mkdir(cfg.work, { recursive: true });
    await emit('tool', `GitHub (conector NADF): clonar ${owner}/${name}@${defaultBranch}`);
    await must('git', [...auth, 'clone', '--filter=blob:none', '--branch', defaultBranch, `https://github.com/${owner}/${name}.git`, repoDir], { cwd: cfg.work, quiet: true, label: 'git clone', errorCode: 'REPO_CLONE_FAILED' });
    baseSha = (await git(['rev-parse', 'HEAD'])).out.trim();
    await writeFile(join(repoDir, '.env.prod'), envProd);
    await emit('tool', 'Ejecutando: npm ci');
    await must('npm', ['ci', '--no-audit', '--no-fund'], { cwd: repoDir, quiet: true, label: 'npm ci', timeoutMs: 20 * 60 * 1000, errorCode: 'INSTALL_FAILED' });
    clients = prodClients(cfg.app, await assumeProd(cfg.app, `nadf-pre-${cfg.requestId.slice(0, 8)}`, previewPolicy(cfg.app.prod.bucket)));
    const last = await lastInvalidation(clients.cloudtrail, cfg.app.prod.distributionId);
    if (last) await emit('info', `Último despliegue de PROD: ${last.by} el ${last.at}.`);
    await emit('tool', 'Ejecutando: npm run build:prod (main)');
    await buildProd('Build de main');
    const localIndex = await readFile(join(repoDir, 'packages/shell/dist/index.html'), 'utf8');
    const localFiles = await crawl(localIndex, localFetcher(join(repoDir, 'packages/shell/dist')));
    await emit('tool', `AWS (rol ${cfg.app.prod.deployRoleArn.split('/').pop()}, solo lectura): leer bundle de PROD`);
    prod = await prodStrings(clients);
    const onlyProd = diffStrings(prod.strings, uiStrings(localFiles));
    const ioKey = await saveIo('prod-preflight', { prompt: null, input: { main: baseSha, prodIndexEtag: prod.index.etag, lastDeploy: last }, output: { prodJs: prod.files, mainJs: localFiles.size, onlyInProd: onlyProd } });
    if (onlyProd.length > 0) {
      throw new Stop('blocked', 'PROD_DIFFERS_FROM_MAIN', `PROD tiene ${onlyProd.length} textos que no están en main (alguien desplegó código sin publicar${last ? `; último despliegue: ${last.by}` : ''}). Desplegar desde main revertiría esos cambios: publiquen esa rama en main y reintenta.`, { sample: onlyProd.slice(0, 8), ioKey });
    }
    tests.push({ name: 'PROD coincide con main antes de empezar', status: 'passed', detail: `${prod.files} archivos JS comparados` });
    lintBefore = lintCount((await run('npm', ['run', 'lint'], { cwd: repoDir, quiet: true, timeoutMs: 15 * 60 * 1000 })).out);
    remoteBranch = (await run('git', [...auth, 'ls-remote', '--heads', 'origin', branch], { cwd: repoDir, quiet: true })).out.trim();
    if (remoteBranch) {
      await git([...auth, 'fetch', 'origin', `${branch}:${branch}`]);
      await git(['checkout', branch]);
      const merged = await run('git', ['-c', 'user.name=NADF', '-c', 'user.email=nadf@novusintelligencesolutions.com', 'merge', '--no-edit', `origin/${defaultBranch}`], { cwd: repoDir, quiet: true });
      if (merged.code !== 0) throw new Stop('failed', 'MERGE_CONFLICT', 'La rama de trabajo tiene conflictos con main. Hay que crear una solicitud nueva.');
    } else {
      await git(['checkout', '-b', branch]);
    }
    return { text: `PROD coincide con main @ ${baseSha.slice(0, 7)}.`, ioKey, output: { main: baseSha, prodJs: prod.files } };
  });

  // ---- Adjuntos del funcional (fuera del repo: nunca entran al PR).
  const att = await loadAttachments({ s3, bucket: cfg.evidence, list: req.attachments ?? [], dir: join(cfg.work, 'adjuntos') });
  const attText = attachmentsText(att.files);
  const attBlocks = (await attachmentBlocks(att.files)).blocks;

  // ---- Planificador / Arquitecto (solo si el plan los incluye).
  const fileList = (await git(['ls-files', 'packages/shell/src', 'packages/shared/src'])).out.split('\n').filter(Boolean).slice(0, 1500).join('\n');
  let planOut = null;
  let designOut = null;
  for (const [id, schema] of [['planner-agent', SCHEMAS.plan], ['architect-agent', SCHEMAS.design]]) {
    if (!willRun(req, id)) continue;
    const def = agentDefinition(id);
    const out = await step(id, `${planned(req, id).label} trabajando.`, async (emit) => {
      const system = `${promptOf(req, id)}\n\nReglas de esta ejecución:\n${ruleText(rulesOf(req, id))}\nResponde solo con el JSON pedido, en español.`;
      const user = [`Solicitud:\n"""\n${req.prompt}\n"""`, attText.replace(/ → .*$/gm, ''), `Criterios de aceptación:\n${criteria.map((c) => `- ${c}`).join('\n')}`, planOut ? `Plan:\n${JSON.stringify(planOut)}` : '', `Archivos del repo (${name}):\n${fileList}`].filter(Boolean).join('\n\n');
      const { data, metrics } = await llm.json({ system, user, blocks: attBlocks, schema });
      await emit('thought', (data.pasos ?? data.decisiones ?? []).slice(0, 6).join('\n') || data['diseño'] || 'Listo.');
      const ioKey = await saveIo(id, { prompt: { base: def.prompt, instrucciones: ruleText(rulesOf(req, id)), solicitud: req.prompt, contexto: { archivos: 'listado de packages/shell/src y packages/shared/src' } }, input: { criterios: criteria }, output: data });
      return { text: 'Completado.', output: data, metrics, ioKey, data };
    });
    if (id === 'planner-agent') planOut = out.data;
    else designOut = out.data;
  }

  // ---- Desarrollador (Claude Code).
  const dev = agentDefinition('frontend-integration-agent');
  const reportSchema = {
    titulo: 'Título corto del cambio',
    resumen: 'Qué cambió, explicado para una persona no técnica (2-4 frases)',
    hecho: ['Cada cosa implementada'],
    no_hecho: ['Lo que se pidió y no se hizo, con el motivo'],
    limitaciones: ['Riesgos o límites conocidos'],
    preguntas: ['Preguntas para el funcional sobre lo que falta o es ambiguo'],
    pruebas_sugeridas: ['Qué debería revisar el aprobador en la vista previa'],
    rutas_a_revisar: ['/ruta-donde-se-ve-el-cambio'],
    riesgo: 'bajo | medio | alto',
    archivos: ['ruta/del/archivo.tsx'],
  };
  let report = {};
  let files = [];
  let reverted = [];
  let claude;
  await step('frontend-integration-agent', 'El Desarrollador (Claude Code) está implementando el cambio.', async (emit) => {
    const instructions = [
      `Trabajas en el repositorio real de ${cfg.app.name} (${owner}/${name}), una app React + Vite con workspaces (packages/shared, packages/shell, packages/mfe-auth).`,
      'Reglas de esta ejecución (las obligatorias no se pueden omitir):',
      ruleText(rulesOf(req, 'frontend-integration-agent')),
      `- AL TERMINAR escribe nadf-report.json en la raíz del repo con este formato (JSON válido, en español): ${JSON.stringify(reportSchema)}`,
      '- En "rutas_a_revisar" pon hasta 4 rutas (path) donde el aprobador ve el cambio; la vista previa abre logueada con un usuario admin.',
    ].join('\n');
    const system = `${promptOf(req, 'frontend-integration-agent')}\n\n${instructions}`;
    const feedback = (req.feedback ?? []).map((f) => `- ${f.by?.name ?? f.by?.email ?? 'Revisor'}: ${f.text}`).join('\n');
    const prompt = [
      `Solicitud de ${req.createdBy?.name ?? req.createdBy?.email} para ${cfg.app.name}:`,
      '"""',
      req.prompt,
      '"""',
      criteria.length ? `Criterios de aceptación (Analista):\n${criteria.map((c) => `- ${c}`).join('\n')}` : '',
      attText ? `${attText}\nAbre las imágenes y documentos con la herramienta Read si los necesitas. No copies los adjuntos al repositorio.` : '',
      planOut ? `Plan del Planificador:\n${planOut.pasos.map((s) => `- ${s}`).join('\n')}` : '',
      designOut ? `Diseño del Arquitecto:\n${designOut['diseño']}` : '',
      cfg.iteration > 1
        ? [`Iteración ${cfg.iteration}: la rama ${branch} ya tiene trabajo (revisa git log/diff contra origin/${defaultBranch}).`, req.report ? `Informe anterior: ${JSON.stringify(req.report)}` : '', feedback ? `Comentarios del revisor:\n${feedback}` : 'Se pidió reintentar.'].join('\n')
        : '',
    ].filter(Boolean).join('\n\n');
    claude = await runClaude({ cwd: repoDir, prompt, system, model: cfg.model, budgetUsd: cfg.budgetUsd, apiKey: claudeKey, emit, addDirs: att.dir ? [att.dir] : [] });
    if (!claude.ok && claude.subtype !== 'error_max_budget_usd') throw new Stop('failed', 'AGENT_FAILED', 'Claude Code no pudo terminar el desarrollo.', { tail: claude.tail });
    if (claude.subtype === 'error_max_budget_usd') await emit('warning', `Se alcanzó el presupuesto de ${cfg.budgetUsd} USD de esta ejecución.`);
    const reportPath = join(repoDir, 'nadf-report.json');
    if (existsSync(reportPath)) {
      try {
        report = JSON.parse(await readFile(reportPath, 'utf8'));
      } catch {
        await emit('warning', 'El informe del agente no era JSON válido; uso su mensaje final.');
      }
      await rm(reportPath, { force: true });
    }
    if (!report.resumen) report.resumen = claude.text.slice(0, 2000);
    const changed = (await git(['status', '--porcelain'])).out.split('\n').filter(Boolean).map((l) => l.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''));
    reverted = changed.filter((p) => /^(\.env|infrastructure\/|\.github\/|scripts\/deploy|.*deploy-.*\.ps1$)/.test(p) || p === 'package-lock.json');
    for (const p of reverted) {
      await run('git', ['checkout', '--', p], { cwd: repoDir, quiet: true });
      await run('git', ['clean', '-f', '--', p], { cwd: repoDir, quiet: true });
    }
    await writeFile(join(repoDir, '.env.prod'), envProd);
    files = changed.filter((p) => !reverted.includes(p) && p !== '.env.prod' && p !== 'nadf-report.json');
    const ioKey = await saveIo('frontend-integration-agent', {
      prompt: { base: promptOf(req, 'frontend-integration-agent'), instrucciones: instructions, solicitud: prompt, contexto: { repo: `${owner}/${name}`, rama: branch, base: baseSha }, version: `${fw.branch ?? ''}@${(fw.sha ?? '').slice(0, 7)}` },
      input: { criterios: criteria, plan: planOut, diseño: designOut },
      output: report,
      artefactos: { archivos: files, revertidos: reverted },
    });
    const metrics = { model: cfg.model, inputTokens: claude.inputTokens, outputTokens: claude.outputTokens, costUsd: claude.costUsd, turns: claude.turns, runtime: 'Claude Code 2.1.322' };
    return { text: files.length ? `Cambió ${files.length} archivo(s).` : 'No hizo cambios en el código.', output: { archivos: files }, metrics, ioKey };
  });

  const ahead = remoteBranch ? (await git(['rev-list', '--count', `origin/${defaultBranch}..HEAD`])).out.trim() : '0';
  if (!files.length && ahead === '0') {
    await skipRest(req, ['preview', 'qa-agent', 'security-gate', 'security-agent', 'reviewer-agent', 'pull-request', 'human-approval', 'release', 'prod-verification'], 'No se ejecuta: el agente no hizo cambios.');
    await state.update({ status: 'no_changes', stage: 'done', title: report.titulo ?? req.title, report, tests, costUsd: (req.costUsd ?? 0) + (claude?.costUsd ?? 0) }, ['developing']);
    await state.emit('warning', 'El agente no hizo cambios en el código. Revisa su informe y sus preguntas.');
    return;
  }

  // ---- Vista previa (build + publicación oculta).
  const pid = `${cfg.requestId}-${cfg.iteration}`;
  const previewKey = `__nadf/preview/${pid}/index.html`;
  const previewUrl = `${cfg.app.prod.url}/${previewKey}`;
  const shellDist = join(repoDir, 'packages/shell/dist');
  await step('preview', 'Compilando y publicando una vista previa privada.', async (emit) => {
    await emit('tool', 'Ejecutando: npm run build:prod (con los cambios)');
    await buildProd('Build con los cambios');
    tests.push({ name: 'Compilación de producción (npm run build:prod)', status: 'passed' });
    const builtIndex = await readFile(join(shellDist, 'index.html'), 'utf8');
    await emit('tool', 'AWS (política de sesión: solo archivos nuevos y __nadf/*): publicar vista previa');
    const up = await uploadPreview(clients.s3, cfg.app.prod.bucket, shellDist, previewKey, previewIndex(builtIndex, cfg.origins).html);
    await must('tar', ['-czf', join(cfg.work, 'dist.tgz'), 'packages/shell/dist', 'packages/mfe-auth/dist'], { cwd: repoDir, quiet: true, label: 'empaquetado' });
    await putEvidence(`${prefix}/dist.tgz`, await readFile(join(cfg.work, 'dist.tgz')), 'application/gzip');
    const ioKey = await saveIo('preview', { prompt: null, input: { archivos: files }, output: { previewUrl, nuevos: up.uploaded, existentes: up.skipped, artefacto: `${prefix}/dist.tgz`, entrada: entryScripts(builtIndex) } });
    return { text: `Vista previa publicada (${up.uploaded} archivos nuevos). El index público no cambió.`, ioKey, output: { previewUrl } };
  });
  const builtIndex = await readFile(join(shellDist, 'index.html'), 'utf8');

  // ---- QA ‖ Guardas de seguridad ‖ Seguridad (en paralelo, como indica el plan).
  // Archivos nuevos: intent-to-add para que aparezcan en el diff que revisan Seguridad y el Revisor.
  await run('git', ['add', '-N', '--', ...files.map((f) => f.replace(/\/$/, ''))], { cwd: repoDir, quiet: true });
  const diff = (await git(['diff', `origin/${defaultBranch}`, '--', ...files.map((f) => f.replace(/\/$/, ''))])).out.slice(0, 120_000);
  const screenshots = [];
  const branches = [
    step('qa-agent', 'QA prueba el cambio: lint y capturas antes/después con el usuario admin.', async (emit) => {
      await emit('tool', 'Ejecutando: npm run lint');
      const lintAfter = lintCount((await run('npm', ['run', 'lint'], { cwd: repoDir, quiet: true, timeoutMs: 15 * 60 * 1000 })).out);
      tests.push({ name: 'Lint', status: lintAfter > lintBefore ? 'warning' : 'passed', detail: lintAfter > lintBefore ? `El cambio agrega ${lintAfter - lintBefore} errores de lint (había ${lintBefore}).` : `Sin errores nuevos (el repo ya tenía ${lintBefore}).` });
      tests.push({ name: 'Pruebas unitarias', status: 'skipped', detail: 'El repositorio no tiene un script de pruebas unitarias (npm test).' });
      const session = await appSession(cfg.app.apiBaseUrl, appUser);
      const routes = [...new Set((report.rutas_a_revisar ?? []).filter((r) => typeof r === 'string' && r.startsWith('/')).slice(0, 4))];
      if (!routes.length) routes.push('/');
      await emit('tool', `Playwright (Chromium): ${routes.length} ruta(s), antes en PROD y después en la vista previa`);
      const origin = new URL(cfg.app.prod.url).origin;
      const before = await capture({ cwd: cfg.runnerDir, origin, session, urlFor: (r) => `${cfg.app.prod.url}${r}`, views: routes.map((route) => ({ route, label: `Antes · ${route}`, mobile: false })), outDir: join(cfg.work, 'shots-before') });
      const after = await capture({ cwd: cfg.runnerDir, origin, session, urlFor: (r) => `${previewUrl}?ruta=${encodeURIComponent(r)}`, views: [...routes.map((route) => ({ route, label: `Después · ${route}`, mobile: false })), { route: routes[0], label: `Después · ${routes[0]} · móvil`, mobile: true }], outDir: join(cfg.work, 'shots') });
      for (const [kind, shots] of [['antes', before], ['despues', after]]) {
        for (const shot of shots) {
          const key = `${prefix}/capturas/${kind}-${shot.file.split('/').pop()}`;
          if (existsSync(shot.file)) {
            await putEvidence(key, await readFile(shot.file), 'image/png');
            screenshots.push({ key, label: shot.label, kind, route: shot.route });
          }
          if (kind === 'despues') tests.push({ name: `Vista previa ${shot.label.replace('Después · ', '')}`, status: shot.loaded ? (shot.errors.length ? 'warning' : 'passed') : 'failed', detail: shot.errors.length ? shot.errors.slice(0, 3).join(' | ') : 'Carga sin errores, con sesión de admin.' });
        }
      }
      const failed = after.filter((s) => !s.loaded).length;
      const ioKey = await saveIo('qa-agent', { prompt: null, input: { rutas: routes, previewUrl }, output: { pruebas: tests, capturas: screenshots.map((s) => s.label) } });
      return { status: failed ? NODE.FAILED : NODE.COMPLETED, text: failed ? `${failed} vista(s) no cargaron.` : `${tests.filter((t) => t.status === 'passed').length} pruebas superadas.`, ioKey, output: { pruebas: tests.length, fallidas: tests.filter((t) => t.status === 'failed').length } };
    }),
    step('security-gate', 'Guardas obligatorias: rutas protegidas y secretos en el diff.', async (emit) => {
      const secretHits = [...diff.matchAll(/^\+.*(sk-ant-[\w-]{10,}|AKIA[0-9A-Z]{16}|ghp_[\w]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|password\s*[:=]\s*["'][^"']{6,})/gim)].map((m) => m[1].slice(0, 12) + '…');
      await emit('tool', `Revisión del diff (${files.length} archivo(s))`);
      const ioKey = await saveIo('security-gate', { prompt: null, input: { archivos: files }, output: { revertidos: reverted, secretos: secretHits.length } });
      if (secretHits.length) throw new Stop('blocked', 'SECRET_IN_DIFF', `Se detectaron ${secretHits.length} posibles secretos en el cambio. No se puede continuar.`);
      return { text: reverted.length ? `Revertí cambios en archivos protegidos: ${reverted.join(', ')}. Sin secretos.` : 'Sin archivos protegidos ni secretos en el cambio.', ioKey, output: { revertidos: reverted } };
    }),
  ];
  for (const id of ['security-agent']) {
    if (!willRun(req, id)) continue;
    const def = agentDefinition(id);
    branches.push(
      step(id, 'El agente de Seguridad revisa el diff.', async (emit) => {
        const system = `${promptOf(req, id)}\n\nReglas de esta ejecución:\n${ruleText(rulesOf(req, id))}\nResponde solo con el JSON pedido, en español.`;
        const user = `Solicitud:\n${req.prompt}\n\nDiff:\n${diff.slice(0, 90_000)}`;
        const { data, metrics } = await llm.json({ system, user, schema: SCHEMAS.review });
        await emit('thought', data.resumen);
        const ioKey = await saveIo(id, { prompt: { base: def.prompt, instrucciones: ruleText(rulesOf(req, id)), solicitud: req.prompt, contexto: { diff: `${files.length} archivo(s)` } }, input: { archivos: files }, output: data });
        if (data.veredicto === 'bloqueante') throw new Stop('blocked', 'SECURITY_REVIEW_BLOCKED', `Seguridad bloqueó el cambio: ${data.resumen}`);
        return { text: `Veredicto: ${data.veredicto.replace('_', ' ')}.`, output: data, metrics, ioKey };
      }),
    );
  }
  const settled = await Promise.allSettled(branches);
  const rejected = settled.find((s) => s.status === 'rejected');
  if (rejected) {
    await skipRest(req, ['reviewer-agent', 'pull-request', 'human-approval', 'release', 'prod-verification'], 'No se ejecuta: una validación anterior no pasó.');
    throw rejected.reason;
  }

  if (willRun(req, 'reviewer-agent')) {
    const def = agentDefinition('reviewer-agent');
    await step('reviewer-agent', 'El Revisor compara el cambio con los criterios de aceptación.', async (emit) => {
      const system = `${promptOf(req, 'reviewer-agent')}\n\nReglas de esta ejecución:\n${ruleText(rulesOf(req, 'reviewer-agent'))}\nResponde solo con el JSON pedido, en español.`;
      const user = `Criterios de aceptación:\n${criteria.map((c) => `- ${c}`).join('\n')}\n\nDiff:\n${diff.slice(0, 90_000)}`;
      const { data, metrics } = await llm.json({ system, user, schema: SCHEMAS.review });
      await emit('thought', data.resumen);
      const ioKey = await saveIo('reviewer-agent', { prompt: { base: def.prompt, instrucciones: ruleText(rulesOf(req, 'reviewer-agent')), solicitud: req.prompt, contexto: { criterios: criteria } }, input: { archivos: files }, output: data });
      if (data.veredicto === 'bloqueante') throw new Stop('blocked', 'REVIEW_BLOCKED', `El Revisor bloqueó el cambio: ${data.resumen}`);
      return { text: `Veredicto: ${data.veredicto.replace('_', ' ')}.`, output: data, metrics, ioKey };
    });
  }

  // ---- Pull request.
  let pr;
  let diffStat = '';
  const title = (report.titulo || req.title || req.prompt.split('\n')[0]).slice(0, 90);
  await step('pull-request', 'Guardando el cambio en una rama y abriendo el pull request.', async (emit) => {
    await git(['add', '-A', '--', ...files.map((f) => f.replace(/\/$/, ''))]);
    const hasStaged = (await run('git', ['diff', '--cached', '--quiet'], { cwd: repoDir, quiet: true })).code !== 0;
    if (hasStaged) {
      await git(['-c', 'user.name=NADF · Novus Intelligence', '-c', 'user.email=nadf@novusintelligencesolutions.com', 'commit', '-m', `nadf: ${title}\n\nSolicitud ${cfg.requestId} (iteración ${cfg.iteration}) desde el portal NADF.\nPedida por: ${req.createdBy?.name ?? req.createdBy?.email}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`]);
    }
    await emit('tool', `GitHub (conector NADF): push ${branch}`);
    await git([...auth, 'push', 'origin', `HEAD:refs/heads/${branch}`], { errorCode: 'REPO_PUSH_DENIED' });
    diffStat = (await git(['diff', '--stat', `origin/${defaultBranch}...HEAD`])).out.trim().split('\n').slice(-12).join('\n');
    const list = (items) => (items?.length ? items.map((i) => `- ${i}`).join('\n') : '- (nada)');
    const prBody = [
      `**Solicitud NADF** \`${cfg.requestId}\` · iteración ${cfg.iteration} · perfil ${req.workflow.profile} · pedida por ${req.createdBy?.name ?? req.createdBy?.email}`,
      '',
      '> ' + req.prompt.split('\n').join('\n> '),
      '',
      `### Resumen\n${report.resumen ?? ''}`,
      `### Hecho\n${list(report.hecho)}`,
      `### No hecho\n${list(report.no_hecho)}`,
      `### Limitaciones\n${list(report.limitaciones)}`,
      `### Pruebas\n${tests.map((t) => `- ${t.status === 'passed' ? '✅' : t.status === 'failed' ? '❌' : t.status === 'warning' ? '⚠️' : '⏭️'} ${t.name}${t.detail ? ` — ${t.detail}` : ''}`).join('\n')}`,
      '',
      'Se despliega a PROD **solo** cuando un aprobador lo autoriza en el portal NADF (con verificación en dos pasos). NADF hace el merge después del despliegue.',
      '',
      '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
    ].join('\n');
    const existing = await api(`/repos/${owner}/${name}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`, ghToken);
    await emit('tool', `GitHub (conector NADF): ${existing.length ? 'actualizar' : 'abrir'} pull request`);
    pr = existing.length
      ? await api(`/repos/${owner}/${name}/pulls/${existing[0].number}`, ghToken, { method: 'PATCH', body: { title: `NADF: ${title}`, body: prBody } })
      : await api(`/repos/${owner}/${name}/pulls`, ghToken, { method: 'POST', body: { title: `NADF: ${title}`, head: branch, base: defaultBranch, body: prBody } });
    const ioKey = await saveIo('pull-request', { prompt: null, input: { rama: branch, base: baseSha }, output: { pr: pr.html_url, numero: pr.number, diffStat } });
    return { text: `PR #${pr.number} listo.`, ioKey, output: { prUrl: pr.html_url, prNumber: pr.number } };
  });

  await state.update({
    status: 'awaiting_approval',
    stage: 'awaiting_approval',
    title,
    report,
    tests,
    screenshots,
    previewUrl,
    prUrl: pr.html_url,
    prNumber: pr.number,
    branch,
    baseSha,
    headSha: (await git(['rev-parse', 'HEAD'])).out.trim(),
    prodEtag: prod.index.etag,
    previewEntry: entryScripts(builtIndex),
    diffStat,
    changedFiles: files,
    costUsd: Math.round(((req.costUsd ?? 0) + (claude?.costUsd ?? 0)) * 100) / 100,
  }, ['developing']);
  await state.nodeSet('human-approval', NODE.WAITING_APPROVAL, `Listo para revisión. PR #${pr.number}. Abre la vista previa y decide.`);
}

// ---------------------------------------------------------------- deploy

async function deploy() {
  const req = await state.get();
  if (!(await state.update({ status: 'deploying', stage: 'deploy_checks', deployment: { startedAt: new Date().toISOString(), buildId: cfg.buildId } }, ['approved']))) return console.log('La solicitud no está aprobada; se ignora.');
  const [ghApp, appUser] = await Promise.all([secret('/nadf/platform/github-app', true), secret(cfg.app.previewUserSecret, true)]);
  const { owner, name, defaultBranch, installationId } = cfg.app.repo;
  const ghToken = await installationToken(ghApp, installationId, name);
  const bucket = cfg.app.prod.bucket;
  let clients;
  let current;
  let backupAuth;
  let invalidationId = null;
  let newIndex;

  const restore = async (why, emit) => {
    await emit('error', `${why} Vuelvo a la versión anterior.`);
    await put(clients.s3, bucket, 'index.html', current.body, 'public, max-age=0, must-revalidate');
    if (backupAuth) await put(clients.s3, bucket, 'mfe-auth/index.html', backupAuth.body, 'public, max-age=0, must-revalidate');
    const id = await invalidate(clients.cloudfront, cfg.app.prod.distributionId, `nadf-rollback-${cfg.requestId}-${Date.now()}`);
    await waitInvalidation(clients.cloudfront, cfg.app.prod.distributionId, id);
    await emit('warning', 'PROD volvió a la versión anterior.');
  };

  await step('release', `Release a PROD aprobado por ${req.decision?.by?.name ?? req.decision?.by?.email}.`, async (emit) => {
    clients = prodClients(cfg.app, await assumeProd(cfg.app, `nadf-deploy-${cfg.requestId.slice(0, 8)}`));
    current = await getText(clients.s3, bucket, 'index.html');
    if (!current || current.etag !== req.prodEtag) {
      const last = await lastInvalidation(clients.cloudtrail, cfg.app.prod.distributionId);
      throw new Stop('blocked', 'PROD_CHANGED', `PROD cambió desde la revisión${last ? ` (último despliegue: ${last.by}, ${last.at})` : ''}. Para no revertir ese cambio, pide ajustes/reintento: NADF rehace el build sobre lo nuevo.`);
    }
    const mainRef = await api(`/repos/${owner}/${name}/git/ref/heads/${defaultBranch}`, ghToken);
    if (mainRef.object.sha !== req.baseSha) throw new Stop('blocked', 'MAIN_CHANGED', `main avanzó desde la revisión (${req.baseSha.slice(0, 7)} → ${mainRef.object.sha.slice(0, 7)}). Reintenta para incluir esos cambios antes de desplegar.`);
    await emit('success', 'PROD y main siguen iguales a lo revisado.');
    await rm(cfg.work, { recursive: true, force: true });
    await mkdir(cfg.work, { recursive: true });
    const tgz = await s3.send(new GetObjectCommand({ Bucket: cfg.evidence, Key: `${prefix}/dist.tgz` }));
    await writeFile(join(cfg.work, 'dist.tgz'), Buffer.from(await tgz.Body.transformToByteArray()));
    await must('tar', ['-xzf', 'dist.tgz'], { cwd: cfg.work, quiet: true, label: 'desempaquetado' });
    const shellDist = join(cfg.work, 'packages/shell/dist');
    const authDist = join(cfg.work, 'packages/mfe-auth/dist');
    newIndex = await readFile(join(shellDist, 'index.html'), 'utf8');
    backupAuth = await getText(clients.s3, bucket, 'mfe-auth/index.html');
    await putEvidence(`${prefix}/respaldo/index.html`, current.body, 'text/html; charset=utf-8');
    if (backupAuth) await putEvidence(`${prefix}/respaldo/mfe-auth-index.html`, backupAuth.body, 'text/html; charset=utf-8');
    await emit('info', 'Respaldé la versión actual de PROD (artefacto recuperable para rollback).');
    const plan = await uploadPlan(shellDist, existsSync(authDist) ? authDist : null);
    if (cfg.dryRun) {
      await emit('warning', `Modo prueba: se subirían ${plan.length} archivos; no se publica nada.`);
    } else {
      await emit('tool', `AWS S3 (rol ${cfg.app.prod.deployRoleArn.split('/').pop()}): publicar ${plan.length} archivos, index al final`);
      await uploadAll(clients.s3, bucket, plan, (done, total) => emit('info', `Subidos ${done} de ${total} archivos.`));
      await emit('tool', `CloudFront: invalidar ${cfg.app.prod.distributionId}`);
      invalidationId = await invalidate(clients.cloudfront, cfg.app.prod.distributionId, `nadf-${cfg.requestId}-${Date.now()}`);
      if (!(await waitInvalidation(clients.cloudfront, cfg.app.prod.distributionId, invalidationId))) await emit('warning', 'La caché del CDN tarda más de lo normal; sigo con la verificación.');
    }
    const ioKey = await saveIo('release', { prompt: null, input: { artefacto: `${prefix}/dist.tgz`, prodEtagAntes: current.etag }, output: { archivos: plan.length, invalidationId, respaldo: `${prefix}/respaldo/index.html`, dryRun: cfg.dryRun } });
    return { text: cfg.dryRun ? 'Modo prueba: no se publicó nada.' : `Publicado en PROD (invalidación ${invalidationId}).`, ioKey, output: { invalidationId } };
  });

  const smoke = [];
  const deployShots = [];
  try {
    await step('prod-verification', 'Verificando PROD con el usuario admin de la app.', async (emit) => {
      const live = await fetch(`${cfg.app.prod.url}/?nadf=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } }).then((r) => r.text());
      const served = cfg.dryRun || entryScripts(newIndex).every((s) => live.includes(s));
      smoke.push({ name: 'PROD sirve la versión nueva', status: served ? 'passed' : 'failed', detail: served ? (cfg.dryRun ? 'Modo prueba' : 'index.html nuevo en el CDN') : 'El CDN aún sirve la versión anterior' });
      const session = await appSession(cfg.app.apiBaseUrl, appUser);
      const routes = [...new Set(['/', ...(req.report?.rutas_a_revisar ?? []).filter((r) => typeof r === 'string' && r.startsWith('/'))])].slice(0, 4);
      await emit('tool', `Playwright (Chromium): ${routes.length} ruta(s) en PROD`);
      const shots = await capture({ cwd: cfg.runnerDir, origin: new URL(cfg.app.prod.url).origin, session, urlFor: (r) => `${cfg.app.prod.url}${r}`, views: routes.map((route) => ({ route, label: `PROD ${route}`, mobile: false })), outDir: join(cfg.work, 'shots-prod') });
      for (const shot of shots) {
        const key = `${prefix}/prod/${shot.file.split('/').pop()}`;
        if (existsSync(shot.file)) {
          await putEvidence(key, await readFile(shot.file), 'image/png');
          deployShots.push({ key, label: shot.label });
        }
        smoke.push({ name: shot.label, status: shot.loaded ? (shot.errors.length ? 'warning' : 'passed') : 'failed', detail: shot.errors.slice(0, 3).join(' | ') || 'Carga correcta con sesión de admin.' });
      }
      const ioKey = await saveIo('prod-verification', { prompt: null, input: { rutas: routes }, output: { smoke } });
      if (!served || shots.some((s) => !s.loaded)) throw new Stop('rolled_back', 'SMOKE_FAILED', 'PROD no pasó la verificación.');
      return { text: `${smoke.filter((s) => s.status === 'passed').length}/${smoke.length} verificaciones correctas.`, ioKey, output: { smoke } };
    });
  } catch (error) {
    if (!cfg.dryRun) await restore(`La verificación de PROD falló (${error.message}).`, state.emitter('prod-verification'));
    await state.nodeSet('result', NODE.FAILED, 'Revertido: PROD no pasó la verificación.');
    await state.update({ status: 'rolled_back', stage: 'rolled_back', deployment: { ...req.deployment, buildId: cfg.buildId, finishedAt: new Date().toISOString(), invalidationId, smoke, screenshots: deployShots }, error: { code: 'SMOKE_FAILED', message: 'PROD no pasó la verificación y se volvió a la versión anterior.' } });
    return;
  }

  let merged = false;
  let mergeSha = null;
  if (!cfg.dryRun && req.prNumber) {
    try {
      const out = await api(`/repos/${owner}/${name}/pulls/${req.prNumber}/merge`, ghToken, { method: 'PUT', body: { merge_method: 'merge', commit_title: `Merge NADF: ${req.title ?? req.requestId} (#${req.prNumber})` } });
      merged = true;
      mergeSha = out.sha;
      await state.emit('success', `PR #${req.prNumber} fusionado en main: main queda igual a PROD.`, { nodeId: 'result' });
    } catch (error) {
      await state.emit('warning', `Desplegado, pero no pude fusionar el PR #${req.prNumber} (${error.message}). Fusiónalo pronto: otros despliegan desde main.`, { nodeId: 'result' });
    }
  }
  await state.nodeStart('result', 'Consolidando el resultado.');
  await state.nodeEnd('result', NODE.COMPLETED, cfg.dryRun ? 'Modo prueba completado (no se publicó nada).' : `En PROD y verificado: ${cfg.app.prod.url}`);
  await state.update({
    status: cfg.dryRun ? 'awaiting_approval' : 'deployed',
    stage: cfg.dryRun ? 'awaiting_approval' : 'deployed',
    deployment: {
      environment: 'PROD',
      url: cfg.app.prod.url,
      startedAt: req.deployment?.startedAt,
      finishedAt: new Date().toISOString(),
      buildId: cfg.buildId,
      invalidationId,
      branch: req.branch,
      commit: req.headSha,
      mergeCommit: mergeSha,
      version: entryScripts(newIndex).join(', '),
      approvedBy: req.decision?.by,
      approvedAt: req.decision?.at,
      backupKey: `${prefix}/respaldo/index.html`,
      iteration: cfg.iteration,
      smoke,
      screenshots: deployShots,
      merged,
      verified: true,
    },
  });
}

// ---------------------------------------------------------------- rollback (solicitado y aprobado)

async function rollback() {
  const req = await state.get();
  if (!(await state.update({ status: 'rolling_back', stage: 'rolling_back' }, ['rollback_approved']))) return console.log('El rollback no está aprobado; se ignora.');
  const dep = req.deployment;
  const [ghApp, appUser] = await Promise.all([secret('/nadf/platform/github-app', true), secret(cfg.app.previewUserSecret, true)]);
  const { owner, name, defaultBranch, installationId } = cfg.app.repo;
  const ghToken = await installationToken(ghApp, installationId, name);
  const bucket = cfg.app.prod.bucket;
  const smoke = [];
  let revertPr = null;

  await step('rollback', `Rollback aprobado por ${req.rollback?.approvedBy?.name ?? req.rollback?.approvedBy?.email}.`, async (emit) => {
    const clients = prodClients(cfg.app, await assumeProd(cfg.app, `nadf-rollback-${cfg.requestId.slice(0, 8)}`));
    const backup = await s3.send(new GetObjectCommand({ Bucket: cfg.evidence, Key: dep.backupKey })).then((o) => o.Body.transformToString('utf-8')).catch(() => null);
    if (!backup) throw new Stop('failed', 'NO_BACKUP', 'No hay un artefacto recuperable para este despliegue.');
    const live = await getText(clients.s3, bucket, 'index.html');
    const ours = (dep.version ?? '').split(', ').filter(Boolean);
    if (!ours.length || !ours.every((s) => live?.body.includes(s))) {
      throw new Stop('blocked', 'PROD_CHANGED_SINCE_DEPLOY', 'PROD cambió después de este despliegue; restaurar la versión anterior revertiría cambios de otras personas. Rollback detenido.');
    }
    const backupAuthKey = dep.backupKey.replace('index.html', 'mfe-auth-index.html');
    const backupAuth = await s3.send(new GetObjectCommand({ Bucket: cfg.evidence, Key: backupAuthKey })).then((o) => o.Body.transformToString('utf-8')).catch(() => null);
    await emit('tool', 'AWS S3: restaurar index.html respaldado (los assets anteriores siguen publicados)');
    await put(clients.s3, bucket, 'index.html', backup, 'public, max-age=0, must-revalidate');
    if (backupAuth) await put(clients.s3, bucket, 'mfe-auth/index.html', backupAuth, 'public, max-age=0, must-revalidate');
    await emit('tool', `CloudFront: invalidar ${cfg.app.prod.distributionId}`);
    const inv = await invalidate(clients.cloudfront, cfg.app.prod.distributionId, `nadf-rollback-${cfg.requestId}-${Date.now()}`);
    await waitInvalidation(clients.cloudfront, cfg.app.prod.distributionId, inv);
    const served = await fetch(`${cfg.app.prod.url}/?nadf=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } }).then((r) => r.text());
    const restored = entryScripts(backup).every((s) => served.includes(s));
    smoke.push({ name: 'PROD sirve la versión anterior', status: restored ? 'passed' : 'failed' });
    const session = await appSession(cfg.app.apiBaseUrl, appUser);
    const shots = await capture({ cwd: cfg.runnerDir, origin: new URL(cfg.app.prod.url).origin, session, urlFor: (r) => `${cfg.app.prod.url}${r}`, views: [{ route: '/', label: 'PROD / tras rollback', mobile: false }], outDir: join(cfg.work, 'shots-rollback') });
    for (const s of shots) smoke.push({ name: s.label, status: s.loaded ? 'passed' : 'failed', detail: s.errors.slice(0, 2).join(' | ') || undefined });
    // El código: PR de reversión (no se fusiona solo).
    if (dep.mergeCommit) {
      try {
        await rm(cfg.work, { recursive: true, force: true });
        await mkdir(cfg.work, { recursive: true });
        const auth = gitAuthArgs(ghToken);
        await must('git', [...auth, 'clone', '--filter=blob:none', '--branch', defaultBranch, `https://github.com/${owner}/${name}.git`, repoDir], { cwd: cfg.work, quiet: true, label: 'git clone' });
        const rb = `nadf/rollback-${cfg.requestId.slice(0, 8)}`;
        await git(['checkout', '-b', rb]);
        await git(['-c', 'user.name=NADF · Novus Intelligence', '-c', 'user.email=nadf@novusintelligencesolutions.com', 'revert', '--no-edit', '-m', '1', dep.mergeCommit]);
        await git([...auth, 'push', 'origin', `HEAD:refs/heads/${rb}`]);
        revertPr = await api(`/repos/${owner}/${name}/pulls`, ghToken, { method: 'POST', body: { title: `Revert NADF: ${req.title}`, head: rb, base: defaultBranch, body: `Rollback autorizado en el portal NADF (solicitud \`${cfg.requestId}\`). PROD ya volvió a la versión anterior; fusiona este PR para que main vuelva a coincidir con PROD.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)` } });
        await emit('success', `PR de reversión #${revertPr.number} abierto para que main vuelva a coincidir con PROD.`);
      } catch (error) {
        await emit('warning', `PROD restaurado, pero no pude abrir el PR de reversión (${error.message}). Hay que revertir el merge en main manualmente.`);
      }
    }
    const ioKey = await saveIo('rollback', { prompt: null, input: { respaldo: dep.backupKey, version: dep.version }, output: { smoke, revertPr: revertPr?.html_url ?? null } });
    if (!restored) throw new Stop('failed', 'ROLLBACK_NOT_SERVED', 'El CDN aún no sirve la versión restaurada.');
    return { text: 'PROD volvió a la versión anterior y se verificó.', ioKey };
  });
  await state.update({ status: 'rolled_back', stage: 'rolled_back', rollback: { ...req.rollback, finishedAt: new Date().toISOString(), smoke, revertPrUrl: revertPr?.html_url ?? null, buildId: cfg.buildId } });
}

// ---------------------------------------------------------------- main

try {
  if (cfg.phase === 'plan') await plan();
  else if (cfg.phase === 'develop') await develop();
  else if (cfg.phase === 'deploy') await deploy();
  else if (cfg.phase === 'rollback') await rollback();
  else throw new Error(`Fase desconocida: ${cfg.phase}`);
} catch (error) {
  const stop = error instanceof Stop ? error : new Stop('failed', error.code ?? 'RUNNER_ERROR', 'Ocurrió un error inesperado en el agente.');
  console.error(error);
  if (error.tail || stop.extra?.tail) console.error(error.tail ?? stop.extra.tail);
  await state.emit(stop.status === 'blocked' ? 'warning' : 'error', stop.message, { eventType: 'EXECUTION_STOPPED', status: stop.status.toUpperCase() });
  if (stop.extra?.sample) await state.emit('info', `Ejemplos: ${stop.extra.sample.map((s) => `"${s}"`).join(' · ')}`);
  if (stop.extra?.tail || error.tail) await state.emit('info', `Detalle técnico:\n${String(stop.extra?.tail ?? error.tail).slice(-1500)}`);
  // Un rollback fallido deja la solicitud desplegada (PROD no se tocó o se restauró parcialmente: se informa).
  const finalStatus = cfg.phase === 'rollback' ? 'deployed' : stop.status;
  const phaseStatus = { plan: ['planning'], develop: ['developing', 'queued'], deploy: ['deploying', 'approved'], rollback: ['rolling_back', 'rollback_approved'] }[cfg.phase];
  const ok = await state.update({ status: finalStatus, stage: finalStatus, error: { code: stop.code, message: stop.message }, tests: tests.length ? tests : undefined }, phaseStatus);
  if (!ok) console.error('No se pudo actualizar el estado final');
  process.exitCode = 1;
}
