// NADF runner — pipeline PROD con revisión humana.
//   develop: clona main → verifica PROD == main → Claude Code desarrolla → build/lint → vista previa oculta en PROD
//            (sin tocar el index público) → capturas logueado → PR → espera aprobación.
//   deploy:  (solo tras aprobación con MFA) verifica que PROD y main no cambiaron → respalda → publica el build revisado
//            → invalida CDN → prueba de humo → rollback automático si falla → merge del PR.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { appSession, capture } from './lib/browser.mjs';
import { diffStrings, crawl, localFetcher, previewIndex, uiStrings, entryScripts } from './lib/bundle.mjs';
import { runClaude } from './lib/claude.mjs';
import { api, gitAuthArgs, installationToken } from './lib/github.mjs';
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
import { createState } from './lib/state.mjs';

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
  work: join(process.env.CODEBUILD_SRC_DIR || '/tmp', 'nadf-work'),
  runnerDir: new URL('.', import.meta.url).pathname,
};

const s3 = new S3Client({});
const sm = new SecretsManagerClient({});
const state = createState({ table: cfg.table, companyId: cfg.companyId, requestId: cfg.requestId });
const repoDir = join(cfg.work, 'repo');
const prefix = `requests/${cfg.requestId}/${cfg.iteration}`;
const tests = [];

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

// ---------------------------------------------------------------- develop

