// Estado de la solicitud y consola en vivo (DynamoDB nadf-portal-{stage}).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

export function createState({ table, companyId, requestId }) {
  const key = { PK: `COMPANY#${companyId}`, SK: `REQ#${requestId}` };
  let seq = 0;
  let stage = 'preparing';

  async function emit(kind, text, extra = {}) {
    const at = new Date().toISOString();
    seq += 1;
    const clean = String(text).replace(/x-access-token:[^@\s]+/g, 'x-access-token:***').slice(0, 1800);
    console.log(`[${kind}] ${clean}`);
    try {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: { PK: `REQ#${requestId}`, SK: `EVT#${at}#${String(seq).padStart(6, '0')}`, at, seq, kind, text: clean, stage, ...extra },
        }),
      );
    } catch (error) {
      console.error('No se pudo registrar el evento', error.message);
    }
  }

  async function get() {
    const out = await doc.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
    if (!out.Item) throw Object.assign(new Error('Solicitud no encontrada'), { code: 'REQUEST_NOT_FOUND' });
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

  async function setStage(next, text) {
    stage = next;
    await update({ stage: next });
    if (text) await emit('stage', text);
  }

  return { emit, get, update, setStage, get stage() { return stage; } };
}
