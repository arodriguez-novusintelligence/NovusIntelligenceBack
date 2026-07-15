import { randomUUID } from 'crypto';
import type { APIGatewayProxyResult } from 'aws-lambda';
import type { ContactFieldError, ContactResponse } from '../../types/contact';

const JSON_HEADERS = {
  'Content-Type': 'application/json',
};

export function createRequestId(): string {
  return randomUUID();
}

export function jsonResponse(
  statusCode: number,
  body: ContactResponse,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  };
}

export function successResponse(
  requestId: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyResult {
  return jsonResponse(
    200,
    { ok: true, requestId, message },
    extraHeaders,
  );
}

export function validationErrorResponse(
  requestId: string,
  message: string,
  errors: ContactFieldError[],
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyResult {
  return jsonResponse(
    400,
    { ok: false, requestId, message, errors },
    extraHeaders,
  );
}

export function rateLimitResponse(
  requestId: string,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyResult {
  return jsonResponse(
    429,
    {
      ok: false,
      requestId,
      message: 'Demasiadas solicitudes. Intente nuevamente en unos minutos.',
    },
    extraHeaders,
  );
}

export function internalErrorResponse(
  requestId: string,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyResult {
  return jsonResponse(
    500,
    {
      ok: false,
      requestId,
      message: 'No pudimos procesar su mensaje. Intente más tarde.',
    },
    extraHeaders,
  );
}

export function methodNotAllowedResponse(
  requestId: string,
  extraHeaders: Record<string, string> = {},
): APIGatewayProxyResult {
  return jsonResponse(
    405,
    {
      ok: false,
      requestId,
      message: 'Método no permitido.',
    },
    extraHeaders,
  );
}

export function corsHeaders(origin: string | undefined, allowedOrigins: string[]): Record<string, string> {
  if (!origin || !allowedOrigins.includes(origin)) {
    return {};
  }

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

export function logStructured(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}
