# NovusIntelligenceBack

Backend productivo del piloto **novus-intelligence** (NADF).

## Stack

| Tecnología | Versión |
|------------|---------|
| Serverless Framework | 3.x |
| Node.js | 20.x |
| TypeScript | 5.x |
| AWS Lambda | sa-east-1 (DEV) |
| AWS SES | Email transaccional |

## Endpoints

| Método | Ruta | Handler | Descripción |
|--------|------|---------|-------------|
| POST | `/api/v1/contact` | `novus-contact-handler` | Formulario de contacto |
| OPTIONS | `/api/v1/contact` | `novus-contact-handler` | CORS preflight |

## Variables de entorno

Solo nombres documentados. Valores en AWS Secrets Manager / SSM — **nunca en repositorio**.

| Variable | Obligatorio | Descripción |
|----------|-------------|-------------|
| `CONTACT_EMAIL_FROM` | Sí | Remitente SES verificado |
| `CONTACT_EMAIL_TO` | Sí | Destinatario notificaciones |
| `CORS_ALLOWED_ORIGINS` | Sí | Orígenes permitidos (coma-separados) |
| `RATE_LIMIT_PER_IP` | No | Umbral rate limit (referencia; WAF en IaC) |
| `CAPTCHA_ENABLED` | No | `true` para exigir captcha |
| `CAPTCHA_PROVIDER` | Condicional | `turnstile` o `hcaptcha` |
| `CAPTCHA_SECRET` | Condicional | Secret de verificación |
| `CRM_WEBHOOK_URL` | No | Webhook CRM opcional |
| `LOG_LEVEL` | No | Nivel de log (`info` por defecto) |
| `EMAIL_DRY_RUN` | No | `true` solo en local explícito; **false** en DEV/prod (R-001) |

Ver `.env.example` para plantilla local.

## Desarrollo local

```bash
npm install
npm run typecheck
npm run lint
```

## Despliegue

**Prohibido sin aprobación humana explícita** (constraint NADF `NO_DEPLOY`).

```bash
# Solo tras aprobación y configuración de secrets en AWS
npx serverless deploy --stage dev --region sa-east-1
```

## Arquitectura

```
API Gateway (HTTP API) → Lambda (novus-contact-handler) → SES
                                              ↓ (opcional)
                                         CRM Webhook
```

- Abstracción email vía `EmailService` (implementación SES).
- Validación y sanitización server-side según `especificacion-backend.md`.
- Sin mocks en producción (R-001): `requestId` siempre UUID real.

## Contrato OpenAPI

- `openapi/contact-v1.yaml` — esquema `POST /api/v1/contact` alineado a `especificacion-backend.md`.

## Referencias NADF

- Especificación: `.nadf/projects/novus-intelligence/artifacts/especificacion-backend.md`
- Plan: `.nadf/projects/novus-intelligence/artifacts/plan-implementacion.md`
- Resumen implementación: `.nadf/projects/novus-intelligence/artifacts/resumen-backend.md`

## Servicio nadf-portal (Administrador de IA NADF)

Servicio independiente del formulario de contacto, definido en `serverless-portal.yml` (stack `nadf-portal-{stage}`). Fase 0 del plan del documento "NADF — Administrador de IA".

| Recurso | Detalle |
| --- | --- |
| Cognito `nadf-portal-{stage}` | Usuarios propios, sin registro abierto, MFA TOTP opcional, grupos `novus-admin`, `admin`, `aprobador`, `desarrollador`, `funcional`, `observador`. `custom:companyId` no es escribible por el usuario |
| DynamoDB `nadf-portal-{stage}` | Tabla única (PK/SK + GSI1, GSI2, GSI3), PITR y TTL |
| S3 evidencias | Privado, versionado, cifrado |
| S3 + CloudFront del portal | Bucket privado con OAC, fallback SPA y cabeceras de seguridad |
| `GET /api/v1/portal/me` | HTTP API con autorizador JWT de Cognito (ID token). Devuelve usuario, empresa, roles y permisos |

```bash
npm test                                   # pruebas unitarias (vitest)
npx serverless deploy --config serverless-portal.yml --stage dev
# Tras el primer deploy, permitir el origen de CloudFront en CORS:
PORTAL_EXTRA_ORIGIN=https://<distribucion>.cloudfront.net npx serverless deploy --config serverless-portal.yml --stage dev

# Primer Admin (envía invitación con contraseña temporal)
node scripts/portal/bootstrap-admin.mjs --stage dev --email admin@empresa.com --name "Nombre Apellido"
```

El script de arranque es idempotente: crea la empresa (por defecto `novus`), el usuario en Cognito, sus grupos, su registro y una entrada de auditoría.
