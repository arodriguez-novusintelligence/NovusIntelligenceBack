import type { NodeState } from './requests';

/**
 * Tarifa oficial de la API de Claude (USD por millón de tokens), consultada 2026-11-10 en
 * https://platform.claude.com/docs/en/about-claude/pricing. Se usa solo cuando una ejecución antigua
 * no guardó su costo; las nuevas lo guardan por llamada (Claude Code reporta el suyo).
 */
export const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

interface Metrics {
  model?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
}

/** Costo de un intento: el registrado; si falta, estimado con tokens y tarifa (sin caché, cota superior). */
export function attemptCost(m?: Metrics): { usd: number; estimated: boolean } {
  if (!m) return { usd: 0, estimated: false };
  if (typeof m.costUsd === 'number') return { usd: m.costUsd, estimated: false };
  const model = String(m.model ?? '').split(' ')[0];
  const price = PRICING[model];
  if (!price || (!m.inputTokens && !m.outputTokens)) return { usd: 0, estimated: false };
  return { usd: ((m.inputTokens ?? 0) * price.input + (m.outputTokens ?? 0) * price.output) / 1e6, estimated: true };
}

/** Costo acumulado de una solicitud (todas las iteraciones y nodos). */
export function requestCost(nodeState?: Record<string, NodeState>): { usd: number; estimated: boolean } {
  let usd = 0;
  let estimated = false;
  for (const st of Object.values(nodeState ?? {})) {
    for (const a of st.attempts ?? []) {
      const c = attemptCost(a.metrics as Metrics);
      usd += c.usd;
      estimated ||= c.estimated && c.usd > 0;
    }
  }
  return { usd: Math.round(usd * 100) / 100, estimated };
}
