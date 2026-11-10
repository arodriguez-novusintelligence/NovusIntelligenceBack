import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import type { CompanyRecord, PortalRepository, UserRecord } from '../lib/repository';
import { createMeHandler } from './me';

const company: CompanyRecord = { companyId: 'novus', name: 'Novus Intelligence Solutions', country: 'CO', status: 'active' };
const user: UserRecord = { userId: 'u-1', companyId: 'novus', email: 'ana@novus.com', name: 'Ana', status: 'active' };

function fakeRepo(overrides: Partial<PortalRepository> = {}): PortalRepository {
  return {
    getCompany: vi.fn(async () => company),
    getUser: vi.fn(async () => user),
    touchUser: vi.fn(async () => undefined),
    ...overrides,
  };
}

function event(claims: Record<string, string> | undefined): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    requestContext: {
      requestId: 'req-1',
      authorizer: claims ? { jwt: { claims, scopes: [] }, principalId: '', integrationLatency: 0 } : undefined,
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

const claims = { sub: 'u-1', email: 'ana@novus.com', 'custom:companyId': 'novus', 'cognito:groups': '[admin]' };

async function call(repo: PortalRepository, c: Record<string, string> | undefined) {
  const res = (await createMeHandler(repo, () => new Date('2026-11-10T12:00:00Z'))(event(c))) as APIGatewayProxyStructuredResultV2;
  return { status: res.statusCode, body: JSON.parse(res.body as string) };
}

describe('GET /api/v1/portal/me', () => {
  it('devuelve usuario, empresa y permisos del Admin', async () => {
    const repo = fakeRepo();
    const { status, body } = await call(repo, claims);
    expect(status).toBe(200);
    expect(body.user).toMatchObject({ id: 'u-1', name: 'Ana', roles: ['admin'], mfaRequired: true });
    expect(body.company).toEqual({ id: 'novus', name: 'Novus Intelligence Solutions', country: 'CO' });
    expect(body.permissions).toContain('approvals.decide');
    expect(repo.touchUser).toHaveBeenCalledWith('novus', 'u-1', '2026-11-10T12:00:00.000Z');
  });

  it('lee la empresa del token, no de otra fuente', async () => {
    const repo = fakeRepo();
    await call(repo, { ...claims, 'custom:companyId': 'otra' });
    expect(repo.getUser).toHaveBeenCalledWith('otra', 'u-1');
  });

  it('responde 403 si el token no trae empresa', async () => {
    const { status, body } = await call(fakeRepo(), { sub: 'u-1', email: 'a@b.com' });
    expect(status).toBe(403);
    expect(body.code).toBe('NO_COMPANY');
  });

  it('responde 403 si el usuario no está registrado', async () => {
    const { status, body } = await call(fakeRepo({ getUser: vi.fn(async () => null) }), claims);
    expect(status).toBe(403);
    expect(body.code).toBe('NOT_REGISTERED');
  });

  it('responde 403 si el usuario está desactivado', async () => {
    const { status, body } = await call(fakeRepo({ getUser: vi.fn(async () => ({ ...user, status: 'disabled' as const })) }), claims);
    expect(status).toBe(403);
    expect(body.code).toBe('USER_DISABLED');
  });

  it('responde 500 sin filtrar detalles si DynamoDB falla', async () => {
    const { status, body } = await call(fakeRepo({ getCompany: vi.fn(async () => { throw new Error('boom'); }) }), claims);
    expect(status).toBe(500);
    expect(body.message).not.toContain('boom');
  });
});
