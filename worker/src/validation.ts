export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('Content-Length') ?? '0');
  if (contentLength > 1_000_000) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'JSON body must be under 1 MB.');
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body must contain valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

export function requiredString(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number; trim?: boolean } = {},
): string {
  const value = body[key];
  if (typeof value !== 'string') throw new ApiError(422, 'VALIDATION_ERROR', `${key} must be a string.`);
  const normalized = options.trim === false ? value : value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 500;
  if (normalized.length < min || normalized.length > max) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${key} must be between ${min} and ${max} characters.`);
  }
  return normalized;
}

export function optionalString(body: Record<string, unknown>, key: string, max = 500): string | null {
  const value = body[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ApiError(422, 'VALIDATION_ERROR', `${key} must be a string or null.`);
  const normalized = value.trim();
  if (normalized.length > max) throw new ApiError(422, 'VALIDATION_ERROR', `${key} must be at most ${max} characters.`);
  return normalized || null;
}

export function optionalId(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 100) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${key} must be a valid identifier or null.`);
  }
  return value;
}

export function integer(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): number {
  const value = body[key];
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function optionalInteger(
  body: Record<string, unknown>, key: string, fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  return body[key] === undefined ? fallback : integer(body, key, options);
}

export function booleanValue(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ApiError(422, 'VALIDATION_ERROR', `${key} must be a boolean.`);
  return value;
}

export function enumValue<T extends string>(body: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = body[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${key} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

export function optionalEnum<T extends string>(
  body: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T,
): T {
  return body[key] === undefined ? fallback : enumValue(body, key, allowed);
}

export function emailAddress(body: Record<string, unknown>, key = 'email'): string {
  const email = requiredString(body, key, { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${key} must be a valid email address.`);
  }
  return email;
}

export function isoDate(value: unknown, key: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${key} must use YYYY-MM-DD.`);
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${key} is not a real calendar date.`);
  }
  return value;
}

export function optionalIsoDate(value: unknown, key: string): string | null {
  return value === undefined || value === null || value === '' ? null : isoDate(value, key);
}

export function hexColor(body: Record<string, unknown>, key: string, fallback: string): string {
  if (body[key] === undefined) return fallback;
  const value = requiredString(body, key, { min: 4, max: 9 });
  if (!/^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?$/.test(value)) {
    throw new ApiError(422, 'VALIDATION_ERROR', `${key} must be a CSS hex color.`);
  }
  return value.toUpperCase();
}

export function pagination(url: URL, defaultPageSize = 25): { page: number; pageSize: number; offset: number } {
  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const pageSize = Number.parseInt(url.searchParams.get('pageSize') ?? String(defaultPageSize), 10);
  if (!Number.isInteger(page) || page < 1 || page > 100_000) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'page must be an integer between 1 and 100000.');
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'pageSize must be an integer between 1 and 100.');
  }
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function dateRange(url: URL, defaultDays = 30): { from: string; to: string } {
  const now = new Date();
  const defaultTo = now.toISOString().slice(0, 10);
  const fromDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - defaultDays + 1));
  const from = url.searchParams.has('from') ? isoDate(url.searchParams.get('from'), 'from') : fromDate.toISOString().slice(0, 10);
  const to = url.searchParams.has('to') ? isoDate(url.searchParams.get('to'), 'to') : defaultTo;
  if (from > to) throw new ApiError(422, 'VALIDATION_ERROR', 'from must be on or before to.');
  const spanDays = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (spanDays > 3_653) throw new ApiError(422, 'VALIDATION_ERROR', 'Date range cannot exceed 10 years.');
  return { from, to };
}

export function queryId(url: URL, key: string): string | null {
  const value = url.searchParams.get(key);
  if (!value) return null;
  if (value.length > 100) throw new ApiError(422, 'VALIDATION_ERROR', `${key} is invalid.`);
  return value;
}