async function develop() {
  const req = await state.get();
  if (req.iteration !== cfg.iteration) return console.log('Ejecución obsoleta (iteración distinta); se ignora.');
  if (!(await state.update({ status: 'developing', stage: 'preparing', error: null }, ['queued']))) {
    return console.log('La solicitud ya no está en cola; se ignora.');
  }
  await state.emit('stage', cfg.iteration > 1 ? `Iteración ${cfg.iteration}: retomo el trabajo con tus comentarios.` : 'Preparando un entorno aislado para trabajar.');

  const [claudeKey, ghApp, envProd, appUser] = await Promise.all([
    secret('/nadf/platform/claude-api-key'),
    secret('/nadf/platform/github-app', true),
    secret(`/nadf/${cfg.companyId}/web-env-prod`),
    secret(cfg.app.previewUserSecret, true),
  ]);
  const { owner, name, defaultBranch, installationId } = cfg.app.repo;
  const ghToken = await installationToken(ghApp, installationId, name);
  const auth = gitAuthArgs(ghToken);
  const branch = `nadf/req-${cfg.requestId.slice(0, 8)}`;

  await rm(cfg.work, { recursive: true, force: true });
  await mkdir(cfg.work, { recursive: true });
  await state.setStage('cloning', `Clonando ${owner}/${name} (${defaultBranch}) con el conector GitHub de NADF.`);
  await must('git', [...auth, 'clone', '--filter=blob:none', '--branch', defaultBranch, `https://github.com/${owner}/${name}.git`, repoDir], {
    cwd: cfg.work,
    quiet: true,
    label: 'git clone',
    errorCode: 'REPO_CLONE_FAILED',
  });
  const baseSha = (await git(['rev-parse', 'HEAD'])).out.trim();
  await writeFile(join(repoDir, '.env.prod'), envProd);
  await state.emit('info', `Código base: ${defaultBranch} @ ${baseSha.slice(0, 7)}.`);

  await state.setStage('installing', 'Instalando dependencias (npm ci).');
  await must('npm', ['ci', '--no-audit', '--no-fund'], { cwd: repoDir, quiet: true, label: 'npm ci', timeoutMs: 20 * 60 * 1000, errorCode: 'INSTALL_FAILED' });

  // ---- Preflight: PROD debe ser igual a main (otros despliegan PROD con frecuencia).
  await state.setStage('preflight', 'Verificando que PROD coincide con main antes de tocar nada.');
  const readCreds = await assumeProd(cfg.app, `nadf-pre-${cfg.requestId.slice(0, 8)}`, previewPolicy(cfg.app.prod.bucket));
  const clients = prodClients(cfg.app, readCreds);
  const last = await lastInvalidation(clients.cloudtrail, cfg.app.prod.distributionId);
  if (last) await state.emit('info', `Último despliegue de PROD: ${last.by} el ${last.at}.`);
  await buildProd('Build de main');
  const localIndex = await readFile(join(repoDir, 'packages/shell/dist/index.html'), 'utf8');
  const localFiles = await crawl(localIndex, localFetcher(join(repoDir, 'packages/shell/dist')));
  const prod = await prodStrings(clients);
  const onlyProd = diffStrings(prod.strings, uiStrings(localFiles));
  console.log(`preflight: prod ${prod.files} js / ${prod.strings.size} textos; main ${localFiles.size} js; solo en PROD: ${onlyProd.length}`);
  if (onlyProd.length > 0) {
    await putEvidence(`${prefix}/preflight-solo-en-prod.json`, JSON.stringify(onlyProd, null, 2), 'application/json');
    throw new Stop(
      'blocked',
      'PROD_DIFFERS_FROM_MAIN',
      `PROD tiene ${onlyProd.length} textos que no están en main (alguien desplegó código sin publicar${last ? `; último despliegue: ${last.by}` : ''}). Desplegar desde main revertiría esos cambios: pide que publiquen su rama en main y luego reintenta.`,
      { sample: onlyProd.slice(0, 8) },
    );
  }
  tests.push({ name: 'PROD coincide con main antes de empezar', status: 'passed', detail: `${prod.files} archivos JS comparados` });
  await state.emit('success', 'PROD coincide con main. Puedo trabajar sobre main con seguridad.');
  const lintBefore = lintCount((await run('npm', ['run', 'lint'], { cwd: repoDir, quiet: true, timeoutMs: 15 * 60 * 1000 })).out);

  // ---- Rama de trabajo
  const remoteBranch = (await run('git', [...auth, 'ls-remote', '--heads', 'origin', branch], { cwd: repoDir, quiet: true })).out.trim();
  if (remoteBranch) {
    await git([...auth, 'fetch', 'origin', `${branch}:${branch}`]);
    await git(['checkout', branch]);
    const merged = await run('git', ['-c', 'user.name=NADF', '-c', 'user.email=nadf@novusintelligencesolutions.com', 'merge', '--no-edit', `origin/${defaultBranch}`], { cwd: repoDir, quiet: true });
    if (merged.code !== 0) throw new Stop('failed', 'MERGE_CONFLICT', 'La rama de trabajo tiene conflictos con main. Hay que crear una solicitud nueva.');
  } else {
    await git(['checkout', '-b', branch]);
  }

  // ---- Claude Code
  await state.setStage('developing', 'Claude está entendiendo tu solicitud y revisando el código.');
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
  const system = [
    `Eres el agente de desarrollo de NADF (Novus Intelligence Solutions) trabajando en el repositorio real de ${cfg.app.name} (${owner}/${name}), una app React + Vite con workspaces (packages/shared, packages/shell, packages/mfe-auth).`,
    'Reglas obligatorias:',
    '- Implementa SOLO lo que pide la solicitud, con el cambio más pequeño y seguro. Sin refactors, sin renombrar, sin borrar funciones que no se piden.',
    '- Antes de editar lee las reglas del repo: CLAUDE.md si existe y las carpetas ReglasAgente/ y reglasActuacion/.',
    '- No modifiques .env*, infrastructure/, .github/, scripts de despliegue ni package-lock.json (no agregues dependencias salvo que sea imprescindible).',
    '- No hagas commit, push ni despliegues: NADF lo hace después de la revisión humana.',
    '- Este cambio irá a PRODUCCIÓN tras la aprobación: textos en español correcto (con tildes), vista móvil y escritorio, sin romper flujos existentes.',
    '- Si la solicitud es ambigua o no se puede hacer de forma segura, no inventes: deja el código sin cambios y explica en el informe, con preguntas concretas.',
    '- Antes de terminar ejecuta `npm run build:prod` y corrige cualquier error.',
    `- AL TERMINAR escribe nadf-report.json en la raíz del repo con este formato (JSON válido, en español): ${JSON.stringify(reportSchema)}`,
    `- En "rutas_a_revisar" pon hasta 4 rutas de la app (path, p. ej. "/eventos") donde el aprobador ve el cambio; la vista previa abre logueada con un usuario admin de la plataforma.`,
  ].join('\n');
  const feedback = (req.feedback ?? []).map((f) => `- ${f.by?.name ?? f.by?.email ?? 'Revisor'}: ${f.text}`).join('\n');
  const prompt = [
    `Solicitud de ${req.createdBy?.name ?? req.createdBy?.email} para ${cfg.app.name}:`,
    '"""',
    req.prompt,
    '"""',
    cfg.iteration > 1
      ? [
          `\nEsta es la iteración ${cfg.iteration}. La rama ${branch} ya tiene trabajo previo (revisa \`git log origin/${defaultBranch}..HEAD\` y \`git diff origin/${defaultBranch}\`).`,
          req.report ? `Informe anterior: ${JSON.stringify(req.report)}` : '',
          feedback ? `Comentarios del revisor que debes atender:\n${feedback}` : 'El revisor pidió reintentar.',
        ].join('\n')
      : '',
  ].join('\n');
  const claude = await runClaude({ cwd: repoDir, prompt, system, model: cfg.model, budgetUsd: cfg.budgetUsd, apiKey: claudeKey, emit: state.emit });
  console.log(`claude: exit=${claude.exitCode} subtype=${claude.subtype} cost=${claude.costUsd} turns=${claude.turns}`);
  if (!claude.ok && claude.subtype !== 'error_max_budget_usd') {
    throw new Stop('failed', 'AGENT_FAILED', 'Claude no pudo terminar el desarrollo.', { tail: claude.tail });
  }
  if (claude.subtype === 'error_max_budget_usd') await state.emit('warning', `Se alcanzó el presupuesto de ${cfg.budgetUsd} USD de esta ejecución.`);

  let report = {};
  const reportPath = join(repoDir, 'nadf-report.json');
  if (existsSync(reportPath)) {
    try {
      report = JSON.parse(await readFile(reportPath, 'utf8'));
    } catch {
      await state.emit('warning', 'El informe del agente no era JSON válido; uso su mensaje final.');
    }
    await rm(reportPath, { force: true });
  }
  if (!report.resumen) report.resumen = claude.text.slice(0, 2000);

  // ---- Guardas de alcance: rutas prohibidas se revierten.
  const changed = (await git(['status', '--porcelain'])).out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).split(' -> ').pop().replace(/^"|"$/g, ''));
  const forbidden = changed.filter((p) => /^(\.env|infrastructure\/|\.github\/|scripts\/deploy|.*deploy-.*\.ps1$)/.test(p) || p === 'package-lock.json');
  for (const p of forbidden) {
    await run('git', ['checkout', '--', p], { cwd: repoDir, quiet: true });
    await run('git', ['clean', '-f', '--', p], { cwd: repoDir, quiet: true });
  }
  if (forbidden.length) await state.emit('warning', `Revertí cambios en archivos protegidos: ${forbidden.join(', ')}.`);
  await writeFile(join(repoDir, '.env.prod'), envProd);
  const files = changed.filter((p) => !forbidden.includes(p) && p !== '.env.prod' && p !== 'nadf-report.json');

  const ahead = remoteBranch ? (await git(['rev-list', '--count', `origin/${defaultBranch}..HEAD`])).out.trim() : '0';
  if (!files.length && ahead === '0') {
    await state.update({
      status: 'no_changes',
      stage: 'done',
      title: report.titulo ?? req.title,
      report,
      tests,
      costUsd: (req.costUsd ?? 0) + (claude.costUsd ?? 0),
    });
    await state.emit('warning', 'El agente no hizo cambios en el código. Revisa su informe y sus preguntas.');
    return;
  }

  // ---- Pruebas
  await state.setStage('testing', `Probando el cambio (${files.length} archivo${files.length === 1 ? '' : 's'}).`);
  await buildProd('Build con los cambios');
  tests.push({ name: 'Compilación de producción (npm run build:prod)', status: 'passed' });
  const lintAfter = lintCount((await run('npm', ['run', 'lint'], { cwd: repoDir, quiet: true, timeoutMs: 15 * 60 * 1000 })).out);
  tests.push({
    name: 'Lint',
    status: lintAfter > lintBefore ? 'warning' : 'passed',
    detail: lintAfter > lintBefore ? `El cambio agrega ${lintAfter - lintBefore} errores de lint (había ${lintBefore}).` : `Sin errores nuevos (el repo ya tenía ${lintBefore}).`,
  });
  tests.push({ name: 'Pruebas unitarias', status: 'skipped', detail: 'El repositorio no tiene un script de pruebas unitarias (npm test).' });

  // ---- Vista previa oculta en PROD (mismo dominio, mismos datos; el index público no cambia).
  await state.setStage('preview', 'Publicando una vista previa privada (los usuarios siguen viendo la versión actual).');
  const pid = `${cfg.requestId}-${cfg.iteration}`;
  const previewKey = `__nadf/preview/${pid}/index.html`;
  const previewUrl = `${cfg.app.prod.url}/${previewKey}`;
  const shellDist = join(repoDir, 'packages/shell/dist');
  const builtIndex = await readFile(join(shellDist, 'index.html'), 'utf8');
  const preview = previewIndex(builtIndex, cfg.origins);
  const up = await uploadPreview(clients.s3, cfg.app.prod.bucket, shellDist, previewKey, preview.html);
  await state.emit('info', `Vista previa lista (${up.uploaded} archivos nuevos, ${up.skipped} ya existían).`);
  await must('tar', ['-czf', join(cfg.work, 'dist.tgz'), 'packages/shell/dist', 'packages/mfe-auth/dist'], { cwd: repoDir, quiet: true, label: 'empaquetado' });
  await putEvidence(`${prefix}/dist.tgz`, await readFile(join(cfg.work, 'dist.tgz')), 'application/gzip');

  await state.setStage('screenshots', 'Abriendo la vista previa con el usuario admin de la app para tomar capturas.');
  const session = await appSession(cfg.app.apiBaseUrl, appUser);
  const routes = [...new Set((report.rutas_a_revisar ?? []).filter((r) => typeof r === 'string' && r.startsWith('/')).slice(0, 4))];
  if (!routes.length) routes.push('/');
  const views = [...routes.map((route) => ({ route, label: `${route} · escritorio`, mobile: false })), { route: routes[0], label: `${routes[0]} · móvil`, mobile: true }];
  const shots = await capture({
    cwd: cfg.runnerDir,
    origin: new URL(cfg.app.prod.url).origin,
    session,
    urlFor: (route) => `${previewUrl}?ruta=${encodeURIComponent(route)}`,
    views,
    outDir: join(cfg.work, 'shots'),
  });
  const screenshots = [];
  for (const shot of shots) {
    const key = `${prefix}/capturas/${shot.file.split('/').pop()}`;
    if (existsSync(shot.file)) {
      await putEvidence(key, await readFile(shot.file), 'image/png');
      screenshots.push({ key, label: shot.label });
    }
    tests.push({
      name: `Vista previa ${shot.label}`,
      status: shot.loaded ? (shot.errors.length ? 'warning' : 'passed') : 'failed',
      detail: shot.errors.length ? shot.errors.slice(0, 3).join(' | ') : 'Carga sin errores, con sesión de admin.',
    });
    await state.emit(shot.loaded ? 'success' : 'warning', `Captura ${shot.label}: ${shot.loaded ? 'cargó' : 'no cargó'}${shot.errors.length ? ` (${shot.errors.length} avisos en consola)` : ''}.`);
  }

  // ---- Commit, push y PR
  await state.setStage('pr', 'Guardando el cambio en una rama y abriendo el pull request.');
  await git(['add', '-A', '--', ...files.map((f) => f.replace(/\/$/, ''))]);
  const title = (report.titulo || req.prompt.split('\n')[0]).slice(0, 90);
  const hasStaged = (await run('git', ['diff', '--cached', '--quiet'], { cwd: repoDir, quiet: true })).code !== 0;
  if (hasStaged) {
    await git([
      '-c', 'user.name=NADF · Novus Intelligence',
      '-c', 'user.email=nadf@novusintelligencesolutions.com',
      'commit', '-m',
      `nadf: ${title}\n\nSolicitud ${cfg.requestId} (iteración ${cfg.iteration}) desde el portal NADF.\nPedida por: ${req.createdBy?.name ?? req.createdBy?.email}\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
    ]);
  }
  await git([...auth, 'push', 'origin', `HEAD:refs/heads/${branch}`], { errorCode: 'REPO_PUSH_DENIED' });
  const diffStat = (await git(['diff', '--stat', `origin/${defaultBranch}...HEAD`])).out.trim().split('\n').slice(-12).join('\n');

  const list = (items) => (items?.length ? items.map((i) => `- ${i}`).join('\n') : '- (nada)');
  const prBody = [
    `**Solicitud NADF** \`${cfg.requestId}\` · iteración ${cfg.iteration} · pedida por ${req.createdBy?.name ?? req.createdBy?.email}`,
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
  const pr = existing.length
    ? await api(`/repos/${owner}/${name}/pulls/${existing[0].number}`, ghToken, { method: 'PATCH', body: { title: `NADF: ${title}`, body: prBody } })
    : await api(`/repos/${owner}/${name}/pulls`, ghToken, { method: 'POST', body: { title: `NADF: ${title}`, head: branch, base: defaultBranch, body: prBody } });

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
    prodEtag: prod.index.etag,
    diffStat,
    costUsd: Math.round(((req.costUsd ?? 0) + (claude.costUsd ?? 0)) * 100) / 100,
  });
  await state.emit('success', `Listo para tu revisión. Abre la vista previa, revisa el informe y aprueba el despliegue a PROD. PR #${pr.number}.`);
}

