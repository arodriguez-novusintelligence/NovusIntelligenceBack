// Empaqueta runner/ (sin node_modules) + las definiciones REALES del framework NADF y lo sube a
// s3://<evidence>/runner/runner.tgz. Nada del framework se reescribe: se copian los YAML/MD y se
// compila tal cual el enrutador de complejidad (prototypes/m6-cloud-agent/src/complexity-routing).
// Uso: node scripts/portal/upload-runner.mjs --stage dev [--framework <ruta>]
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const stage = arg('--stage', 'dev');
const framework = arg('--framework', process.env.NADF_FRAMEWORK_DIR || 'C:/NovusIntelligence/NADF/NovusAIDevelopmentFramework');
const region = 'sa-east-1';
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts }).trim();

const vendorOnly = process.argv.includes('--vendor-only');
const bucket = vendorOnly ? null : sh('aws', [
  'cloudformation', 'describe-stacks', '--region', region, '--stack-name', `nadf-portal-${stage}`,
  '--query', '"Stacks[0].Outputs[?OutputKey==`EvidenceBucketName`].OutputValue"', '--output', 'text',
]);

const dir = mkdtempSync(join(tmpdir(), 'nadf-runner-'));
// --vendor-only: prepara runner/vendor en local (para pruebas) y no sube nada.
const stageDir = vendorOnly ? 'runner' : join(dir, 'runner');
try {
  if (!vendorOnly) cpSync('runner', stageDir, { recursive: true, filter: (src) => !src.includes('node_modules') });
  const vendor = join(stageDir, 'vendor');
  rmSync(vendor, { recursive: true, force: true });
  mkdirSync(join(vendor, 'framework'), { recursive: true });

  // 1) Enrutador de complejidad del framework, compilado sin cambios.
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
    'esbuild', join(framework, 'prototypes/m6-cloud-agent/src/complexity-routing/index.ts'),
    '--bundle', '--format=esm', '--platform=node', `--outfile=${join(vendor, 'routing.mjs')}`, '--log-level=warning',
  ], { stdio: 'inherit', shell: process.platform === 'win32' });

  // 2) Definiciones declarativas (agentes, perfiles, reglas, gobierno, proyecto).
  const copy = (rel) => cpSync(join(framework, rel), join(vendor, 'framework', rel), { recursive: true });
  for (const rel of [
    '.claude/agents',
    '.nadf/global/skill-registry',
    '.nadf/global/complexity-routing',
    '.nadf/global/rules',
    'enterprise-governance/human-approval-model.yml',
    'enterprise-governance/agent-selection.yml',
    'enterprise-governance/complexity-routing.yml',
    '.nadf/projects/doevents',
  ]) copy(rel);

  const sha = sh('git', ['-C', framework, 'rev-parse', 'HEAD']);
  const branch = sh('git', ['-C', framework, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = sh('git', ['-C', framework, 'status', '--porcelain']).length > 0;
  writeFileSync(join(vendor, 'manifest.json'), JSON.stringify({
    repo: 'NovusAIDevelopmentFramework', sha, branch, dirty, packagedAt: new Date().toISOString(),
    agents: readdirSync(join(vendor, 'framework/.claude/agents')).length,
  }, null, 2));

  // 3) Catálogo de agentes para el portal (definición real + explicación) → runner/catalog.json.
  const catalogFile = join(dir, 'catalog.json');
  // El catálogo se genera con el runner local (tiene node_modules) sobre el vendor recién armado.
  if (!vendorOnly) {
    rmSync(resolve('runner/vendor'), { recursive: true, force: true });
    cpSync(vendor, resolve('runner/vendor'), { recursive: true });
  }
  const { buildCatalog } = await import(pathToFileURL(resolve('runner/lib/catalog.mjs')).href);
  writeFileSync(catalogFile, JSON.stringify(buildCatalog()));
  writeFileSync(resolve('runner/vendor/catalog.json'), JSON.stringify(buildCatalog(), null, 2));
  if (!vendorOnly) sh('aws', ['s3', 'cp', catalogFile, `s3://${bucket}/runner/catalog.json`, '--region', region, '--quiet', '--content-type', 'application/json']);

  if (vendorOnly) {
    console.log(`vendor listo en runner/vendor (framework ${branch}@${sha.slice(0, 7)})`);
    process.exit(0);
  }
  const file = join(dir, 'runner.tgz');
  execFileSync('tar', ['-czf', file, '-C', stageDir, '.'], { stdio: 'inherit' });
  sh('aws', ['s3', 'cp', file, `s3://${bucket}/runner/runner.tgz`, '--region', region, '--quiet']);
  console.log(`runner + framework ${branch}@${sha.slice(0, 7)}${dirty ? ' (con cambios locales)' : ''} subido a s3://${bucket}/runner/runner.tgz`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
