// Pruebas del plan con las definiciones REALES del framework (runner/vendor, generado con --vendor-only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, rulesFor, validateRules } from '../lib/framework.mjs';
import { decideComplexity } from '../vendor/routing.mjs';

const plan = (signals) => buildPlan(decideComplexity(signals), { projectId: 'doevents', appLayers: ['frontend'], model: 'claude-opus-5-5' });
const node = (p, id) => p.nodes.find((n) => n.id === id);

test('caso obligatorio: color del banner → TRIVIAL_VISUAL, sin Arquitecto', () => {
  const p = plan({ description: 'Cambiar el color del banner principal de morado a azul', changeTypes: ['color', 'banner'], layers: ['frontend'], backendRequired: false, frontendRequired: true, ambiguous: false });
  assert.equal(p.profile, 'TRIVIAL_VISUAL');
  assert.equal(p.blocked, false);
  assert.equal(node(p, 'architect-agent').planned, 'skip');
  assert.match(node(p, 'architect-agent').reason, /TRIVIAL_VISUAL/);
  assert.equal(node(p, 'planner-agent').planned, 'skip');
  assert.equal(node(p, 'frontend-integration-agent').planned, 'run');
  assert.equal(node(p, 'qa-agent').planned, 'run');
  assert.equal(node(p, 'security-gate').planned, 'run');
  assert.equal(node(p, 'security-agent').planned, 'skip');
  assert.equal(node(p, 'human-approval').planned, 'run');
});

test('cambio crítico → FULL con Planificador, Arquitecto, Seguridad y Revisor; validación en paralelo', () => {
  const p = plan({ description: 'Agregar validación de autenticación en el checkout de pagos', changeTypes: ['business_logic'], layers: ['frontend'], ambiguous: false });
  assert.equal(p.profile, 'FULL');
  for (const id of ['planner-agent', 'architect-agent', 'security-agent', 'reviewer-agent']) assert.equal(node(p, id).planned, 'run', id);
  const fromPreview = p.edges.filter((e) => e.source === 'preview').map((e) => e.target).sort();
  assert.deepEqual(fromPreview, ['qa-agent', 'security-agent', 'security-gate']);
  assert.ok(p.edges.some((e) => e.source === 'security-agent' && e.target === 'reviewer-agent'));
  assert.equal(node(p, 'backend-agent').planned, 'skip');
});

test('solicitud ambigua → BLOCKED: no se desarrolla', () => {
  const p = plan({ description: 'algo ambiguo', changeTypes: [], ambiguous: true });
  assert.equal(p.profile, 'BLOCKED');
  assert.equal(p.blocked, true);
  assert.equal(node(p, 'frontend-integration-agent').planned, 'skip');
  assert.equal(node(p, 'human-approval').planned, 'skip');
});

test('solo backend en una app solo frontend → bloqueado con motivo', () => {
  const p = plan({ description: 'consulta de lectura', changeTypes: ['query'], layers: ['backend'], backendRequired: true, frontendRequired: false });
  assert.equal(p.profile, 'LIGHTWEIGHT_BACKEND');
  assert.equal(p.blocked, true);
  assert.match(p.blockReason, /backend/);
});

test('todas las aristas apuntan a nodos existentes y no hay ids repetidos', () => {
  const p = plan({ description: 'Agregar validación de autenticación', changeTypes: ['component'] });
  const ids = new Set(p.nodes.map((n) => n.id));
  assert.equal(ids.size, p.nodes.length);
  for (const e of p.edges) assert.ok(ids.has(e.source) && ids.has(e.target), e.id);
});

test('reglas: obligatorias del framework y configurables por defecto', () => {
  const p = plan({ description: 'Cambiar color', changeTypes: ['color'] });
  const r = rulesFor(p, 'doevents');
  const dev = r['frontend-integration-agent'];
  assert.ok(dev.mandatory.some((m) => m.text.includes('deploy') && m.source.includes('skill-registry')));
  assert.ok(dev.mandatory.some((m) => m.source === 'Plataforma NADF'));
  assert.ok(dev.configurable.length >= 3);
  assert.deepEqual(r.request.mandatory, []);
});

test('validación de reglas configurables', () => {
  assert.equal(validateRules(['Usar el azul de la marca']), null);
  assert.match(validateRules(['Desplegar directamente sin aprobación']), /política obligatoria/);
  assert.match(validateRules(Array(21).fill('x')), /Máximo/);
  assert.match(validateRules(['']), /vacía/);
});
