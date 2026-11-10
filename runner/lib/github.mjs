// GitHub App NADF: token de instalación y API (sin imprimir secretos).
import { createSign } from 'node:crypto';

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

export function appJwt(app) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: String(app.app_id) })}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(app.private_key, 'base64url')}`;
}

export async function api(path, token, { method = 'GET', body, ok404 = false } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nadf-runner',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (ok404 && res.status === 404) return null;
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw Object.assign(new Error(`GitHub ${method} ${path.split('?')[0]} → ${res.status}: ${json.message ?? ''}`), { code: 'GITHUB_API', status: res.status });
  }
  return json;
}

export async function installationToken(app, installationId, repoName) {
  const out = await api(`/app/installations/${installationId}/access_tokens`, appJwt(app), {
    method: 'POST',
    body: { repositories: [repoName] },
  });
  return out.token;
}

/** Cabecera para git sin dejar el token en .git/config ni en la URL. */
export function gitAuthArgs(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`];
}
