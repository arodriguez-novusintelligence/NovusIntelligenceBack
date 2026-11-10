// Agentes de análisis/revisión del framework NADF ejecutados con la API de Claude (SDK oficial).
// Salida JSON estructurada; devuelve también uso de tokens para las métricas del nodo.
import Anthropic from '@anthropic-ai/sdk';

export function createLlm({ apiKey, model }) {
  const client = new Anthropic({ apiKey });

  async function json({ system, user, schema, maxTokens = 8000 }) {
    const started = Date.now();
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
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
        model,
        inputTokens,
        outputTokens,
        // Sin costo estimado: la API no lo entrega y no se inventan métricas.
        durationMs: Date.now() - started,
        requestId: res.id,
      },
    };
  }

  return { json };
}

export const SCHEMAS = {
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
      criterios_aceptacion: { type: 'array', items: { type: 'string' } },
      preguntas: { type: 'array', items: { type: 'string' } },
    },
    required: ['resumen', 'description', 'changeTypes', 'layers', 'backendRequired', 'frontendRequired', 'ambiguous', 'dominio', 'riesgo', 'criterios_aceptacion', 'preguntas'],
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
