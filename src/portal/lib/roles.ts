/**
 * Roles y permisos del Administrador de IA NADF.
 * Fuente: documento de diseño "NADF — Administrador de IA", sección Roles y permisos.
 * El Admin de empresa tiene todos los permisos dentro de su empresa; el Admin Novus,
 * además, administra la plataforma (crear empresas).
 */

export const ROLES = [
  'novus-admin',
  'admin',
  'aprobador',
  'funcional',
  'desarrollador',
  'arquitecto',
  'observador',
] as const;

export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'platform.companies',
  'company.manage',
  'users.manage',
  'apps.manage',
  'connectors.manage',
  'agents.manage',
  'agents.define',
  'workflows.manage',
  'requests.create',
  'requests.submit',
  'reports.view',
  'reports.viewOwn',
  'approvals.decide',
  'deployments.view',
  'deployments.operate',
  'audit.view',
  'usage.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const COMPANY_PERMISSIONS: Permission[] = PERMISSIONS.filter((p) => p !== 'platform.companies');

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  'novus-admin': PERMISSIONS,
  admin: COMPANY_PERMISSIONS,
  aprobador: ['reports.view', 'approvals.decide', 'deployments.view', 'deployments.operate', 'audit.view', 'usage.view'],
  funcional: ['requests.create', 'requests.submit', 'reports.viewOwn', 'deployments.view'],
  desarrollador: [
    'apps.manage',
    'connectors.manage',
    'agents.manage',
    'requests.create',
    'requests.submit',
    'reports.view',
    'deployments.view',
    'deployments.operate',
    'workflows.manage',
  ],
  // Arquitecto: ajusta definiciones de agentes y flujos SOLO para su empresa (nunca el NADF global).
  arquitecto: ['agents.manage', 'agents.define', 'workflows.manage', 'connectors.manage', 'reports.view', 'deployments.view', 'audit.view'],
  observador: ['reports.view', 'deployments.view'],
};

/** Roles que deben tener MFA activo (decisiones de producción y administración). */
const MFA_REQUIRED_ROLES: readonly Role[] = ['novus-admin', 'admin', 'aprobador'];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function permissionsFor(roles: readonly Role[]): Permission[] {
  const granted = new Set<Permission>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role]) {
      granted.add(permission);
    }
  }
  return PERMISSIONS.filter((p) => granted.has(p));
}

export function requiresMfa(roles: readonly Role[]): boolean {
  return roles.some((role) => MFA_REQUIRED_ROLES.includes(role));
}

/** Roles que el Admin de una empresa puede asignar (novus-admin solo lo otorga Novus). */
export const ASSIGNABLE_ROLES: readonly Role[] = ['admin', 'aprobador', 'funcional', 'desarrollador', 'arquitecto', 'observador'];
