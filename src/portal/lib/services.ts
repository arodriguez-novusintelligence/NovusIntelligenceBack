import { CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { RequestServices, PreviewSession } from '../handlers/requests';
import { getApp, type AppTarget } from './apps';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/** Implementación AWS de los servicios que usa el handler de solicitudes. */
export function createAwsServices(): RequestServices {
  const codebuild = new CodeBuildClient({});
  const cognito = new CognitoIdentityProviderClient({});
  const s3 = new S3Client({});
  const secrets = new SecretsManagerClient({});
  const sessions = new Map<string, { session: PreviewSession; exp: number }>();

  return {
    async startRun(request, phase) {
      const app = getApp(request.companyId, request.appId);
      if (!app) throw new Error(`unknown app ${request.appId}`);
      const out = await codebuild.send(
        new StartBuildCommand({
          projectName: env('RUNNER_PROJECT'),
          environmentVariablesOverride: [
            { name: 'NADF_REQUEST_ID', value: request.requestId, type: 'PLAINTEXT' },
            { name: 'NADF_COMPANY_ID', value: request.companyId, type: 'PLAINTEXT' },
            { name: 'NADF_APP_ID', value: request.appId, type: 'PLAINTEXT' },
            { name: 'NADF_PHASE', value: phase, type: 'PLAINTEXT' },
            { name: 'NADF_ITERATION', value: String(request.iteration), type: 'PLAINTEXT' },
            { name: 'NADF_APP_JSON', value: JSON.stringify(app), type: 'PLAINTEXT' },
          ],
        }),
      );
      return out.build?.id ?? '';
    },

    async mfaEnabled(username) {
      const out = await cognito.send(new AdminGetUserCommand({ UserPoolId: env('USER_POOL_ID'), Username: username }));
      return (out.UserMFASettingList ?? []).includes('SOFTWARE_TOKEN_MFA');
    },

    async previewSession(app: AppTarget) {
      const cached = sessions.get(app.id);
      if (cached && cached.exp > Date.now()) return cached.session;
      const secret = await secrets.send(new GetSecretValueCommand({ SecretId: app.previewUserSecret }));
      const cred = JSON.parse(secret.SecretString ?? '{}') as { email?: string; password?: string };
      if (!cred.email || !cred.password) throw new Error('preview user secret incomplete');
      const res = await fetch(`${app.apiBaseUrl}/login/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: cred.email, password: cred.password }),
        signal: AbortSignal.timeout(8000),
      });
      const payload = (await res.json().catch(() => ({}))) as { data?: { token?: string; user?: { userId?: string; platformRole?: string } } };
      const token = payload.data?.token;
      const userId = payload.data?.user?.userId;
      if (!res.ok || !token || !userId) throw new Error(`preview login failed (HTTP ${res.status})`);
      const session = { token, userId, platformRole: payload.data?.user?.platformRole };
      // El JWT de la app dura 30 días; se renueva cada 6 horas.
      sessions.set(app.id, { session, exp: Date.now() + 6 * 3600 * 1000 });
      return session;
    },

    async readEvidence(key) {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: env('EVIDENCE_BUCKET'), Key: key }));
        return Buffer.from(await out.Body!.transformToByteArray());
      } catch (error) {
        if ((error as { name?: string }).name === 'NoSuchKey') return null;
        throw error;
      }
    },

    async presign(key) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: env('EVIDENCE_BUCKET'), Key: key }), { expiresIn: 900 });
    },
  };
}
