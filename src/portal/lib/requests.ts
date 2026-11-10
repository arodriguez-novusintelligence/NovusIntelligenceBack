import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

/**
 * Ciclo de vida de una solicitud (pipeline PROD con revisión):
 * planning → planned (gate plan: «Ejecutar plan») → queued → developing → awaiting_approval → approved → deploying → deployed
 *                                                         ↘ no_changes | blocked | failed      ↘ rolled_back | blocked | failed
 * awaiting_approval → rejected | queued (pedir ajustes: nueva iteración)
 * deployed → rollback_requested → rollback_approved → rolling_back → rolled_back (o vuelve a deployed si falla)
 */
export type RequestStatus =
  | 'planning'
  | 'planned'
  | 'queued'
  | 'developing'
  | 'awaiting_approval'
  | 'approved'
  | 'deploying'
  | 'deployed'
  | 'rejected'
  | 'no_changes'
  | 'blocked'
  | 'failed'
  | 'rolled_back'
  | 'rollback_requested'
  | 'rollback_approved'
  | 'rolling_back'
  | 'stopped'
  | 'cancelled'
  | 'continuing';

export type Decision = 'approve' | 'reject' | 'changes' | 'approve_rollback' | 'reject_rollback' | 'accept_risk' | 'web_only';

/** Bloqueos que un aprobador puede aceptar (con MFA y justificación) y los que nunca se omiten. */
export const ACCEPTABLE_BLOCKS = ['REVIEW_BLOCKED', 'SECURITY_REVIEW_BLOCKED'];
export const NON_OVERRIDABLE_BLOCKS = ['PROD_DIFFERS_FROM_MAIN', 'PROD_CHANGED', 'MAIN_CHANGED', 'SECRET_IN_DIFF'];

export type NodeStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_DEPENDENCY'
  | 'WAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED'
  | 'CANCELLED'
  | 'BLOCKED';

export interface NodeAttempt {
  iteration: number;
  startedAt: string;
  endedAt?: string;
  status: NodeStatus;
  durationMs?: number;
  metrics?: Record<string, unknown>;
  output?: unknown;
  error?: { code: string; message: string };
  ioKey?: string;
}

export interface NodeState {
  status: NodeStatus;
  attempts: NodeAttempt[];
  startedAt?: string | null;
  endedAt?: string | null;
  lastEvent?: string;
  metrics?: Record<string, unknown>;
  ioKey?: string;
}

export interface WorkflowNode {
  id: string;
  agentId: string | null;
  label: string;
  role: string;
  kind: string;
  layer?: string | null;
  pattern?: string | null;
  model?: string | null;
  planned: 'run' | 'skip' | 'done' | 'conditional';
  reason?: string | null;
  definition?: Record<string, unknown> | null;
}

export interface Workflow {
  version: number;
  profile: string;
  level?: string;
  mode?: string;
  confidence?: number;
  rationale?: string[];
  blocked?: boolean;
  blockReason?: string | null;
  nodes: WorkflowNode[];
  edges: { id: string; source: string; target: string; label?: string | null }[];
  framework?: Record<string, unknown>;
  createdAt?: string;
  legacy?: boolean;
}

export interface RulesSnapshot {
  version: number;
  locked: boolean;
  lockedAt?: string;
  lockedBy?: Actor;
  nodes: Record<string, { mandatory: { text: string; source: string }[]; configurable: string[] }>;
  history: { version: number; at: string; by: string; nodeId?: string; before?: string[]; after?: string[]; note?: string }[];
}

export interface Actor {
  id: string;
  email: string;
  name?: string | null;
}

export interface RequestReport {
  titulo?: string;
  resumen?: string;
  hecho?: string[];
  no_hecho?: string[];
  limitaciones?: string[];
  preguntas?: string[];
  pruebas_sugeridas?: string[];
  rutas_a_revisar?: string[];
  riesgo?: string;
  archivos?: string[];
}

export interface TestResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'warning';
  detail?: string;
}

export interface Screenshot {
  key: string;
  label: string;
  kind?: string;
  route?: string;
}

