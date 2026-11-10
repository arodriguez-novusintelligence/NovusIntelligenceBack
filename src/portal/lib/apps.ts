/**
 * Aplicaciones conectadas por empresa (espejo de .nadf/projects/<empresa>/project-context.yml).
 * Pipeline actual: solo PROD con revisión humana (decisión 2026-11-10).
 */
export interface AppTarget {
  id: string;
  companyId: string;
  name: string;
  description: string;
  repo: { owner: string; name: string; defaultBranch: string; installationId: number };
  prod: {
    url: string;
    bucket: string;
    region: string;
    distributionId: string;
    deployRoleArn: string;
    externalId: string;
  };
  /** Secreto con el usuario de la app con el que se abre la vista previa ya logueada. */
  previewUserSecret: string;
  apiBaseUrl: string;
}

export const APPS: readonly AppTarget[] = [
  {
    id: 'doevents-web',
    companyId: 'doevents',
    name: 'DoEvents WEB',
    description: 'Aplicación web de DoEvents (web.doeventsapp.com)',
    repo: { owner: 'doeventsrepo', name: 'DoEventsWEB', defaultBranch: 'main', installationId: 180570135 },
    prod: {
      url: 'https://web.doeventsapp.com',
      bucket: 'doevents-web-prod',
      region: 'us-west-1',
      distributionId: 'E1L51KSFEY3YGS',
      deployRoleArn: 'arn:aws:iam::519010577666:role/nadf-doevents-web-deploy-prod',
      externalId: 'nadf-doevents',
    },
    previewUserSecret: '/nadf/doevents/web-app-user',
    apiBaseUrl: 'https://api.doeventsapp.com',
  },
];

export function appsForCompany(companyId: string): AppTarget[] {
  return APPS.filter((a) => a.companyId === companyId);
}

export function getApp(companyId: string, appId: string): AppTarget | null {
  return APPS.find((a) => a.companyId === companyId && a.id === appId) ?? null;
}

/** Vista pública (sin ARN ni secretos) para el frontend. */
export function publicApp(app: AppTarget) {
  return { id: app.id, name: app.name, description: app.description, url: app.prod.url, repo: `${app.repo.owner}/${app.repo.name}` };
}
