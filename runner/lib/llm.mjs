// Agentes de análisis/revisión del framework NADF ejecutados con la API de Claude (SDK oficial).
// Salida JSON estructurada; devuelve también uso de tokens para las métricas del nodo.
import Anthropic from '@anthropic-ai/sdk';

/** Costo de una llamada con la tarifa oficial (USD por millón de tokens). */
export function costOf(usage, price) {
  if (!price || !usage) return null;
  const usd =
    ((usage.input_tokens ?? 0) * price.input +
      (usage.cache_creation_input_tokens ?? 0) * price.cache_write +
      (usage.cache_read_input_tokens ?? 0) * price.cache_read +
      (usage.output_tokens ?? 0) * price.output) /
    1e6;
  return Math.round(usd * 10000) / 10000;
}

export function createLlm({ apiKey, model, pricing = {} }) {
  const client = new Anthropic({ apiKey });

  async function json({ system, user, blocks = [], schema, maxTokens = 8000, model: override }) {
    const started = Date.now();
    const useModel = override ?? model;
    const res = await client.messages.create({
      model: useModel,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: blocks.length ? [...blocks, { type: 'text', text: user }] : user }],
      output_config: { format: { type: 'json_schema', schema } },
    });
    if (res.stop_reason === 'refusal') throw Object.assign(new Error('El modelo rechazó la tarea.'), { code: 'AGENT_REFUSED' });
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const m = /\{[\s\S]*\}/.exec(text);
      if (!m) throw Object.assign(new Error('Respuesta del agente sin JSON válido.'), { code: 'AGENT_BAD_OUTPUT' });
      data = JSON.parse(m[0]);
    }
    const usage = res.usage ?? {};
    const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    const outputTokens = usage.output_tokens ?? 0;
    return {
      data,
      metrics: {
        model: useModel,
        inputTokens,
        outputTokens,
        // Costo calculado con la tarifa oficial publicada (agent-policy.yml → pricing).
        costUsd: costOf(usage, pricing[useModel]),
        costSource: pricing[useModel] ? 'tarifa oficial' : null,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        durationMs: Date.now() - started,
        requestId: res.id,
      },
    };
  }

  return { json };
}

const REVIEW = {
  type: 'object',
  additionalProperties: false,
  properties: {
    veredicto: { type: 'string', enum: ['aprobado', 'con_observaciones', 'bloqueante'] },
    hallazgos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { severidad: { type: 'string', enum: ['baja', 'media', 'alta'] }, archivo: { type: 'string' }, detalle: { type: 'string' } },
        required: ['severidad', 'archivo', 'detalle'],
      },
    },
    resumen: { type: 'string' },
  },
  required: ['veredicto', 'hallazgos', 'resumen'],
};

export const SCHEMAS = {
  /** Seguridad + Revisor en una sola llamada (el diff se envía una vez). */
  combinedReview: { type: 'object', additionalProperties: false, properties: { seguridad: REVIEW, revision: REVIEW }, required: ['seguridad', 'revision'] },
  classification: {
    type: 'object',
    additionalProperties: false,
    properties: {
      resumen: { type: 'string' },
      description: { type: 'string' },
      changeTypes: { type: 'array', items: { type: 'string' } },
      layers: { type: 'array', items: { type: 'string' } },
      backendRequired: { type: 'boolean' },
      frontendRequired: { type: 'boolean' },
      ambiguous: { type: 'boolean' },
      dominio: { type: 'string' },
      riesgo: { type: 'string', enum: ['bajo', 'medio', 'alto'] },
      naturaleza: { type: 'string', enum: ['ajuste_visual', 'evolutivo', 'nueva_funcionalidad', 'cambio_arquitectonico'] },
      tamano: { type: 'string', enum: ['pequena', 'grande'] },
      ambito_critico: { type: 'boolean' },
      motivo_critico: { type: 'string' },
      archivos_candidatos: { type: 'array', items: { type: 'string' } },
      criterios_aceptacion: { type: 'array', items: { type: 'string' } },
      preguntas: { type: 'array', items: { type: 'string' } },
    },
    required: ['resumen', 'description', 'changeTypes', 'layers', 'backendRequired', 'frontendRequired', 'ambiguous', 'dominio', 'riesgo', 'naturaleza', 'tamano', 'ambito_critico', 'motivo_critico', 'archivos_candidatos', 'criterios_aceptacion', 'preguntas'],
  },
  plan: {
    type: 'object',
    additionalProperties: false,
    properties: {
      pasos: { type: 'array', items: { type: 'string' } },
      archivos_candidatos: { type: 'array', items: { type: 'string' } },
      riesgos: { type: 'array', items: { type: 'string' } },
    },
    required: ['pasos', 'archivos_candidatos', 'riesgos'],
  },
  design: {
    type: 'object',
    additionalProperties: false,
    properties: {
      diseño: { type: 'string' },
      decisiones: { type: 'array', items: { type: 'string' } },
      impacto: { type: 'array', items: { type: 'string' } },
    },
    required: ['diseño', 'decisiones', 'impacto'],
  },
  review: {
    type: 'object',
    additionalProperties: false,
    properties: {
      veredicto: { type: 'string', enum: ['aprobado', 'con_observaciones', 'bloqueante'] },
      hallazgos: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { severidad: { type: 'string', enum: ['baja', 'media', 'alta'] }, archivo: { type: 'string' }, detalle: { type: 'string' } },
          required: ['severidad', 'archivo', 'detalle'],
        },
      },
      resumen: { type: 'string' },
    },
    required: ['veredicto', 'hallazgos', 'resumen'],
  },
};
