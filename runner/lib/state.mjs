// Estado de la solicitud, de cada nodo del plan y consola en vivo (DynamoDB nadf-portal-{stage}).
// El backend es la fuente de verdad: el portal reconstruye el workflow solo con lo que aquí se persiste.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

/** Estados de nodo (contrato con el portal). */
export const NODE = {
  PENDING: 'PENDING',
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  WAITING_DEPENDENCY: 'WAITING_DEPENDENCY',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
  CANCELLED: 'CANCELLED',
  BLOCKED: 'BLOCKED',
};

const EVENT_FOR = {
  RUNNING: 'AGENT_STARTED',
  COMPLETED: 'AGENT_COMPLETED',
  FAILED: 'AGENT_FAILED',
  SKIPPED: 'AGENT_SKIPPED',
  BLOCKED: 'AGENT_BLOCKED',
  WAITING_APPROVAL: 'APPROVAL_REQUESTED',
  QUEUED: 'AGENT_QUEUED',
  CANCELLED: 'AGENT_CANCELLED',
  WAITING_DEPENDENCY: 'AGENT_WAITING',
};

export function createState({ table, companyId, requestId, iteration = 1, buildId = null }) {
  const key = { PK: `COMPANY#${companyId}`, SK: `REQ#${requestId}` };
  let seq = 0;
  let stage = 'preparing';
  let current = null;
  let nodes = {};

  async function emit(kind, text, extra = {}) {
    const at = new Date().toISOString();
    seq += 1;
    const clean = String(text).replace(/x-access-token:[^@\s]+/g, 'x-access-token:***').replace(/sk-ant-[\w-]+/g, 'sk-ant-***').slice(0, 1800);
    const nodeId = extra.nodeId ?? current ?? undefined;
    console.log(`[${kind}]${nodeId ? `[${nodeId}]` : ''} ${clean}`);
    try {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: {
            PK: `REQ#${requestId}`,
            SK: `EVT#${at}#${String(seq).padStart(6, '0')}`,
            at,
            seq,
            kind,
            text: clean,
            stage,
            executionId: buildId ?? undefined,
            iteration,
            eventType: extra.eventType ?? (kind === 'tool' ? 'TOOL_USED' : kind === 'thought' ? 'AGENT_MESSAGE' : 'LOG'),
            ...extra,
            nodeId,
          },
        }),
      );
    } catch (error) {
      console.error('No se pudo registrar el evento', error.message);
    }
  }

  async function get() {
    const out = await doc.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
    if (!out.Item) throw Object.assign(new Error('Solicitud no encontrada'), { code: 'REQUEST_NOT_FOUND' });
    nodes = out.Item.nodeState ?? {};
    return out.Item;
  }

  async function update(patch, from) {
    const entries = Object.entries({ ...patch, updatedAt: new Date().toISOString() }).filter(([, v]) => v !== undefined);
    const names = {};
    const values = {};
    const sets = entries.map(([k, v], i) => {
      names[`#k${i}`] = k;
      values[`:v${i}`] = v;
      return `#k${i} = :v${i}`;
    });
    let condition = 'attribute_exists(PK)';
    if (from?.length) {
      names['#st'] = 'status';
      from.forEach((s, i) => (values[`:f${i}`] = s));
      condition += ` AND #st IN (${from.map((_, i) => `:f${i}`).join(', ')})`;
    }
    try {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: key,
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
      return true;
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }

  async function saveNode(id) {
    try {
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: key,
          UpdateExpression: 'SET nodeState.#n = :v, updatedAt = :u',
          ConditionExpression: 'attribute_exists(nodeState)',
          ExpressionAttributeNames: { '#n': id },
          ExpressionAttributeValues: { ':v': nodes[id], ':u': new Date().toISOString() },
        }),
      );
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      await update({ nodeState: nodes });
    }
  }

  const ensure = (id) => (nodes[id] ??= { status: NODE.PENDING, attempts: [] });

  /** Inicia un nodo: nuevo intento (las iteraciones y reintentos quedan visibles). */
  async function nodeStart(id, text, { input } = {}) {
    const n = ensure(id);
    const startedAt = new Date().toISOString();
    n.attempts = [...(n.attempts ?? []), { iteration, startedAt, status: NODE.RUNNING, input }];
    n.status = NODE.RUNNING;
    n.startedAt = startedAt;
    n.endedAt = null;
    n.lastEvent = text;
    current = id;
    await saveNode(id);
    await emit('stage', text, { nodeId: id, eventType: 'AGENT_STARTED', status: NODE.RUNNING });
  }

  /** Cierra el intento actual con su resultado real. */
  async function nodeEnd(id, status, text, { metrics, output, error, ioKey } = {}) {
    const n = ensure(id);
    const endedAt = new Date().toISOString();
    const attempt = n.attempts?.[n.attempts.length - 1];
    if (attempt && attempt.status === NODE.RUNNING) {
      Object.assign(attempt, { status, endedAt, durationMs: Date.parse(endedAt) - Date.parse(attempt.startedAt), metrics, output, error, ioKey });
    }
    Object.assign(n, { status, endedAt, lastEvent: text, metrics: metrics ?? n.metrics, ioKey: ioKey ?? n.ioKey });
    if (current === id) current = null;
    await saveNode(id);
    const kind = status === NODE.FAILED ? 'error' : status === NODE.BLOCKED ? 'warning' : status === NODE.COMPLETED ? 'success' : 'info';
    await emit(kind, text, { nodeId: id, eventType: EVENT_FOR[status] ?? 'AGENT_UPDATED', status });
  }

  /** Cambia el estado sin intento (omitido, en cola, esperando aprobación...). */
  async function nodeSet(id, status, text) {
    const n = ensure(id);
    n.status = status;
    n.lastEvent = text ?? n.lastEvent;
    if (status === NODE.SKIPPED || status === NODE.CANCELLED) n.endedAt = new Date().toISOString();
    await saveNode(id);
    if (text) await emit(status === NODE.WAITING_APPROVAL ? 'stage' : 'info', text, { nodeId: id, eventType: EVENT_FOR[status] ?? 'AGENT_UPDATED', status });
  }

  /** Emisor ligado a un nodo (para ramas paralelas y para la consola de Claude Code). */
  const emitter = (id) => (kind, text, extra = {}) => emit(kind, text, { ...extra, nodeId: id });

  async function setStage(next, text) {
    stage = next;
    await update({ stage: next });
    if (text) await emit('stage', text);
  }

  return {
    emit,
    emitter,
    get,
    update,
    setStage,
    nodeStart,
    nodeEnd,
    nodeSet,
    nodeStatus: (id) => nodes[id]?.status ?? null,
    initNodes: (map) => {
      nodes = map;
    },
    get nodes() {
      return nodes;
    },
    get stage() {
      return stage;
    },
  };
}
