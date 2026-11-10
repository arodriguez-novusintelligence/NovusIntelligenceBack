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
 * queued → developing → awaiting_approval → approved → deploying → deployed
 *                     ↘ no_changes | blocked | failed      ↘ rolled_back | blocked | failed
 * awaiting_approval → rejected | queued (pedir ajustes: nueva iteración)
 */
export type RequestStatus =
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
  | 'rolled_back';

export type Decision = 'approve' | 'reject' | 'changes';

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
  deployment?: { startedAt?: string; finishedAt?: string; invalidationId?: string; smoke?: TestResult[]; screenshots?: Screenshot[] };
  error?: { code: string; message: string };
  buildId?: string;
}

export interface RequestEvent {
  at: string;
  kind: 'info' | 'thought' | 'tool' | 'stage' | 'success' | 'warning' | 'error';
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
      return ((out.Items ?? []) as (RequestEvent & { SK: string })[]).map(({ SK, ...e }) => ({ ...e, id: SK.slice(4) }));
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
