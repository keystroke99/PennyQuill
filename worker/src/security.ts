import type { Env } from './types';

const encoder = new TextEncoder();
// Cloudflare Workers Web Crypto currently caps PBKDF2 at 100,000 iterations.
// A production-only secret pepper adds protection if D1 alone is exposed.
const PASSWORD_ITERATIONS = 100_000;
export const SESSION_COOKIE = 'pennyquill_session';

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256Bytes(value: string): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return new Uint8Array(digest);
}

export async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([sha256Bytes(left), sha256Bytes(right)]);
  let mismatch = 0;
  for (let index = 0; index < leftDigest.length; index += 1) {
    mismatch |= leftDigest[index]! ^ rightDigest[index]!;
  }
  return mismatch === 0;
}

function passwordMaterial(password: string, pepper = ''): Uint8Array<ArrayBuffer> {
  return encoder.encode(pepper ? `${password}\u0000${pepper}` : password);
}

export async function hashPassword(password: string, pepper = '', salt?: Uint8Array<ArrayBuffer>): Promise<{
  hash: string;
  salt: string;
  iterations: number;
}> {
  const actualSalt = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', passwordMaterial(password, pepper), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: actualSalt, iterations: PASSWORD_ITERATIONS },
    key,
    256,
  );
  return {
    hash: bytesToBase64Url(new Uint8Array(bits)),
    salt: bytesToBase64Url(actualSalt),
    iterations: PASSWORD_ITERATIONS,
  };
}

export async function verifyPassword(
  password: string,
  expectedHash: string,
  salt: string,
  iterations: number,
  pepper = '',
): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', passwordMaterial(password, pepper), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: base64UrlToBytes(salt), iterations },
    key,
    256,
  );
  const actual = new Uint8Array(bits);
  const expected = base64UrlToBytes(expectedHash);
  if (actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < actual.length; index += 1) mismatch |= actual[index]! ^ expected[index]!;
  return mismatch === 0;
}

export function createSessionToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashSessionToken(token: string): Promise<string> {
  return bytesToBase64Url(await sha256Bytes(token));
}

export async function hashAuthIdentifier(value: string): Promise<string> {
  return bytesToBase64Url(await sha256Bytes(value.trim().toLowerCase()));
}

export function parseCookies(request: Request): Record<string, string> {
  const result: Record<string, string> = {};
  const header = request.headers.get('Cookie') ?? '';
  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 1) continue;
    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export function sessionDurationDays(env: Env): number {
  const parsed = Number.parseInt(env.SESSION_DAYS ?? '30', 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 90 ? parsed : 30;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function newId(): string {
  return crypto.randomUUID();
}
