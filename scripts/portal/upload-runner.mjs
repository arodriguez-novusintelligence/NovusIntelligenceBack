// Empaqueta runner/ (sin node_modules) y lo sube al bucket de evidencias: s3://<evidence>/runner/runner.tgz
// Uso: node scripts/portal/upload-runner.mjs --stage dev
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stage = process.argv.includes('--stage') ? process.argv[process.argv.indexOf('--stage') + 1] : 'dev';
const region = 'sa-east-1';
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' }).trim();
const bucket = sh('aws', [
  'cloudformation', 'describe-stacks', '--region', region, '--stack-name', `nadf-portal-${stage}`,
  '--query', '"Stacks[0].Outputs[?OutputKey==`EvidenceBucketName`].OutputValue"', '--output', 'text',
]);
const dir = mkdtempSync(join(tmpdir(), 'nadf-runner-'));
const file = join(dir, 'runner.tgz');
try {
  execFileSync('tar', ['-czf', file, '--exclude', 'node_modules', '-C', 'runner', '.'], { stdio: 'inherit' });
  sh('aws', ['s3', 'cp', file, `s3://${bucket}/runner/runner.tgz`, '--region', region, '--quiet']);
  console.log(`runner subido a s3://${bucket}/runner/runner.tgz`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
