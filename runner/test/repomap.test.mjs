import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactTree, extractRoutes, mapText, sourceFiles, validCandidates } from '../lib/repomap.mjs';

const tree = [
  { type: 'blob', path: 'packages/shell/src/App.tsx', size: 4000 },
  { type: 'blob', path: 'packages/shell/src/pages/admin/AdminUsersPage.tsx', size: 9000 },
  { type: 'blob', path: 'packages/shell/src/pages/admin/AdminUsersPage.test.tsx', size: 900 },
  { type: 'blob', path: 'packages/shell/src/lovable/components/home/HeroBanner.tsx', size: 3000 },
  { type: 'blob', path: 'packages/shell/dist/assets/index-abc.js', size: 90000 },
  { type: 'blob', path: 'packages/shell/node_modules/x/index.js', size: 10 },
  { type: 'blob', path: 'packages/shell/public/logo.png', size: 10 },
  { type: 'blob', path: 'packages/shared/src/api/billingService.ts', size: 5000 },
  { type: 'tree', path: 'packages/shared/src' },
  { type: 'blob', path: 'README.md', size: 10 },
];

test('solo archivos fuente relevantes (sin pruebas, builds, assets ni node_modules)', () => {
  const files = sourceFiles(tree).map((f) => f.path);
  assert.deepEqual(files.sort(), [
    'packages/shared/src/api/billingService.ts',
    'packages/shell/src/App.tsx',
    'packages/shell/src/lovable/components/home/HeroBanner.tsx',
    'packages/shell/src/pages/admin/AdminUsersPage.tsx',
  ]);
});

test('mapa compacto por carpeta y recortado al límite', () => {
  const c = compactTree(sourceFiles(tree));
  assert.match(c, /packages\/shell\/src\/pages\/admin\/: AdminUsersPage/);
  assert.match(c, /packages\/shared\/src\/api\/: billingService/);
  const many = Array.from({ length: 500 }, (_, i) => ({ path: `packages/a/src/d${i}/Comp${i}.tsx` }));
  assert.ok(compactTree(many, 2000).length <= 2100);
  assert.match(compactTree(many, 2000), /mapa recortado/);
});

test('extrae rutas de react-router (JSX y objetos)', () => {
  const src = `<Route path="/admin/users" element={<AdminUsersPage />} />
    <Route path='/' element={ <HomePage/> } />
    const r = [{ path: '/eventos', element: <EventsPage /> }];`;
  assert.deepEqual(extractRoutes(src), [
    { path: '/admin/users', component: 'AdminUsersPage' },
    { path: '/', component: 'HomePage' },
    { path: '/eventos', component: 'EventsPage' },
  ]);
});

test('candidatos: solo rutas que existen, sin duplicados y con tope', () => {
  const map = { files: sourceFiles(tree).map((f) => f.path) };
  assert.deepEqual(validCandidates(['./packages/shell/src/App.tsx', 'inventado/Foo.tsx', 'packages/shell/src/App.tsx', 'packages/shared/src/api/billingService.ts'], map), [
    'packages/shell/src/App.tsx',
    'packages/shared/src/api/billingService.ts',
  ]);
  assert.deepEqual(validCandidates(null, map), []);
});

test('texto del mapa incluye rutas y estructura', () => {
  const t = mapText({ compact: 'a/: B', routes: [{ path: '/x', component: 'X' }] });
  assert.match(t, /\/x → X/);
  assert.match(t, /a\/: B/);
  assert.equal(mapText(null), '');
});
