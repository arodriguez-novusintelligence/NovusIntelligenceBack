import { describe, expect, it } from 'vitest';
import { parseGroups, principalFromClaims } from './principal';

describe('parseGroups', () => {
  it('lee el formato de API Gateway "[a b]"', () => {
    expect(parseGroups('[admin novus-admin]')).toEqual(['admin', 'novus-admin']);
  });
  it('lee arreglos y listas con comas', () => {
    expect(parseGroups(['admin', 'funcional'])).toEqual(['admin', 'funcional']);
    expect(parseGroups('admin,funcional')).toEqual(['admin', 'funcional']);
  });
  it('devuelve vacío si no hay grupos', () => {
    expect(parseGroups(undefined)).toEqual([]);
    expect(parseGroups('[]')).toEqual([]);
  });
});

describe('principalFromClaims', () => {
  const base = {
    sub: 'u-1',
    email: 'Ana@Empresa.com',
    'custom:companyId': 'novus',
    'cognito:groups': '[admin desconocido]',
  };

  it('arma el usuario con email en minúsculas y solo roles válidos', () => {
    expect(principalFromClaims(base)).toEqual({
      userId: 'u-1',
      email: 'ana@empresa.com',
      name: undefined,
      companyId: 'novus',
      roles: ['admin'],
    });
  });

  it('rechaza tokens sin empresa', () => {
    expect(principalFromClaims({ ...base, 'custom:companyId': undefined })).toBeNull();
  });

  it('rechaza claims ausentes', () => {
    expect(principalFromClaims(undefined)).toBeNull();
  });
});
