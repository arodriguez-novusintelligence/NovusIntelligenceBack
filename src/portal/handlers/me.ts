import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { errorResponse, json, log } from '../lib/http';
import { principalFromClaims } from '../lib/principal';
import { createDynamoRepository, type PortalRepository } from '../lib/repository';
import { permissionsFor, requiresMfa } from '../lib/roles';

/**
 * GET /api/v1/portal/me
 * Devuelve el usuario, su empresa, sus roles y los permisos efectivos.
 * Empresa y roles salen del token (no del cuerpo); el registro en DynamoDB
 * confirma que el usuario y la empresa existen y están activos.
 */
export function createMeHandler(repo: PortalRepository, now: () => Date = () => new Date()) {
  return async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
    const requestId = event.requestContext.requestId;
    const principal = principalFromClaims(event.requestContext.authorizer?.jwt?.claims);

    if (!principal) {
      return errorResponse(403, requestId, 'NO_COMPANY', 'Tu cuenta no está asociada a una empresa en NADF.');
    }

    try {
      const [user, company] = await Promise.all([
        repo.getUser(principal.companyId, principal.userId),
        repo.getCompany(principal.companyId),
      ]);

      if (!user || !company) {
        log({ level: 'warn', requestId, event: 'me.not_registered', userId: principal.userId });
        return errorResponse(403, requestId, 'NOT_REGISTERED', 'Tu usuario no está registrado en NADF.');
      }
      if (user.status === 'disabled') {
        return errorResponse(403, requestId, 'USER_DISABLED', 'Tu usuario está desactivado. Habla con el administrador de tu empresa.');
      }
      if (company.status === 'disabled') {
        return errorResponse(403, requestId, 'COMPANY_DISABLED', 'La empresa está desactivada en NADF.');
      }

      await repo.touchUser(principal.companyId, principal.userId, now().toISOString());

      return json(200, {
        ok: true,
        requestId,
        user: {
          id: principal.userId,
          email: principal.email,
          name: user.name ?? principal.name ?? null,
          roles: principal.roles,
          mfaRequired: requiresMfa(principal.roles),
        },
        company: { id: company.companyId, name: company.name, country: company.country ?? null },
        permissions: permissionsFor(principal.roles),
      });
    } catch (error) {
      log({ level: 'error', requestId, event: 'me.failed', message: (error as Error).message });
      return errorResponse(500, requestId, 'INTERNAL', 'No pudimos cargar tu perfil. Intenta de nuevo.');
    }
  };
}

let defaultHandler: ReturnType<typeof createMeHandler> | undefined;

export const handler = (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> => {
  if (!defaultHandler) {
    const table = process.env.PORTAL_TABLE;
    if (!table) {
      throw new Error('Missing required environment variable: PORTAL_TABLE');
    }
    defaultHandler = createMeHandler(createDynamoRepository(table));
  }
  return defaultHandler(event);
};
