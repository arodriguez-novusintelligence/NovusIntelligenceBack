// Mapa compacto del repositorio por versión de main (SHA), para que los agentes vayan directo a los archivos
// relevantes en lugar de explorar todo el repo (el mayor consumo de tokens del Desarrollador).
// Se construye con la API de GitHub (sin clonar) y se guarda en S3: una sola vez por SHA.
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { api } from './github.mjs';

const SOURCE = /\.(tsx?|jsx?|mjs|css|scss)$/;
const SKIP = /(^|\/)(node_modules|dist|build|coverage|\.git|__tests__|__mocks__|test|tests|e2e|stories|public|assets)\//;
const SKIP_FILE = /\.(test|spec|stories|d)\.[tj]sx?$/;
const ROUTE_FILE = /(^|\/)(App|AppRoutes|routes|router|Routes)\.(tsx|jsx|ts|js)$/;

/** Archivos fuente relevantes a partir del árbol de git (sin pruebas, builds ni assets). */
export function sourceFiles(tree) {
  return tree
    .filter((t) => t.type === 'blob' && SOURCE.test(t.path) && !SKIP.test(t.path) && !SKIP_FILE.test(t.path))
    .map((t) => ({ path: t.path, size: t.size ?? 0 }));
}

/** Agrupa por carpeta en líneas compactas: "carpeta/: ArchivoA, ArchivoB(…)" para caber en pocos tokens. */
export function compactTree(files, maxChars = 24_000) {
  const byDir = new Map();
  for (const f of files) {
    const i = f.path.lastIndexOf('/');
    const dir = i >= 0 ? f.path.slice(0, i) : '.';
    const base = f.path.slice(i + 1).replace(/\.(tsx?|jsx?|mjs)$/, '');
    byDir.set(dir, [...(byDir.get(dir) ?? []), base]);
  }
  const lines = [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dir, names]) => `${dir}/: ${names.sort().join(', ')}`);
  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 > maxChars) {
      out += `… (${lines.length} carpetas en total; mapa recortado)`;
      break;
    }
    out += `${line}\n`;
  }
  return out.trim();
}

/** Rutas de la app (react-router): path → componente. */
export function extractRoutes(source) {
  const routes = [];
  const re = /<Route\b[^>]*?\bpath=["'{`]+([^"'`}]+)["'`}]+[^>]*?\belement=\{\s*<\s*([A-Z][\w.]*)/g;
  for (const m of source.matchAll(re)) routes.push({ path: m[1], component: m[2] });
  const re2 = /\{\s*path:\s*["'`]([^"'`]+)["'`][^}]*?(?:element|Component):\s*<?\s*([A-Z][\w.]*)/g;
  for (const m of source.matchAll(re2)) routes.push({ path: m[1], component: m[2] });
  return routes;
}

/** Mapa del repo para un SHA, con caché en S3 (repomap/<owner>/<repo>/<sha>.json). */
export async function repoMap({ s3, bucket, ghToken, owner, name, sha, maxChars }) {
  const key = `repomap/${owner}/${name}/${sha}.json`;
  try {
    const cached = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return { ...JSON.parse(await cached.Body.transformToString('utf-8')), cached: true };
  } catch {
    // no está en caché: se construye
  }
  const tree = await api(`/repos/${owner}/${name}/git/trees/${sha}?recursive=1`, ghToken);
  const files = sourceFiles(tree.tree ?? []);
  const routes = [];
  for (const f of files.filter((x) => ROUTE_FILE.test(x.path)).slice(0, 6)) {
    const blob = await api(`/repos/${owner}/${name}/contents/${encodeURIComponent(f.path).replace(/%2F/g, '/')}?ref=${sha}`, ghToken).catch(() => null);
    if (blob?.content) routes.push(...extractRoutes(Buffer.from(blob.content, 'base64').toString('utf8')).map((r) => ({ ...r, file: f.path })));
  }
  const map = {
    sha,
    files: files.map((f) => f.path),
    compact: compactTree(files, maxChars),
    routes: routes.slice(0, 200),
    truncatedTree: Boolean(tree.truncated),
    builtAt: new Date().toISOString(),
  };
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(map), ContentType: 'application/json' }));
  return { ...map, cached: false };
}

/** Texto del mapa para los prompts. */
export function mapText(map) {
  if (!map) return '';
  const routes = map.routes?.length ? `Rutas de la app (path → componente):\n${map.routes.map((r) => `${r.path} → ${r.component}`).join('\n')}\n\n` : '';
  return `${routes}Estructura del código (carpeta: archivos):\n${map.compact}`;
}

/** Solo candidatos que existen de verdad en el repo (el modelo puede inventar rutas). */
export function validCandidates(candidates, map, max = 12) {
  if (!Array.isArray(candidates) || !map?.files?.length) return [];
  const set = new Set(map.files);
  const out = [];
  for (const c of candidates) {
    const path = String(c).trim().replace(/^\.?\//, '');
    if (set.has(path) && !out.includes(path)) out.push(path);
    if (out.length >= max) break;
  }
  return out;
}