// ---------------------------------------------------------------- deploy

async function deploy() {
  const req = await state.get();
  if (!(await state.update({ status: 'deploying', stage: 'deploy_checks', deployment: { startedAt: new Date().toISOString() } }, ['approved']))) {
    return console.log('La solicitud no está aprobada; se ignora.');
  }
  await state.emit('stage', `Despliegue a PROD aprobado por ${req.decision?.by?.name ?? req.decision?.by?.email}. Verificando que nada cambió desde la revisión.`);
  const [ghApp, appUser] = await Promise.all([secret('/nadf/platform/github-app', true), secret(cfg.app.previewUserSecret, true)]);
  const { owner, name, defaultBranch, installationId } = cfg.app.repo;
  const ghToken = await installationToken(ghApp, installationId, name);

  const creds = await assumeProd(cfg.app, `nadf-deploy-${cfg.requestId.slice(0, 8)}`);
  const clients = prodClients(cfg.app, creds);
  const bucket = cfg.app.prod.bucket;
  const current = await getText(clients.s3, bucket, 'index.html');
  if (!current || current.etag !== req.prodEtag) {
    const last = await lastInvalidation(clients.cloudtrail, cfg.app.prod.distributionId);
    throw new Stop('blocked', 'PROD_CHANGED', `PROD cambió desde la revisión${last ? ` (último despliegue: ${last.by}, ${last.at})` : ''}. Para no revertir ese cambio, pide ajustes/reintento: NADF rehace el build sobre lo nuevo.`);
  }
  const mainRef = await api(`/repos/${owner}/${name}/git/ref/heads/${defaultBranch}`, ghToken);
  if (mainRef.object.sha !== req.baseSha) {
    throw new Stop('blocked', 'MAIN_CHANGED', `main avanzó desde la revisión (${req.baseSha.slice(0, 7)} → ${mainRef.object.sha.slice(0, 7)}). Reintenta para incluir esos cambios antes de desplegar.`);
  }
  await state.emit('success', 'PROD y main siguen iguales a lo revisado.');

  // Build exacto que se revisó.
  await rm(cfg.work, { recursive: true, force: true });
  await mkdir(cfg.work, { recursive: true });
  const tgz = await s3.send(new GetObjectCommand({ Bucket: cfg.evidence, Key: `${prefix}/dist.tgz` }));
  await writeFile(join(cfg.work, 'dist.tgz'), Buffer.from(await tgz.Body.transformToByteArray()));
  await must('tar', ['-xzf', 'dist.tgz'], { cwd: cfg.work, quiet: true, label: 'desempaquetado' });
  const shellDist = join(cfg.work, 'packages/shell/dist');
  const authDist = join(cfg.work, 'packages/mfe-auth/dist');
  const newIndex = await readFile(join(shellDist, 'index.html'), 'utf8');

  // Respaldo para rollback.
  const backupAuth = await getText(clients.s3, bucket, 'mfe-auth/index.html');
  await putEvidence(`${prefix}/respaldo/index.html`, current.body, 'text/html; charset=utf-8');
  if (backupAuth) await putEvidence(`${prefix}/respaldo/mfe-auth-index.html`, backupAuth.body, 'text/html; charset=utf-8');
  await state.emit('info', 'Respaldé la versión actual de PROD para poder volver atrás.');

  const rollback = async (why) => {
    await state.emit('error', `${why} Vuelvo a la versión anterior.`);
    await put(clients.s3, bucket, 'index.html', current.body, 'public, max-age=0, must-revalidate');
    if (backupAuth) await put(clients.s3, bucket, 'mfe-auth/index.html', backupAuth.body, 'public, max-age=0, must-revalidate');
    const id = await invalidate(clients.cloudfront, cfg.app.prod.distributionId, `nadf-rollback-${cfg.requestId}-${Date.now()}`);
    await waitInvalidation(clients.cloudfront, cfg.app.prod.distributionId, id);
    await state.emit('warning', 'PROD volvió a la versión anterior.');
  };

  await state.setStage('deploying', 'Publicando en PROD (primero los archivos nuevos, al final el index).');
  const plan = await uploadPlan(shellDist, existsSync(authDist) ? authDist : null);
  let invalidationId = null;
  if (cfg.dryRun) {
    await state.emit('warning', `Modo prueba: se subirían ${plan.length} archivos; no se publica nada.`);
  } else {
    await uploadAll(clients.s3, bucket, plan, (done, total) => state.emit('info', `Subidos ${done} de ${total} archivos.`));
    await state.emit('info', `Publicados ${plan.length} archivos. Limpiando la caché del CDN.`);
    invalidationId = await invalidate(clients.cloudfront, cfg.app.prod.distributionId, `nadf-${cfg.requestId}-${Date.now()}`);
    if (!(await waitInvalidation(clients.cloudfront, cfg.app.prod.distributionId, invalidationId))) {
      await state.emit('warning', 'La caché del CDN tarda más de lo normal; sigo con las pruebas.');
    }
  }

  // Prueba de humo sobre PROD real (cualquier error aquí también vuelve atrás).
  try {
    await verifyAndFinish();
  } catch (error) {
    if (cfg.dryRun) throw error;
    await rollback(`La verificación de PROD falló (${error.message}).`);
    throw new Stop('rolled_back', 'SMOKE_FAILED', 'PROD no pasó la verificación y se volvió a la versión anterior.');
  }

  async function verifyAndFinish() {
  await state.setStage('verifying', 'Verificando PROD con el usuario admin de la app.');
  const smoke = [];
  const live = await fetch(`${cfg.app.prod.url}/?nadf=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } }).then((r) => r.text());
  const expected = entryScripts(newIndex);
  const served = cfg.dryRun || expected.every((s) => live.includes(s));
  smoke.push({ name: 'PROD sirve la versión nueva', status: served ? 'passed' : 'failed', detail: served ? (cfg.dryRun ? 'Modo prueba' : 'index.html nuevo en el CDN') : 'El CDN aún sirve la versión anterior' });
  const session = await appSession(cfg.app.apiBaseUrl, appUser);
  const routes = [...new Set(['/', ...(req.report?.rutas_a_revisar ?? []).filter((r) => typeof r === 'string' && r.startsWith('/'))])].slice(0, 4);
  const shots = await capture({
    cwd: cfg.runnerDir,
    origin: new URL(cfg.app.prod.url).origin,
    session,
    urlFor: (route) => `${cfg.app.prod.url}${route}`,
    views: routes.map((route) => ({ route, label: `PROD ${route}`, mobile: false })),
    outDir: join(cfg.work, 'shots-prod'),
  });
  const deployShots = [];
  for (const shot of shots) {
    const key = `${prefix}/prod/${shot.file.split('/').pop()}`;
    if (existsSync(shot.file)) {
      await putEvidence(key, await readFile(shot.file), 'image/png');
      deployShots.push({ key, label: shot.label });
    }
    smoke.push({ name: shot.label, status: shot.loaded ? (shot.errors.length ? 'warning' : 'passed') : 'failed', detail: shot.errors.slice(0, 3).join(' | ') || 'Carga correcta con sesión de admin.' });
  }
  const broken = !served || shots.some((s) => !s.loaded);
  if (broken && !cfg.dryRun) {
    await rollback('La verificación de PROD falló.');
    await state.update({
      status: 'rolled_back',
      stage: 'rolled_back',
      deployment: { ...(req.deployment ?? {}), startedAt: req.deployment?.startedAt, finishedAt: new Date().toISOString(), invalidationId, smoke, screenshots: deployShots },
      error: { code: 'SMOKE_FAILED', message: 'PROD no pasó la verificación y se volvió a la versión anterior.' },
    });
    return;
  }

  // Merge del PR: main queda igual a PROD.
  let merged = false;
  if (!cfg.dryRun && req.prNumber) {
    try {
      await api(`/repos/${owner}/${name}/pulls/${req.prNumber}/merge`, ghToken, {
        method: 'PUT',
        body: { merge_method: 'merge', commit_title: `Merge NADF: ${req.title ?? req.requestId} (#${req.prNumber})`, sha: undefined },
      });
      merged = true;
      await state.emit('success', `PR #${req.prNumber} fusionado en main: main queda igual a PROD.`);
    } catch (error) {
      await state.emit('warning', `Desplegado, pero no pude fusionar el PR #${req.prNumber} (${error.message}). Fusiónalo pronto: otros despliegan desde main.`);
    }
  }
  await state.update({
    status: cfg.dryRun ? 'awaiting_approval' : 'deployed',
    stage: cfg.dryRun ? 'awaiting_approval' : 'deployed',
    deployment: { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), invalidationId, smoke, screenshots: deployShots, merged },
  });
  await state.emit('success', cfg.dryRun ? 'Modo prueba completado (no se publicó nada).' : `Desplegado en PROD: ${cfg.app.prod.url}`);
  }
}

// ---------------------------------------------------------------- main

try {
  if (cfg.phase === 'develop') await develop();
  else if (cfg.phase === 'deploy') await deploy();
  else throw new Error(`Fase desconocida: ${cfg.phase}`);
} catch (error) {
  const stop = error instanceof Stop ? error : new Stop('failed', error.code ?? 'RUNNER_ERROR', 'Ocurrió un error inesperado en el agente.');
  console.error(error);
  if (error.tail || stop.extra?.tail) console.error(error.tail ?? stop.extra.tail);
  await state.emit(stop.status === 'blocked' ? 'warning' : 'error', stop.message);
  if (stop.extra?.sample) await state.emit('info', `Ejemplos: ${stop.extra.sample.map((s) => `"${s}"`).join(' · ')}`);
  if (stop.extra?.tail || error.tail) await state.emit('info', `Detalle técnico:\n${String(stop.extra?.tail ?? error.tail).slice(-1500)}`);
  const ok = await state.update({ status: stop.status, stage: stop.status, error: { code: stop.code, message: stop.message }, tests: tests.length ? tests : undefined });
  if (!ok) console.error('No se pudo actualizar el estado final');
  process.exitCode = 1;
}
