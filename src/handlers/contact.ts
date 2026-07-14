import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { loadConfig } from '../lib/config/env';
import {
  corsHeaders,
  createRequestId,
  internalErrorResponse,
  logStructured,
  methodNotAllowedResponse,
  rateLimitResponse,
  successResponse,
  validationErrorResponse,
} from '../lib/response/httpResponse';
import { isIpRateLimited } from '../lib/rateLimit/ipRateLimiter';
import {
  getValidationSummary,
  validateContactRequest,
} from '../lib/validation/contactValidator';
import { verifyCaptchaToken } from '../services/captcha/captchaService';
import { notifyCrmWebhook } from '../services/crm/crmWebhookService';
import { createEmailService } from '../services/email/sesEmailService';

function getClientIp(event: APIGatewayProxyEventV2): string | undefined {
  return event.requestContext.http.sourceIp;
}

function parseJsonBody(rawBody: string | undefined): unknown {
  if (!rawBody) {
    return null;
  }
  return JSON.parse(rawBody);
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const startedAt = Date.now();
  const requestId = createRequestId();
  const method = event.requestContext.http.method;
  const origin = event.headers.origin ?? event.headers.Origin;

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logStructured({
      level: 'error',
      event: 'config_error',
      requestId,
      message: error instanceof Error ? error.message : 'unknown_error',
    });
    return internalErrorResponse(requestId);
  }

  const cors = corsHeaders(origin, config.corsAllowedOrigins);

  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: cors,
      body: '',
    };
  }

  if (method !== 'POST') {
    logStructured({
      level: 'warn',
      event: 'method_not_allowed',
      requestId,
      method,
      durationMs: Date.now() - startedAt,
    });
    return methodNotAllowedResponse(requestId, cors);
  }

  // SEC-002: rate limit por IP (ventana 60s) — además del throttle API Gateway
  const clientIp = getClientIp(event);
  if (isIpRateLimited(clientIp, config.rateLimitPerIp)) {
    logStructured({
      level: 'warn',
      event: 'rate_limited',
      requestId,
      clientIp,
      limit: config.rateLimitPerIp,
      durationMs: Date.now() - startedAt,
    });
    return rateLimitResponse(requestId, cors);
  }

  const contentType = event.headers['content-type'] ?? event.headers['Content-Type'] ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return validationErrorResponse(
      requestId,
      'Content-Type debe ser application/json.',
      [{ field: 'content-type', code: 'invalid', message: 'Content-Type inválido.' }],
      cors,
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = parseJsonBody(event.body);
  } catch {
    return validationErrorResponse(
      requestId,
      'El cuerpo de la solicitud no es JSON válido.',
      [{ field: 'body', code: 'invalid_json', message: 'JSON inválido.' }],
      cors,
    );
  }

  const validation = validateContactRequest(parsedBody);
  if (!validation.valid || !validation.data) {
    logStructured({
      level: 'info',
      event: 'validation_failed',
      requestId,
      errorCount: validation.errors.length,
      durationMs: Date.now() - startedAt,
    });
    return validationErrorResponse(
      requestId,
      getValidationSummary(validation.errors),
      validation.errors,
      cors,
    );
  }

  const captchaResult = await verifyCaptchaToken(
    config,
    validation.data.captchaToken,
    getClientIp(event),
  );

  if (!captchaResult.valid) {
    return validationErrorResponse(
      requestId,
      captchaResult.error ?? 'Captcha inválido.',
      [
        {
          field: 'captchaToken',
          code: 'invalid',
          message: captchaResult.error ?? 'Token de captcha inválido.',
        },
      ],
      cors,
    );
  }

  const timestampUtc = new Date().toISOString();

  try {
    const emailService = createEmailService(config);
    await emailService.sendContactNotification({
      requestId,
      contact: validation.data,
      timestampUtc,
    });

    await notifyCrmWebhook(config, requestId, validation.data);

    logStructured({
      level: 'info',
      event: 'contact_submitted',
      requestId,
      status: 200,
      durationMs: Date.now() - startedAt,
      clientIp: getClientIp(event),
      solutionInterest: validation.data.solutionInterest ?? null,
    });

    return successResponse(
      requestId,
      'Mensaje recibido. Nos pondremos en contacto pronto.',
      cors,
    );
  } catch (error) {
    logStructured({
      level: 'error',
      event: 'contact_submit_failed',
      requestId,
      status: 500,
      durationMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : 'unknown_error',
    });
    return internalErrorResponse(requestId, cors);
  }
}
