// Ejecuta procesos sin shell, con salida en vivo por líneas y sin imprimir argumentos (pueden llevar secretos).
import { spawn } from 'node:child_process';

export function run(cmd, args, { cwd, env, onLine, timeoutMs = 30 * 60 * 1000, input, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let buffer = '';
    const keep = (chunk) => {
      out += chunk;
      if (out.length > 400_000) out = out.slice(-300_000);
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!quiet) process.stdout.write(`${line}\n`);
        if (onLine) {
          try {
            onLine(line);
          } catch (error) {
            console.error('onLine error', error);
          }
        }
      }
    };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);
    if (input) {
      child.stdin.end(input);
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(Object.assign(new Error(`${cmd} superó el tiempo máximo`), { code: 'TIMEOUT', out }));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buffer && onLine) onLine(buffer);
      resolve({ code, out });
    });
  });
}

export async function must(cmd, args, opts = {}) {
  const res = await run(cmd, args, opts);
  if (res.code !== 0) {
    const tail = res.out.split('\n').slice(-25).join('\n');
    throw Object.assign(new Error(`${opts.label ?? cmd} falló (código ${res.code})`), { code: opts.errorCode ?? 'COMMAND_FAILED', tail });
  }
  return res;
}
