// Comparación PROD vs main por cadenas de interfaz del bundle (los hashes de los chunks cambian entre máquinas).
// También arma el index.html de la vista previa.
import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

const REF = /["'`]((?:\.{1,2}\/|\/)?[\w@./-]*?[\w-]+\.(?:js|mjs))["'`]/g;

function candidates(fromKey, ref) {
  const dir = posix.dirname(fromKey);
  if (ref.startsWith('/')) return [ref.slice(1)];
  if (ref.startsWith('./') || ref.startsWith('../')) return [posix.normalize(posix.join(dir === '.' ? '' : dir, ref))];
  return [posix.normalize(ref), posix.normalize(posix.join(dir === '.' ? '' : dir, ref))];
}

export function entryScripts(indexHtml) {
  const refs = new Set();
  for (const m of indexHtml.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+\.(?:js|mjs))"/g)) {
    if (!/^https?:/.test(m[1])) refs.add(m[1].replace(/^\//, ''));
  }
  return [...refs];
}

/** Recorre el grafo de JS desde el index (fetch(key) → texto o null). */
export async function crawl(indexHtml, fetch, limit = 4000) {
  const seen = new Map();
  const queue = entryScripts(indexHtml);
  while (queue.length && seen.size < limit) {
    const key = queue.shift();
    if (seen.has(key)) continue;
    const text = await fetch(key);
    if (text == null) continue;
    seen.set(key, text);
    for (const m of text.matchAll(REF)) {
      for (const c of candidates(key, m[1])) {
        if (!c.startsWith('..') && !seen.has(c)) queue.push(c);
      }
    }
  }
  return seen;
}

export const localFetcher = (root) => async (key) => {
  try {
    return await readFile(join(root, key), 'utf8');
  } catch {
    return null;
  }
};

const LITERAL = /"((?:[^"\\\n]|\\.){6,280})"|'((?:[^'\\\n]|\\.){6,280})'|`((?:[^`\\]|\\.){6,280})`/g;

/** Cadenas con forma de texto de interfaz (palabras con espacios, sin sintaxis de código). */
export function uiStrings(files) {
  const out = new Set();
  for (const text of files.values()) {
    for (const m of text.matchAll(LITERAL)) {
      const raw = m[1] ?? m[2] ?? m[3] ?? '';
      for (const part of raw.split(/\$\{[^}]*\}/)) {
        // \r: los builds hechos en Windows conservan CRLF dentro de plantillas; no es una diferencia real.
        const s = part.replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim();
        if (s.length < 8 || s.length > 240) continue;
        if (!/[a-záéíóúñ]{3,}\s+[a-záéíóúñ]{2,}/i.test(s)) continue;
        // Fragmentos de código minificado (cambian con cualquier diff): fuera; solo textos de interfaz.
        if (/=>|[{};<>=&|$`[\]\\]|\w\(|\)\.|^[,.):]|\bfunction\b|https?:\/\//.test(s)) continue;
        out.add(s);
      }
    }
  }
  return out;
}

export function diffStrings(prod, local) {
  return [...prod].filter((s) => !local.has(s));
}

/**
 * Index de la vista previa: igual al build, pero arranca la app después de recibir la sesión del portal
 * (postMessage desde orígenes permitidos) y abre la ruta pedida. Nunca reemplaza el index público.
 */
export function previewIndex(indexHtml, allowedOrigins) {
  const modules = [];
  const html = indexHtml.replace(/<script\s+type="module"[^>]*\ssrc="([^"]+)"[^>]*><\/script>\s*/g, (_, src) => {
    modules.push(src);
    return '';
  });
  const boot = `<script>
(function(){
  var ALLOWED=${JSON.stringify(allowedOrigins)};
  var MODULES=${JSON.stringify(modules)};
  var q=new URLSearchParams(location.search);
  var ruta=q.get('ruta')||'/';
  if(ruta.charAt(0)!=='/'||ruta.indexOf('//')===0) ruta='/';
  var started=false;
  function boot(){ if(started) return; started=true; try{history.replaceState(null,'',ruta);}catch(e){}
    MODULES.forEach(function(s){var el=document.createElement('script');el.type='module';el.src=s;document.head.appendChild(el);}); }
  function setSession(m){ try{ localStorage.setItem('doevents_auth_token',m.token); localStorage.setItem('doevents_user_id',m.userId);
    if(m.platformRole){localStorage.setItem('doevents_platform_role',String(m.platformRole).toLowerCase());} }catch(e){} }
  if(window.parent!==window){
    window.addEventListener('message',function(e){
      if(ALLOWED.indexOf(e.origin)<0||!e.data||e.data.type!=='nadf-session') return;
      if(e.data.token&&e.data.userId) setSession(e.data);
      boot();
    });
    try{ ALLOWED.forEach(function(o){ window.parent.postMessage({type:'nadf-preview-ready'},o); }); }catch(e){}
    setTimeout(boot,8000);
  } else { boot(); }
})();
</script>`;
  return { html: html.replace(/<head>/i, `<head>\n<meta name="robots" content="noindex">\n${boot}`), modules };
}
