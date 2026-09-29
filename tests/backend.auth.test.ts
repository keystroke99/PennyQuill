import { describe, expect, it } from 'vitest';
import worker from '../worker/src/index';
import { passwordForPolicy } from '../worker/src/auth';
import { hashPassword, verifyPassword } from '../worker/src/security';
import type { D1Database, D1PreparedStatement, D1Result, D1Value, Env } from '../worker/src/types';

interface CapturedStatement {
  query: string;
  values: D1Value[];
}

class FakeStatement implements D1PreparedStatement {
  values: D1Value[] = [];

  constructor(public readonly db: FakeDatabase, public readonly query: string) {}

  bind(...values: D1Value[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = Record<string, unknown>>(_columnName?: string): Promise<T | null> {
    return this.db.first(this.query) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return { success: true, results: this.db.all(this.query) as T[] };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.db.runs.push({ query: this.query, values: this.values });
    return { success: true };
  }
}

class FakeDatabase implements D1Database {
  readonly prepared: string[] = [];
  readonly runs: CapturedStatement[] = [];
  readonly batches: CapturedStatement[][] = [];
  sessionUser: Record<string, unknown> | null = null;
  household: Record<string, unknown> | null = { id: 'household-1', name: 'Household', currency: 'INR', timezone: 'Asia/Kolkata' };
  credentials: Record<string, unknown> | null = null;
  loginUser: Record<string, unknown> | null = null;
  attempts: Record<string, unknown> | null = null;

  prepare(query: string): D1PreparedStatement {
    this.prepared.push(query);
    return new FakeStatement(this, query);
  }

  async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.batches.push(statements.map((statement) => {
      const captured = statement as FakeStatement;
      return { query: captured.query, values: captured.values };
    }));
    return statements.map(() => ({ success: true }));
  }

  first(query: string): Record<string, unknown> | null {
    if (query.includes('FROM sessions s JOIN users u')) return this.sessionUser;
    if (query.includes('SELECT failed_count, window_started_at FROM auth_attempts')) return this.attempts;
    if (query.includes('FROM users u JOIN households h')) return this.loginUser;
    if (query.includes('SELECT password_hash, password_salt, password_iterations')) return this.credentials;
    if (query.includes('SELECT id, name, currency, timezone FROM households')) return this.household;
    return null;
  }

  all(_query: string): Record<string, unknown>[] {
    return [];
  }
}

function testEnv(db: FakeDatabase): Env {
  return { DB: db, APP_SETUP_KEY: 'a-production-setup-key' };
}

function authenticatedUser(mustChangePassword: boolean, role = 'member'): Record<string, unknown> {
  return {
    session_id: 'session-1',
    id: 'user-1',
    household_id: 'household-1',
    email: 'person@example.com',
    display_name: 'Person',
    role,
    must_change_password: mustChangePassword ? 1 : 0,
  };
}

function apiRequest(path: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  headers.set('Cookie', 'pennyquill_session=test-session-token');
  if (init?.body) headers.set('Content-Type', 'application/json');
  return new Request(`https://app.example.com${path}`, { ...init, headers });
}

describe('password policy', () => {
  it('allows an eight-character temporary password but enforces the strong permanent policy', () => {
    expect(passwordForPolicy({ password: '24681357' }, 'password', true)).toBe('24681357');
    expect(() => passwordForPolicy({ password: '24681357' }, 'password')).toThrowError(/12 characters/);
    expect(passwordForPolicy({ password: 'StrongPassword123' }, 'password')).toBe('StrongPassword123');
  });

  it('binds production password hashes to the separate secret pepper', async () => {
    const stored = await hashPassword('StrongPassword123', 'a-production-password-pepper-value');
    expect(await verifyPassword('StrongPassword123', stored.hash, stored.salt, stored.iterations, 'a-production-password-pepper-value')).toBe(true);
    expect(await verifyPassword('StrongPassword123', stored.hash, stored.salt, stored.iterations, 'a-different-password-pepper-value')).toBe(false);
  });
});

describe('forced password change', () => {
  it('allows the session endpoint but blocks other authenticated APIs', async () => {
    const db = new FakeDatabase();
    db.sessionUser = authenticatedUser(true);

    const meResponse = await worker.fetch(apiRequest('/api/auth/me'), testEnv(db));
    expect(meResponse.status).toBe(200);
    expect((await meResponse.json() as { user: { mustChangePassword: boolean } }).user.mustChangePassword).toBe(true);

    const blockedResponse = await worker.fetch(apiRequest('/api/dashboard'), testEnv(db));
    expect(blockedResponse.status).toBe(403);
    expect((await blockedResponse.json() as { error: { code: string } }).error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('changes the password, clears the flag, revokes other sessions, and audits', async () => {
    const db = new FakeDatabase();
    db.sessionUser = authenticatedUser(true);
    const current = await hashPassword('24681357');
    db.credentials = { password_hash: current.hash, password_salt: current.salt, password_iterations: current.iterations };

    const response = await worker.fetch(apiRequest('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: '24681357', newPassword: 'NewPassword123' }),
    }), testEnv(db));

    expect(response.status).toBe(200);
    expect((await response.json() as { user: { mustChangePassword: boolean } }).user.mustChangePassword).toBe(false);
    const queries = db.batches[0]!.map((statement) => statement.query).join('\n');
    expect(queries).toContain('must_change_password = 0');
    expect(queries).toContain('id <> ?');
    expect(queries).toContain('auth.password_changed');
  });

  it('defaults managed users to a forced change and accepts an eight-character temporary password', async () => {
    const db = new FakeDatabase();
    db.sessionUser = authenticatedUser(false, 'admin');
    const response = await worker.fetch(apiRequest('/api/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'new@example.com', displayName: 'New User', role: 'member', password: '24681357' }),
    }), testEnv(db));

    expect(response.status).toBe(201);
    expect((await response.json() as { item: { mustChangePassword: boolean } }).item.mustChangePassword).toBe(true);
    const userInsert = db.batches[0]!.find((statement) => statement.query.includes('INSERT INTO users'))!;
    expect(userInsert.values[8]).toBe(1);
  });
});

describe('security response headers', () => {
  it('marks API responses private and non-embeddable', async () => {
    const response = await worker.fetch(new Request('https://app.example.com/api/health'), testEnv(new FakeDatabase()));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});

describe('login abuse controls', () => {
  it('returns the forced-change state and clears failures after a successful login', async () => {
    const db = new FakeDatabase();
    const stored = await hashPassword('Temporary123');
    db.loginUser = {
      id: 'user-1', household_id: 'household-1', email: 'person@example.com', display_name: 'Person', role: 'member', active: 1,
      must_change_password: 1, password_hash: stored.hash, password_salt: stored.salt, password_iterations: stored.iterations,
      household_name: 'Household', household_currency: 'INR', household_timezone: 'Asia/Kolkata',
    };
    const response = await worker.fetch(new Request('https://app.example.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.com', password: 'Temporary123' }),
    }), testEnv(db));

    expect(response.status).toBe(200);
    expect((await response.json() as { user: { mustChangePassword: boolean } }).user.mustChangePassword).toBe(true);
    const queries = db.batches[0]!.map((statement) => statement.query).join('\n');
    expect(queries).toContain('INSERT INTO sessions');
    expect(queries).toContain('DELETE FROM auth_attempts');
  });

  it('returns the generic credential error and records a hashed-identifier failure for an unknown account', async () => {
    const db = new FakeDatabase();
    const response = await worker.fetch(new Request('https://app.example.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'missing@example.com', password: 'incorrect' }),
    }), testEnv(db));

    expect(response.status).toBe(401);
    const body = await response.json() as { error: { code: string; message: string } };
    expect(body.error).toEqual({ code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' });
    const failure = db.runs.find((statement) => statement.query.includes('INSERT INTO auth_attempts'))!;
    expect(failure.values[0]).not.toBe('missing@example.com');
  });

  it('blocks attempts after eight failures in the active window', async () => {
    const db = new FakeDatabase();
    db.attempts = { failed_count: 8, window_started_at: new Date().toISOString() };
    const response = await worker.fetch(new Request('https://app.example.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'person@example.com', password: 'incorrect' }),
    }), testEnv(db));

    expect(response.status).toBe(429);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('TOO_MANY_LOGIN_ATTEMPTS');
    expect(db.prepared.some((query) => query.includes('FROM users u JOIN households h'))).toBe(false);
  });
});
