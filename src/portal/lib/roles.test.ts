import { describe, expect, it } from 'vitest';
import { PERMISSIONS, isRole, permissionsFor, requiresMfa } from './roles';

describe('permissionsFor', () => {
  it('da al Admin de empresa todos los permisos salvo administrar la plataforma', () => {
    const perms = permissionsFor(['admin']);
    expect(perms).toContain('approvals.decide');
    expect(perms).toContain('requests.create');
    expect(perms).toContain('users.manage');
    expect(perms).not.toContain('platform.companies');
    expect(perms).toHaveLength(PERMISSIONS.length - 1);
  });

  it('da al Admin Novus todos los permisos', () => {
    expect(permissionsFor(['novus-admin'])).toEqual([...PERMISSIONS]);
  });

  it('no deja al Funcional aprobar ni gestionar usuarios', () => {
    const perms = permissionsFor(['funcional']);
    expect(perms).toContain('requests.create');
    expect(perms).not.toContain('approvals.decide');
    expect(perms).not.toContain('users.manage');
  });

  it('suma permisos de varios roles sin duplicar', () => {
    const perms = permissionsFor(['funcional', 'aprobador']);
    expect(perms).toContain('requests.create');
    expect(perms).toContain('approvals.decide');
    expect(new Set(perms).size).toBe(perms.length);
  });

  it('sin roles no hay permisos', () => {
    expect(permissionsFor([])).toEqual([]);
  });
});

describe('requiresMfa', () => {
  it('exige MFA a admin y aprobador, no a funcional', () => {
    expect(requiresMfa(['admin'])).toBe(true);
    expect(requiresMfa(['aprobador'])).toBe(true);
    expect(requiresMfa(['funcional', 'observador'])).toBe(false);
  });
});

describe('isRole', () => {
  it('reconoce solo roles conocidos', () => {
    expect(isRole('admin')).toBe(true);
    expect(isRole('root')).toBe(false);
  });
});