export interface RequestRecord {
  requestId: string;
  companyId: string;
  appId: string;
  prompt: string;
  title?: string;
  status: RequestStatus;
  stage?: string;
  iteration: number;
  feedback?: { at: string; by: Actor; text: string }[];
  createdBy: Actor;
  createdAt: string;
  updatedAt: string;
  branch?: string;
  baseSha?: string;
  prodEtag?: string;
  prUrl?: string;
  prNumber?: number;
  previewUrl?: string;
  report?: RequestReport;
  tests?: TestResult[];
  screenshots?: Screenshot[];
  diffStat?: string;
  costUsd?: number;
  decision?: { by: Actor; at: string; decision: Decision; comment?: string };
  deployment?: {
    startedAt?: string;
    finishedAt?: string;
    invalidationId?: string;
    smoke?: TestResult[];
    screenshots?: Screenshot[];
    backupKey?: string;
    version?: string;
    mergeCommit?: string | null;
    [key: string]: unknown;
  };
  error?: { code: string; message: string } | null;
  buildId?: string;
  workflow?: Workflow;
  rules?: RulesSnapshot;
  nodeState?: Record<string, NodeState>;
  classification?: Record<string, unknown>;
  planApproval?: { by: Actor; at: string };
  flowTemplate?: { id: string; name: string; version: number; agents: string[] } | null;
  /** Archivos que complementan la solicitud (imágenes, .md, .txt, .docx). */
  attachments?: Attachment[];
  stopped?: { by: Actor; at: string; reason?: string; previousStatus: RequestStatus };
  /** Trabajo guardado en la rama cuando un revisor bloquea (permite aceptar el riesgo sin rehacer). */
  parked?: { code: string; nodeId: string; at: string; findings?: unknown };
  riskAcceptance?: { by: Actor; at: string; justification: string; code: string; nodeId: string; findings?: string };
  scopeOverride?: 'web_only';
  cancelled?: { by: Actor; at: string; reason?: string };
  rollback?: { requestedBy: Actor; requestedAt: string; reason: string; risks: string[]; approvedBy?: Actor; approvedAt?: string; rejectedBy?: Actor; finishedAt?: string; smoke?: TestResult[]; revertPrUrl?: string | null };
  headSha?: string;
  changedFiles?: string[];
}

export interface Attachment {
  key: string;
  name: string;
  contentType: string;
  size: number;
  kind: 'image' | 'text' | 'word' | 'pdf';
}

/** Tipos permitidos como complemento de la solicitud. */
export const ATTACHMENT_TYPES: Record<string, { kind: Attachment['kind']; ext: string[] }> = {
  'image/png': { kind: 'image', ext: ['png'] },
  'image/jpeg': { kind: 'image', ext: ['jpg', 'jpeg'] },
  'image/webp': { kind: 'image', ext: ['webp'] },
  'image/gif': { kind: 'image', ext: ['gif'] },
  'text/markdown': { kind: 'text', ext: ['md', 'markdown'] },
  'text/plain': { kind: 'text', ext: ['txt', 'md', 'markdown'] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { kind: 'word', ext: ['docx'] },
  'application/pdf': { kind: 'pdf', ext: ['pdf'] },
};
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Nombre seguro para la clave en S3 (sin rutas ni caracteres raros). */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'archivo';
  return base.normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').slice(-120) || 'archivo';
}

export interface RequestEvent {
  at: string;
  kind: 'info' | 'thought' | 'tool' | 'stage' | 'success' | 'warning' | 'error' | 'plan';
  nodeId?: string;
  eventType?: string;
  status?: string;
  text: string;
  stage?: string;
  seq?: number;
}

export const requestKeys = {
  request: (companyId: string, requestId: string) => ({ PK: `COMPANY#${companyId}`, SK: `REQ#${requestId}` }),
  eventsPk: (requestId: string) => `REQ#${requestId}`,
};

export interface RequestRepository {
  create(record: RequestRecord): Promise<void>;
  get(companyId: string, requestId: string): Promise<RequestRecord | null>;
  list(companyId: string): Promise<RequestRecord[]>;
  /** Actualiza solo si el estado actual es uno de `from` (evita dobles aprobaciones). */
  transition(companyId: string, requestId: string, from: RequestStatus[], patch: Partial<RequestRecord>): Promise<boolean>;
  events(requestId: string, after?: string): Promise<RequestEvent[]>;
  /** Actualiza el estado persistido de uno o más nodos (fuente de verdad del canvas). */
  setNodes(companyId: string, requestId: string, nodes: Record<string, NodeState>): Promise<void>;
  addEvent(requestId: string, event: RequestEvent): Promise<void>;
}

