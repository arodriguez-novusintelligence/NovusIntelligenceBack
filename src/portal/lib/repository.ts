import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Tabla única nadf-portal-{stage}. La empresa es la partición lógica:
 * ninguna lectura cruza datos entre empresas.
 */
export const keys = {
  company: (companyId: string) => ({ PK: `COMPANY#${companyId}`, SK: 'PROFILE' }),
  user: (companyId: string, userId: string) => ({ PK: `COMPANY#${companyId}`, SK: `USER#${userId}` }),
};

export type EntityStatus = 'active' | 'invited' | 'disabled';

export interface CompanyRecord {
  companyId: string;
  name: string;
  country?: string;
  status: EntityStatus;
}

export interface UserRecord {
  userId: string;
  companyId: string;
  email: string;
  name?: string;
  status: EntityStatus;
  lastSeenAt?: string;
}

export interface PortalRepository {
  getCompany(companyId: string): Promise<CompanyRecord | null>;
  getUser(companyId: string, userId: string): Promise<UserRecord | null>;
  touchUser(companyId: string, userId: string, at: string): Promise<void>;
}

export function createDynamoRepository(tableName: string, client?: DynamoDBDocumentClient): PortalRepository {
  const doc = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));

  return {
    async getCompany(companyId) {
      const out = await doc.send(new GetCommand({ TableName: tableName, Key: keys.company(companyId) }));
      return (out.Item as CompanyRecord | undefined) ?? null;
    },
    async getUser(companyId, userId) {
      const out = await doc.send(new GetCommand({ TableName: tableName, Key: keys.user(companyId, userId) }));
      return (out.Item as UserRecord | undefined) ?? null;
    },
    async touchUser(companyId, userId, at) {
      await doc.send(
        new UpdateCommand({
          TableName: tableName,
          Key: keys.user(companyId, userId),
          UpdateExpression: 'SET lastSeenAt = :at',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: { ':at': at },
        }),
      );
    },
  };
}
