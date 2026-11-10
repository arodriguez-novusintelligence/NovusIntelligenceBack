#!/usr/bin/env node
/**
 * NADF — arranque de la plataforma: crea (o completa) una empresa y su Admin.
 * Idempotente: si la empresa o el usuario ya existen, solo asegura grupos y registros.
 *
 * Uso:
 *   node scripts/portal/bootstrap-admin.mjs --stage dev --email ana@empresa.com --name "Ana Pérez" \
 *     [--company-id novus] [--company-name "Novus Intelligence Solutions"] [--country CO] \
 *     [--roles novus-admin,admin] [--region sa-east-1] [--suppress-email]
 *
 * Por defecto Cognito envía la invitación con una contraseña temporal.
 * --suppress-email crea el usuario sin enviar correo (solo para cuentas de prueba; la
 * contraseña la fija aparte un operador con AdminSetUserPassword).
 */
import { randomUUID } from 'node:crypto';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const VALID_ROLES = ['novus-admin', 'admin', 'aprobador', 'funcional', 'desarrollador', 'observador'];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[name] = true;
    } else {
      args[name] = next;
      i += 1;
    }
  }
  return args;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const stage = args.stage || 'dev';
const region = args.region || 'sa-east-1';
const email = typeof args.email === 'string' ? args.email.trim().toLowerCase() : '';
const name = typeof args.name === 'string' ? args.name.trim() : '';
const companyId = typeof args['company-id'] === 'string' ? args['company-id'] : 'novus';
const companyName = typeof args['company-name'] === 'string' ? args['company-name'] : 'Novus Intelligence Solutions';
const country = typeof args.country === 'string' ? args.country : 'CO';
const roles = (typeof args.roles === 'string' ? args.roles : 'novus-admin,admin').split(',').map((r) => r.trim());
const suppressEmail = args['suppress-email'] === true;

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('--email es obligatorio y debe ser un correo válido');
if (!name) fail('--name es obligatorio');
if (!/^[a-z0-9-]{2,64}$/.test(companyId)) fail('--company-id solo admite minúsculas, números y guiones');
const badRoles = roles.filter((r) => !VALID_ROLES.includes(r));
if (badRoles.length) fail(`roles desconocidos: ${badRoles.join(', ')}`);

const stackName = `nadf-portal-${stage}`;
const cfn = new CloudFormationClient({ region });
const cognito = new CognitoIdentityProviderClient({ region });
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

const stack = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
const outputs = Object.fromEntries((stack.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
const userPoolId = outputs.UserPoolId;
const table = outputs.PortalTableName;
if (!userPoolId || !table) fail(`el stack ${stackName} no expone UserPoolId/PortalTableName`);

const now = new Date().toISOString();

// 1) Empresa (no sobreescribe si existe)
try {
  await doc.send(
    new PutCommand({
      TableName: table,
      Item: {
        PK: `COMPANY#${companyId}`,
        SK: 'PROFILE',
        entity: 'Company',
        companyId,
        name: companyName,
        country,
        status: 'active',
        createdAt: now,
        createdBy: 'bootstrap',
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
  console.log(`Empresa creada: ${companyId} (${companyName})`);
} catch (error) {
  if (error.name !== 'ConditionalCheckFailedException') throw error;
  console.log(`Empresa ya existía: ${companyId}`);
}

// 2) Usuario en Cognito
let sub;
let created = false;
try {
  const existing = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
  sub = existing.UserAttributes?.find((a) => a.Name === 'sub')?.Value;
  const existingCompany = existing.UserAttributes?.find((a) => a.Name === 'custom:companyId')?.Value;
  if (existingCompany && existingCompany !== companyId) {
    fail(`el usuario ya pertenece a la empresa ${existingCompany}`);
  }
  console.log(`Usuario ya existía en Cognito: ${email}`);
} catch (error) {
  if (error.name !== 'UserNotFoundException') throw error;
  const out = await cognito.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: email,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        { Name: 'name', Value: name },
        { Name: 'custom:companyId', Value: companyId },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
      ...(suppressEmail ? { MessageAction: 'SUPPRESS' } : {}),
    }),
  );
  sub = out.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
  created = true;
  console.log(suppressEmail ? `Usuario creado sin correo: ${email}` : `Usuario creado; invitación enviada a ${email}`);
}
if (!sub) fail('no se pudo obtener el identificador (sub) del usuario');

// 3) Grupos (roles)
for (const role of roles) {
  await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: email, GroupName: role }));
}
console.log(`Roles asignados: ${roles.join(', ')}`);

// 4) Registro del usuario y auditoría
await doc.send(
  new PutCommand({
    TableName: table,
    Item: {
      PK: `COMPANY#${companyId}`,
      SK: `USER#${sub}`,
      entity: 'User',
      userId: sub,
      companyId,
      email,
      name,
      roles,
      status: 'active',
      createdAt: now,
      createdBy: 'bootstrap',
      GSI3PK: `EMAIL#${email}`,
    },
    ConditionExpression: 'attribute_not_exists(PK)',
  }),
).catch((error) => {
  if (error.name !== 'ConditionalCheckFailedException') throw error;
});

await doc.send(
  new PutCommand({
    TableName: table,
    Item: {
      PK: `COMPANY#${companyId}`,
      SK: `AUDIT#${now}#${randomUUID()}`,
      entity: 'Audit',
      actor: 'bootstrap',
      action: created ? 'user.bootstrap.create' : 'user.bootstrap.ensure',
      target: email,
      detail: { roles },
      at: now,
    },
  }),
);

console.log(`Listo. Empresa=${companyId} Usuario=${email} sub=${sub}`);
