import { describe, expect, it } from 'vitest';
import { attemptCost, requestCost } from './cost';

describe('costo acumulado', () => {
  it('usa el costo registrado (Claude Code o tarifa al momento)', () => {
    expect(attemptCost({ model: 'claude-opus-5-5', inputTokens: 999, costUsd: 1.85 })).toEqual({ usd: 1.85, estimated: false });
  });
  it('estima con tokens y tarifa oficial cuando falta (ejecuciones antiguas)', () => {
    expect(attemptCost({ model: 'claude-opus-5-5', inputTokens: 1_000_000, outputTokens: 100_000 })).toEqual({ usd: 6, estimated: true });
    expect(attemptCost({ model: 'claude-opus-5-5 (Claude Code)', inputTokens: 0, outputTokens: 0 })).toEqual({ usd: 0, estimated: false });
  });
  it('suma todas las iteraciones y nodos', () => {
    const ns = {
      dev: { status: 'COMPLETED', attempts: [{ iteration: 1, startedAt: 'x', status: 'COMPLETED', metrics: { costUsd: 1.85 } }, { iteration: 2, startedAt: 'x', status: 'COMPLETED', metrics: { costUsd: 2.36 } }] },
      an: { status: 'COMPLETED', attempts: [{ iteration: 1, startedAt: 'x', status: 'COMPLETED', metrics: { model: 'claude-opus-5-5', inputTokens: 3158, outputTokens: 2152 } }] },
    } as never;
    const c = requestCost(ns);
    expect(c.usd).toBe(4.27);
    expect(c.estimated).toBe(true);
  });
});
