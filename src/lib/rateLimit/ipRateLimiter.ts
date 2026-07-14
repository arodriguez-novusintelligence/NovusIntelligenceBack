/**
 * Rate limiter por IP en memoria del contenedor Lambda.
 * Suficiente para DEV; en alta escala conviene DynamoDB / API Gateway usage plans.
 */

interface Bucket {
  count: number;
  windowStartMs: number;
}

const buckets = new Map<string, Bucket>();
/** 10 requests per 5 minutes (especificacion-backend.md) */
const WINDOW_MS = 300_000;

export function isIpRateLimited(
  ip: string | undefined,
  limitPerWindow: number,
  nowMs: number = Date.now(),
): boolean {
  if (!ip || limitPerWindow <= 0) {
    return false;
  }

  const key = ip.trim();
  const existing = buckets.get(key);

  if (!existing || nowMs - existing.windowStartMs >= WINDOW_MS) {
    buckets.set(key, { count: 1, windowStartMs: nowMs });
    return false;
  }

  existing.count += 1;
  if (existing.count > limitPerWindow) {
    return true;
  }

  return false;
}

/** Test helper */
export function _resetIpRateLimiter(): void {
  buckets.clear();
}
