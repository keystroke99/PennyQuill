import type { Env } from './types';
import { ApiError } from './validation';

export function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  return new Response(JSON.stringify(data), { status, headers });
}

export function noContent(extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  return new Response(null, { status: 204, headers });
}

export function apiErrorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }, error.status);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed/i.test(message)) {
    return json({ error: { code: 'CONFLICT', message: 'A record with the same unique value already exists.' } }, 409);
  }
  if (/FOREIGN KEY constraint failed/i.test(message)) {
    return json({ error: { code: 'RECORD_IN_USE', message: 'The record is referenced by other data and cannot be removed.' } }, 409);
  }
  console.error('Unhandled API error', error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : 'Unknown error');
  return json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' } }, 500);
}

export function assertMutationOrigin(request: Request, env: Env): void {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite === 'cross-site') throw new ApiError(403, 'CROSS_SITE_REQUEST', 'Cross-site mutations are not allowed.');
  if (!origin) return;
  const requestOrigin = new URL(request.url).origin;
  const allowed = new Set([requestOrigin]);
  for (const configured of (env.APP_ORIGIN ?? '').split(',')) {
    const value = configured.trim();
    if (value) allowed.add(value.replace(/\/$/, ''));
  }
  if (!allowed.has(origin.replace(/\/$/, ''))) {
    throw new ApiError(403, 'INVALID_ORIGIN', 'Request origin is not allowed.');
  }
}

export function requireMethod(actual: string, allowed: string[]): void {
  if (!allowed.includes(actual)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', `Allowed methods: ${allowed.join(', ')}.`);
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function auditDetails(value: unknown): string {
  const serialized = JSON.stringify(value ?? {});
  return serialized.length <= 2_000 ? serialized : JSON.stringify({ truncated: true });
}
