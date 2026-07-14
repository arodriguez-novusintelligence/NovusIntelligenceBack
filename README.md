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

## Referencias NADF

- Especificación: `.nadf/projects/novus-intelligence/artifacts/especificacion-backend.md`
- Plan: `.nadf/projects/novus-intelligence/artifacts/plan-implementacion.md`
