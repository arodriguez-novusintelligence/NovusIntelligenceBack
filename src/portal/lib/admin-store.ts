import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Actor } from './requests';
import type { Role } from './roles';

export interface TeamMember {
  userId: string;
  companyId: string;
  email: string;
  name?: string;
  roles: Role[];
  status: 'active' | 'invited' | 'disabled';
  createdAt?: string;
  createdBy?: Actor;
  updatedAt?: string;
  lastSeenAt?: string;
}

/** Ajuste de un agente SOLO para una empresa (la definición del framework no se toca). */
export interface AgentOverride {
  agentId: string;
  companyId: string;
  version: number;
  instructions: string;
  mandatory: string[];
  configurable: string[];
  updatedAt: string;
  updatedBy: Actor;
  history: { version: number; at: string; by: string; instructions: string; mandatory: string[]; configurable: string[] }[];
}

export interface FlowTemplate {
  flowId: string;
  companyId: string;
  name: string;
  description: string;
  /** Agentes opcionales incluidos; la base y los controles de la plataforma siempre van. */
  agents: string[];
  version: number;
  createdAt: string;
  createdBy: Actor;
  updatedAt: string;
  updatedBy: Actor;
  archived: boolean;
}

export interface AuditEntry {
  at: string;
  by: Actor;
  action: string;
  detail: Record<string, unknown>;
}

export interface AdminStore {
  listUsers(companyId: string): Promise<TeamMember[]>;
  getUser(companyId: string, userId: string): Promise<TeamMember | null>;
  putUser(member: TeamMember): Promise<void>;
  updateUser(companyId: string, userId: string, patch: Partial<TeamMember>): Promise<TeamMember>;
  getCompany(companyId: string): Promise<Record<string, unknown> | null>;
  updateCompany(companyId: string, patch: Record<string, unknown>): Promise<void>;
  listAgentOverrides(companyId: string): Promise<AgentOverride[]>;
  getAgentOverride(companyId: string, agentId: string): Promise<AgentOverride | null>;
  putAgentOverride(o: AgentOverride): Promise<void>;
  listFlows(companyId: string): Promise<FlowTemplate[]>;
  getFlow(companyId: string, flowId: string): Promise<FlowTemplate | null>;
  putFlow(f: FlowTemplate): Promise<void>;
  audit(companyId: string, entry: AuditEntry): Promise<void>;
  listAudit(companyId: string, limit: number): Promise<AuditEntry[]>;
}

const strip = <T>(item: Record<string, unknown> | undefined): T | null => {
  if (!item) return null;
  const rest = { ...item };
  for (const k of ['PK', 'SK', 'GSI3PK', 'entity']) delete rest[k];
  return rest as T;
};

export function createAdminStore(table: string, client?: DynamoDBDocumentClient): AdminStore {
  const doc = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const pk = (c: string) => `COMPANY#${c}`;
  const query = async (companyId: string, prefix: string, limit?: number, desc = false) => {
    const out = await doc.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': pk(companyId), ':sk': prefix }, Limit: limit, ScanIndexForward: !desc }));
    return out.Items ?? [];
  };

  return {
    async listUsers(companyId) {
      return (await query(companyId, 'USER#')).map((i) => strip<TeamMember>(i)!).map((m) => ({ ...m, roles: m.roles ?? [] }));
    },
    async getUser(companyId, userId) {
      const out = await doc.send(new GetCommand({ TableName: table, Key: { PK: pk(companyId), SK: `USER#${userId}` } }));
      const m = strip<TeamMember>(out.Item);
      return m ? { ...m, roles: m.roles ?? [] } : null;
    },
    async putUser(m) {
      await doc.send(new PutCommand({ TableName: table, Item: { PK: pk(m.companyId), SK: `USER#${m.userId}`, GSI3PK: `EMAIL#${m.email}`, entity: 'USER', ...m }, ConditionExpression: 'attribute_not_exists(PK)' }));
    },
    async updateUser(companyId, userId, patch) {
      const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const sets = entries.map(([k, v], i) => {
        names[`#k${i}`] = k;
        values[`:v${i}`] = v;
        return `#k${i} = :v${i}`;
      });
      const out = await doc.send(
        new UpdateCommand({ TableName: table, Key: { PK: pk(companyId), SK: `USER#${userId}` }, UpdateExpression: `SET ${sets.join(', ')}`, ConditionExpression: 'attribute_exists(PK)', ExpressionAttributeNames: names, ExpressionAttributeValues: values, ReturnValues: 'ALL_NEW' }),
      );
      return strip<TeamMember>(out.Attributes)!;
    },
    async getCompany(companyId) {
      const out = await doc.send(new GetCommand({ TableName: table, Key: { PK: pk(companyId), SK: 'PROFILE' } }));
      return strip<Record<string, unknown>>(out.Item);
    },
    async updateCompany(companyId, patch) {
      const entries = Object.entries(patch);
      await doc.send(
        new UpdateCommand({
          TableName: table,
          Key: { PK: pk(companyId), SK: 'PROFILE' },
          UpdateExpression: `SET ${entries.map((_, i) => `#k${i} = :v${i}`).join(', ')}`,
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: Object.fromEntries(entries.map(([k], i) => [`#k${i}`, k])),
          ExpressionAttributeValues: Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])),
        }),
      );
    },
    async listAgentOverrides(companyId) {
      return (await query(companyId, 'AGENTDEF#')).map((i) => strip<AgentOverride>(i)!);
    },
    async getAgentOverride(companyId, agentId) {
      const out = await doc.send(new GetCommand({ TableName: table, Key: { PK: pk(companyId), SK: `AGENTDEF#${agentId}` } }));
      return strip<AgentOverride>(out.Item);
    },
    async putAgentOverride(o) {
      await doc.send(new PutCommand({ TableName: table, Item: { PK: pk(o.companyId), SK: `AGENTDEF#${o.agentId}`, entity: 'AGENTDEF', ...o } }));
    },
    async listFlows(companyId) {
      return (await query(companyId, 'FLOW#')).map((i) => strip<FlowTemplate>(i)!).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async getFlow(companyId, flowId) {
      const out = await doc.send(new GetCommand({ TableName: table, Key: { PK: pk(companyId), SK: `FLOW#${flowId}` } }));
      return strip<FlowTemplate>(out.Item);
    },
    async putFlow(f) {
      await doc.send(new PutCommand({ TableName: table, Item: { PK: pk(f.companyId), SK: `FLOW#${f.flowId}`, entity: 'FLOW', ...f } }));
    },
    async audit(companyId, entry) {
      await doc.send(new PutCommand({ TableName: table, Item: { PK: pk(companyId), SK: `AUDIT#${entry.at}#${Math.random().toString(36).slice(2, 8)}`, entity: 'AUDIT', ...entry } }));
    },
    async listAudit(companyId, limit) {
      return (await query(companyId, 'AUDIT#', limit, true)).map((i) => strip<AuditEntry>(i)!);
    },
  };
}
