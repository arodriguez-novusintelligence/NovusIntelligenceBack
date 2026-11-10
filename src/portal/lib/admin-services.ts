import { createSign } from 'node:crypto';
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DescribeSecretCommand, GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Role } from './roles';

export interface CatalogAgent {
  id: string;
  name: string;
  layer: string | null;
  pattern: string | null;
  description: string;
  what: string;
  how: string;
  stage: string | null;
  executable: boolean;
  kind: 'base' | 'platform' | 'optional' | 'framework';
  responsibilities: string[];
  forbiddenActions: string[];
  allowedTools: string[];
  mcpServers: string[];
  qualityGates: string[];
  definitionPath: string | null;
  prompt: string;
}

export interface Catalog {
  framework: Record<string, unknown>;
  baseNodes: string[];
  platformNodes: string[];
  optionalAgents: string[];
  agents: CatalogAgent[];
  policies: string[];
  approvalModel: { policy: string; gates: Record<string, unknown>[]; invariants: string[] };
}

export interface AdminServices {
  userStatus(email: string): Promise<{ status: string; enabled: boolean; companyId?: string; mfa: boolean } | null>;
  createUser(input: { email: string; name: string; companyId: string; roles: Role[] }): Promise<string>;
  setGroups(email: string, next: string[], previous: string[]): Promise<void>;
  setEnabled(email: string, enabled: boolean): Promise<void>;
  resendInvite(email: string): Promise<void>;
  presignPut(key: string, contentType: string, size: number): Promise<string>;
  presignGet(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  catalog(): Promise<Catalog>;
  githubInstallation(installationId: number, repo: string): Promise<{ ok: boolean; account?: string; repos?: string[]; permissions?: Record<string, string>; error?: string }>;
  engineStatus(): Promise<{ ok: boolean; provider: string; model: string; keyUpdatedAt?: string }>;
}

function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export function createAdminServices(): AdminServices {
  const cognito = new CognitoIdentityProviderClient({});
  const s3 = new S3Client({});
  const secrets = new SecretsManagerClient({});
  let cached: { at: number; catalog: Catalog } | null = null;

  const attrs = (list?: { Name?: string; Value?: string }[]) => Object.fromEntries((list ?? []).map((a) => [a.Name, a.Value]));

  return {
    async userStatus(email) {
      try {
        const out = await cognito.send(new AdminGetUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: email }));
        const a = attrs(out.UserAttributes);
        return { status: out.UserStatus ?? 'UNKNOWN', enabled: out.Enabled ?? false, companyId: a['custom:companyId'], mfa: (out.UserMFASettingList ?? []).includes('SOFTWARE_TOKEN_MFA') };
      } catch (error) {
        if ((error as { name?: string }).name === 'UserNotFoundException') return null;
        throw error;
      }
    },
    async createUser({ email, name, companyId, roles }) {
      // Cognito envía la invitación con contraseña temporal; la empresa sale del token del Admin, nunca del cuerpo.
      const out = await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: env('USER_POOL_ID'),
          Username: email,
          DesiredDeliveryMediums: ['EMAIL'],
          UserAttributes: [
            { Name: 'email', Value: email },
            { Name: 'email_verified', Value: 'true' },
            { Name: 'name', Value: name },
            { Name: 'custom:companyId', Value: companyId },
          ],
        }),
      );
      for (const role of roles) await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: env('USER_POOL_ID'), Username: email, GroupName: role }));
      return attrs(out.User?.Attributes).sub!;
    },
    async setGroups(email, next, previous) {
      for (const g of next.filter((r) => !previous.includes(r))) await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: env('USER_POOL_ID'), Username: email, GroupName: g }));
      for (const g of previous.filter((r) => !next.includes(r))) await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: env('USER_POOL_ID'), Username: email, GroupName: g }));
    },
    async setEnabled(email, enabled) {
      await cognito.send(enabled ? new AdminEnableUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: email }) : new AdminDisableUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: email }));
    },
    async resendInvite(email) {
      await cognito.send(new AdminCreateUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: email, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] }));
    },
    async presignPut(key, contentType, size) {
      return getSignedUrl(s3, new PutObjectCommand({ Bucket: env('EVIDENCE_BUCKET'), Key: key, ContentType: contentType, ContentLength: size }), { expiresIn: 300 });
    },
    async presignGet(key) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: env('EVIDENCE_BUCKET'), Key: key }), { expiresIn: 3600 });
    },
    async exists(key) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: env('EVIDENCE_BUCKET'), Key: key }));
        return true;
      } catch {
        return false;
      }
    },
    async catalog() {
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.catalog;
      const out = await s3.send(new GetObjectCommand({ Bucket: env('EVIDENCE_BUCKET'), Key: 'runner/catalog.json' }));
      const catalog = JSON.parse(await out.Body!.transformToString('utf-8')) as Catalog;
      cached = { at: Date.now(), catalog };
      return catalog;
    },
    async githubInstallation(installationId, repo) {
      const raw = await secrets.send(new GetSecretValueCommand({ SecretId: '/nadf/platform/github-app' }));
      const app = JSON.parse(raw.SecretString ?? '{}') as { app_id: number; private_key: string };
      const b64 = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 300, iss: String(app.app_id) })}`;
      const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(app.private_key, 'base64url')}`;
      const gh = async (path: string, token: string, method = 'GET') => {
        const r = await fetch(`https://api.github.com${path}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'nadf-portal' }, signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`GitHub ${r.status}`);
        return r.json() as Promise<Record<string, unknown>>;
      };
      const inst = await gh(`/app/installations/${installationId}`, jwt);
      const tok = (await gh(`/app/installations/${installationId}/access_tokens`, jwt, 'POST')) as { token: string };
      const repos = (await gh('/installation/repositories?per_page=100', tok.token)) as { repositories: { full_name: string }[] };
      return {
        ok: repos.repositories.some((r) => r.full_name === repo),
        account: (inst.account as { login?: string })?.login,
        repos: repos.repositories.map((r) => r.full_name),
        permissions: inst.permissions as Record<string, string>,
      };
    },
    async engineStatus() {
      const out = await secrets.send(new DescribeSecretCommand({ SecretId: '/nadf/platform/claude-api-key' }));
      return { ok: true, provider: 'Anthropic · Claude', model: 'claude-opus-5-5', keyUpdatedAt: (out.LastChangedDate ?? out.CreatedDate)?.toISOString() };
    },
  };
}
