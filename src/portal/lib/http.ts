import type { APIGatewayProxyResultV2 } from 'aws-lambda';

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

export function json(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResultV2 {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

export function errorResponse(statusCode: number, requestId: string, code: string, message: string): APIGatewayProxyResultV2 {
  return json(statusCode, { ok: false, requestId, code, message });
}

export function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ service: 'nadf-portal', ...entry }));
}
