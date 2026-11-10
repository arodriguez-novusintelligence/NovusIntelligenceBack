// Capturas y prueba de humo con Playwright, con la sesión del usuario admin de la app.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { must } from './sh.mjs';

let installed = false;

export async function ensureBrowser(cwd) {
  if (installed) return;
  await must('npx', ['playwright', 'install', '--with-deps', 'chromium'], { cwd, label: 'Instalación del navegador', timeoutMs: 10 * 60 * 1000, quiet: true });
  installed = true;
}

export async function appSession(apiBaseUrl, cred) {
  const res = await fetch(`${apiBaseUrl}/login/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email: cred.email, password: cred.password }),
  });
  const json = await res.json().catch(() => ({}));
  const token = json?.data?.token;
  const userId = json?.data?.user?.userId;
  if (!res.ok || !token || !userId) throw Object.assign(new Error(`No se pudo iniciar sesión con el usuario de la app (HTTP ${res.status})`), { code: 'APP_LOGIN_FAILED' });
  return { token, userId, platformRole: json.data.user.platformRole ?? 'admin' };
}

const NOISE = [/favicon/i, /ERR_BLOCKED_BY_CLIENT/i, /google-analytics|googletagmanager|facebook\.net|hotjar/i, /Failed to load resource: the server responded with a status of 40[134]/i];

/**
 * Abre cada ruta (urlFor(ruta)) logueado y devuelve capturas + errores.
 * views: [{ route, label, mobile }]
 */
export async function capture({ cwd, origin, session, urlFor, views, outDir }) {
  await ensureBrowser(cwd);
  const { chromium } = await import('playwright');
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const [i, view] of views.entries()) {
      const context = await browser.newContext(
        view.mobile
          ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'es-CO' }
          : { viewport: { width: 1440, height: 900 }, locale: 'es-CO' },
      );
      await context.addInitScript(
        ({ o, s }) => {
          try {
            if (location.origin === o) {
              localStorage.setItem('doevents_auth_token', s.token);
              localStorage.setItem('doevents_user_id', s.userId);
              localStorage.setItem('doevents_platform_role', String(s.platformRole || 'admin').toLowerCase());
            }
          } catch {
            /* sin almacenamiento */
          }
        },
        { o: origin, s: session },
      );
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(`Error de la página: ${e.message}`.slice(0, 300)));
      page.on('console', (m) => {
        if (m.type() === 'error' && !NOISE.some((n) => n.test(m.text()))) errors.push(m.text().slice(0, 300));
      });
      let loaded = true;
      try {
        await page.goto(urlFor(view.route), { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForFunction(() => (document.getElementById('root')?.children.length ?? 0) > 0, null, { timeout: 30_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(2500);
      } catch (error) {
        loaded = false;
        errors.unshift(`La pantalla no cargó: ${error.message.split('\n')[0]}`);
      }
      const rendered = await page.evaluate(() => (document.getElementById('root')?.innerText ?? '').trim().length).catch(() => 0);
      const file = join(outDir, `${String(i + 1).padStart(2, '0')}-${view.mobile ? 'movil' : 'escritorio'}.png`);
      await page.screenshot({ path: file, fullPage: false }).catch(() => {});
      results.push({ ...view, file, loaded: loaded && rendered > 0, finalUrl: page.url(), errors: errors.slice(0, 8) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  return results;
}