export function createRequestRepository(tableName: string, client?: DynamoDBDocumentClient): RequestRepository {
  const doc = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

  return {
    async create(record) {
      await doc.send(
        new PutCommand({
          TableName: tableName,
          Item: { ...requestKeys.request(record.companyId, record.requestId), entity: 'REQUEST', ...record },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      );
    },
    async get(companyId, requestId) {
      const out = await doc.send(new GetCommand({ TableName: tableName, Key: requestKeys.request(companyId, requestId), ConsistentRead: true }));
      return (out.Item as RequestRecord | undefined) ?? null;
    },
    async list(companyId) {
      const items: RequestRecord[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const out = await doc.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
            ExpressionAttributeValues: { ':pk': `COMPANY#${companyId}`, ':sk': 'REQ#' },
            ExclusiveStartKey: start,
          }),
        );
        items.push(...((out.Items as RequestRecord[]) ?? []));
        start = out.LastEvaluatedKey;
      } while (start && items.length < 500);
      return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async transition(companyId, requestId, from, patch) {
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
      const names: Record<string, string> = { '#status': 'status' };
      const values: Record<string, unknown> = {};
      from.forEach((s, i) => (values[`:from${i}`] = s));
      const sets = entries.map(([k, v], i) => {
        names[`#k${i}`] = k;
        values[`:v${i}`] = v;
        return `#k${i} = :v${i}`;
      });
      try {
        await doc.send(
          new UpdateCommand({
            TableName: tableName,
            Key: requestKeys.request(companyId, requestId),
            UpdateExpression: `SET ${sets.join(', ')}`,
            ConditionExpression: `attribute_exists(PK) AND #status IN (${from.map((_, i) => `:from${i}`).join(', ')})`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
        return true;
      } catch (error) {
        if ((error as Error).name === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    },
    async events(requestId, after) {
      const out = await doc.send(
        new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: after ? 'PK = :pk AND SK > :after' : 'PK = :pk AND begins_with(SK, :sk)',
          ExpressionAttributeValues: after
            ? { ':pk': requestKeys.eventsPk(requestId), ':after': `EVT#${after}` }
            : { ':pk': requestKeys.eventsPk(requestId), ':sk': 'EVT#' },
          Limit: 1000,
        }),
      );
      return ((out.Items ?? []) as (RequestEvent & { SK: string; PK: string })[]).map(({ SK, PK: _pk, ...e }) => ({ ...e, id: SK.slice(4) }));
    },
    async setNodes(companyId, requestId, nodes) {
      const entries = Object.entries(nodes);
      if (!entries.length) return;
      const names: Record<string, string> = { '#ns': 'nodeState' };
      const values: Record<string, unknown> = {};
      const sets = entries.map(([id, v], i) => {
        names[`#n${i}`] = id;
        values[`:n${i}`] = v;
        return `#ns.#n${i} = :n${i}`;
      });
      await doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: requestKeys.request(companyId, requestId),
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: 'attribute_exists(nodeState)',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
    },
    async addEvent(requestId, event) {
      const id = `${event.at}#${String(event.seq ?? 0).padStart(6, '0')}`;
      await doc.send(new PutCommand({ TableName: tableName, Item: { PK: requestKeys.eventsPk(requestId), SK: `EVT#${id}`, ...event } }));
    },
  };
}

/** Qué puede hacer cada decisión según el estado actual. */
export function decisionAllowed(status: RequestStatus, decision: Decision): boolean {
  if (decision === 'approve') return status === 'awaiting_approval';
  if (decision === 'approve_rollback' || decision === 'reject_rollback') return status === 'rollback_requested';
  if (decision === 'accept_risk' || decision === 'web_only') return status === 'blocked';
  if (decision === 'reject') return status === 'awaiting_approval' || status === 'no_changes' || status === 'blocked' || status === 'failed';
  // Pedir ajustes / reintentar: tras el informe, si no hubo cambios, si PROD cambió o si algo falló.
  return ['awaiting_approval', 'no_changes', 'blocked', 'failed', 'rolled_back'].includes(status);
}

export const TERMINAL: RequestStatus[] = ['deployed', 'rejected'];

export function sanitizePrompt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\r\n/g, '\n').trim();
  if (text.length < 10 || text.length > 6000) return null;
  return text;
}
