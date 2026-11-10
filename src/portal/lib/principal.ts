import { isRole, type Role } from './roles';

/** Usuario autenticado, tomado SOLO de las claims del ID token validado por API Gateway. */
export interface Principal {
  userId: string;
  email: string;
  name?: string;
  companyId: string;
  roles: Role[];
}

type Claims = Record<string, string | number | boolean | string[] | undefined>;

/**
 * API Gateway HTTP API entrega `cognito:groups` como string "[admin aprobador]";
 * en pruebas o con otros emisores puede llegar como arreglo o lista separada por comas.
 */
export function parseGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map(String).map((g) => g.trim()).filter(Boolean);
  }
  if (typeof raw !== 'string') {
    return [];
  }
  return raw
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .map((g) => g.trim())
    .filter(Boolean);
}

export function principalFromClaims(claims: Claims | undefined): Principal | null {
  if (!claims) {
    return null;
  }
  const userId = typeof claims.sub === 'string' ? claims.sub : '';
  const companyId = typeof claims['custom:companyId'] === 'string' ? claims['custom:companyId'] : '';
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
  if (!userId || !companyId || !email) {
    return null;
  }
  const roles = parseGroups(claims['cognito:groups']).filter(isRole);
  const name = typeof claims.name === 'string' && claims.name ? claims.name : undefined;
  return { userId, email, name, companyId, roles };
}
