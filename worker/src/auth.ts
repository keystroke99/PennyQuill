import { auditDetails, isoNow, json, noContent, requireMethod } from './http';
import { clearSessionCookie, constantTimeEqual, createSessionToken, hashAuthIdentifier, hashPassword, hashSessionToken, newId, parseCookies, SESSION_COOKIE, sessionCookie, sessionDurationDays, verifyPassword } from './security';
import type { AuthContext, RouteContext } from './types';
import { ApiError, emailAddress, readJsonObject, requiredString } from './validation';

const DEFAULT_CATEGORIES = [
  ['Housing', 'expense', 'essential', 'house', '#2563EB'], ['Food & Dining', 'expense', 'essential', 'utensils', '#EA580C'],
  ['Groceries', 'expense', 'essential', 'shopping-basket', '#16A34A'], ['Transport', 'expense', 'essential', 'car-front', '#0891B2'],
  ['Utilities', 'expense', 'essential', 'plug-zap', '#7C3AED'], ['Healthcare', 'expense', 'essential', 'heart-pulse', '#DC2626'],
  ['Education', 'expense', 'essential', 'graduation-cap', '#4F46E5'], ['Insurance', 'expense', 'essential', 'shield-check', '#0F766E'],
  ['Shopping', 'expense', 'discretionary', 'shopping-bag', '#DB2777'], ['Entertainment', 'expense', 'discretionary', 'clapperboard', '#9333EA'],
  ['Travel', 'expense', 'discretionary', 'plane', '#0284C7'], ['Personal Care', 'expense', 'discretionary', 'sparkles', '#C026D3'],
  ['Gifts & Donations', 'expense', 'discretionary', 'gift', '#E11D48'], ['Taxes & Fees', 'expense', 'essential', 'landmark', '#475569'],
  ['Other Expense', 'expense', 'discretionary', 'circle-ellipsis', '#64748B'], ['Refunds', 'expense', 'discretionary', 'rotate-ccw', '#059669'],
  ['Salary', 'income', 'savings', 'briefcase-business', '#16A34A'], ['Business Income', 'income', 'savings', 'store', '#0D9488'],
  ['Investment Income', 'income', 'savings', 'chart-no-axes-combined', '#2563EB'], ['Other Income', 'income', 'savings', 'badge-indian-rupee', '#65A30D'],
] as const;

const LOGIN_FAILURE_LIMIT = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const AUTH_ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DUMMY_PASSWORD_HASH = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const DUMMY_PASSWORD_SALT = 'AAAAAAAAAAAAAAAAAAAAAA';
const DUMMY_PASSWORD_ITERATIONS = 100_000;

function publicUser(row: Record<string, unknown>) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    householdId: row.household_id,
    active: Boolean(row.active),
    mustChangePassword: Boolean(row.must_change_password),
  };
}

export function passwordForPolicy(body: Record<string, unknown>, key: string, temporary = false): string {
  const password = requiredString(body, key, { min: 1, max: 128, trim: false });
  if (temporary) {
    if (password.length < 8) throw new ApiError(422, 'WEAK_PASSWORD', 'Temporary passwords must contain at least 8 characters.');
    return password;
  }
  if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new ApiError(422, 'WEAK_PASSWORD', 'Password must contain at least 12 characters, including at least one letter and one number.');
  }
  return password;
}

export async function authenticate(ctx: RouteContext): Promise<AuthContext> {
  const token = parseCookies(ctx.request)[SESSION_COOKIE];
  if (!token) throw new ApiError(401, 'AUTHENTICATION_REQUIRED', 'Sign in to continue.');
  const row = await ctx.env.DB.prepare(`SELECT s.id AS session_id, u.id, u.household_id, u.email, u.display_name, u.role, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).bind(await hashSessionToken(token), isoNow()).first<Record<string, unknown>>();
  if (!row) throw new ApiError(401, 'SESSION_EXPIRED', 'Your session is missing or expired.');
  return {
    sessionId: String(row.session_id),
    userId: String(row.id),
    householdId: String(row.household_id),
    email: String(row.email),
    displayName: String(row.display_name),
    role: row.role as AuthContext['role'],
    mustChangePassword: Boolean(row.must_change_password),
  };
}

export function requireWrite(auth: AuthContext): void {
  if (auth.role === 'viewer') throw new ApiError(403, 'READ_ONLY_ROLE', 'This account has read-only access.');
}

export function requireAdmin(auth: AuthContext): void {
  if (!['owner', 'admin'].includes(auth.role)) throw new ApiError(403, 'ADMIN_REQUIRED', 'Household administrator access is required.');
}

export async function handleSetupStatus(ctx: RouteContext): Promise<Response> {
  requireMethod(ctx.request.method, ['GET']);
  const configured = Boolean(await ctx.env.DB.prepare('SELECT 1 AS configured FROM setup_state WHERE id = 1').first());
  return json({ configured });
}

export async function handleSetup(ctx: RouteContext): Promise<Response> {
  requireMethod(ctx.request.method, ['POST']);
  if (!ctx.env.APP_SETUP_KEY || ctx.env.APP_SETUP_KEY.length < 16) throw new ApiError(503, 'SETUP_KEY_NOT_CONFIGURED', 'APP_SETUP_KEY must contain at least 16 characters.');
  if (ctx.env.APP_ENV === 'production' && (!ctx.env.PASSWORD_PEPPER || ctx.env.PASSWORD_PEPPER.length < 32)) {
    throw new ApiError(503, 'PASSWORD_PEPPER_NOT_CONFIGURED', 'PASSWORD_PEPPER must contain at least 32 characters in production.');
  }
  if (await ctx.env.DB.prepare('SELECT 1 FROM setup_state WHERE id = 1').first()) throw new ApiError(409, 'ALREADY_CONFIGURED', 'Application setup has already been completed.');
  const body = await readJsonObject(ctx.request);
  const suppliedKey = ctx.request.headers.get('X-Setup-Key') ?? (typeof body.setupKey === 'string' ? body.setupKey : '');
  if (!(await constantTimeEqual(suppliedKey, ctx.env.APP_SETUP_KEY))) throw new ApiError(403, 'INVALID_SETUP_KEY', 'The setup key is invalid.');
  const householdName = requiredString(body, 'householdName', { max: 100 });
  const displayName = requiredString(body, 'displayName', { max: 100 });
  const email = emailAddress(body);
  const password = passwordForPolicy(body, 'password');
  const currency = (typeof body.currency === 'string' ? body.currency : 'INR').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ApiError(422, 'VALIDATION_ERROR', 'currency must be a 3-letter ISO code.');
  const timezone = (typeof body.timezone === 'string' ? body.timezone : 'Asia/Kolkata').trim();
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw new ApiError(422, 'VALIDATION_ERROR', 'timezone must be a valid IANA timezone.'); }

  const now = isoNow();
  const householdId = newId(); const userId = newId(); const memberId = newId(); const accountId = newId();
  const passwordData = await hashPassword(password, ctx.env.PASSWORD_PEPPER);
  const token = createSessionToken(); const tokenHash = await hashSessionToken(token);
  const days = sessionDurationDays(ctx.env); const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  const statements = [
    ctx.env.DB.prepare('INSERT INTO setup_state (id, completed_at, schema_version) VALUES (1, ?, 2)').bind(now),
    ctx.env.DB.prepare('INSERT INTO households (id, name, currency, timezone, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(householdId, householdName, currency, timezone, now, now),
    ctx.env.DB.prepare(`INSERT INTO users (id, household_id, email, display_name, role, password_hash, password_salt, password_iterations, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, 0, ?, ?)`).bind(userId, householdId, email, displayName, passwordData.hash, passwordData.salt, passwordData.iterations, now, now),
    ctx.env.DB.prepare(`INSERT INTO members (id, household_id, user_id, name, relationship, avatar_icon, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'self', 'user-round', ?, ?)`).bind(memberId, householdId, userId, displayName, now, now),
    ctx.env.DB.prepare(`INSERT INTO accounts (id, household_id, name, type, currency, opening_balance_minor, icon, color, created_at, updated_at)
      VALUES (?, ?, 'Cash', 'cash', ?, 0, 'wallet', '#16A34A', ?, ?)`).bind(accountId, householdId, currency, now, now),
    ...DEFAULT_CATEGORIES.map(([name, kind, classification, icon, color]) => ctx.env.DB.prepare(`INSERT INTO categories
      (id, household_id, name, kind, classification, icon, color, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(newId(), householdId, name, kind, classification, icon, color, now, now)),
    ctx.env.DB.prepare(`INSERT INTO sessions (id, user_id, household_id, token_hash, expires_at, created_at, last_seen_at, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(newId(), userId, householdId, tokenHash, expiresAt, now, now, (ctx.request.headers.get('User-Agent') ?? '').slice(0, 300)),
    ctx.env.DB.prepare(`INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, details_json, created_at)
      VALUES (?, ?, ?, 'setup.completed', 'household', ?, ?, ?)`).bind(newId(), householdId, userId, householdId, auditDetails({ schemaVersion: 2 }), now),
  ];
  try { await ctx.env.DB.batch(statements); } catch (error) {
    if (/setup_state|UNIQUE constraint/i.test(error instanceof Error ? error.message : String(error))) throw new ApiError(409, 'ALREADY_CONFIGURED', 'Application setup has already been completed.');
    throw error;
  }
  return json({ user: { id: userId, email, displayName, role: 'owner', householdId, active: true, mustChangePassword: false }, household: { id: householdId, name: householdName, currency, timezone } }, 201, { 'Set-Cookie': sessionCookie(token, days * 86_400) });
}

export async function handleLogin(ctx: RouteContext): Promise<Response> {
  requireMethod(ctx.request.method, ['POST']);
  const body = await readJsonObject(ctx.request); const email = emailAddress(body);
  const password = requiredString(body, 'password', { min: 1, max: 128, trim: false });
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const windowCutoff = new Date(nowMs - LOGIN_WINDOW_MS).toISOString();
  const emailHash = await hashAuthIdentifier(email);
  await ctx.env.DB.prepare('DELETE FROM auth_attempts WHERE last_attempt_at <= ?').bind(new Date(nowMs - AUTH_ATTEMPT_RETENTION_MS).toISOString()).run();
  const attempts = await ctx.env.DB.prepare('SELECT failed_count, window_started_at FROM auth_attempts WHERE email_hash = ?').bind(emailHash).first<Record<string, unknown>>();
  if (attempts && String(attempts.window_started_at) > windowCutoff && Number(attempts.failed_count) >= LOGIN_FAILURE_LIMIT) {
    throw new ApiError(429, 'TOO_MANY_LOGIN_ATTEMPTS', 'Too many sign-in attempts. Try again later.');
  }

  const row = await ctx.env.DB.prepare(`SELECT u.id, u.household_id, u.email, u.display_name, u.role, u.active, u.must_change_password, u.password_hash, u.password_salt, u.password_iterations,
    h.name AS household_name, h.currency AS household_currency, h.timezone AS household_timezone
    FROM users u JOIN households h ON h.id = u.household_id WHERE lower(u.email) = lower(?) LIMIT 1`).bind(email).first<Record<string, unknown>>();
  const canAuthenticate = Boolean(row?.active);
  const passwordValid = await verifyPassword(
    password,
    canAuthenticate ? String(row!.password_hash) : DUMMY_PASSWORD_HASH,
    canAuthenticate ? String(row!.password_salt) : DUMMY_PASSWORD_SALT,
    canAuthenticate ? Number(row!.password_iterations) : DUMMY_PASSWORD_ITERATIONS,
    ctx.env.PASSWORD_PEPPER,
  );
  if (!canAuthenticate || !passwordValid) {
    await ctx.env.DB.prepare(`INSERT INTO auth_attempts (email_hash, failed_count, window_started_at, last_attempt_at) VALUES (?, 1, ?, ?)
      ON CONFLICT(email_hash) DO UPDATE SET
        failed_count = CASE WHEN auth_attempts.window_started_at <= ? THEN 1 ELSE auth_attempts.failed_count + 1 END,
        window_started_at = CASE WHEN auth_attempts.window_started_at <= ? THEN excluded.window_started_at ELSE auth_attempts.window_started_at END,
        last_attempt_at = excluded.last_attempt_at`).bind(emailHash, now, now, windowCutoff, windowCutoff).run();
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  const days = sessionDurationDays(ctx.env); const token = createSessionToken();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(`INSERT INTO sessions (id, user_id, household_id, token_hash, expires_at, created_at, last_seen_at, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(newId(), String(row!.id), String(row!.household_id), await hashSessionToken(token), new Date(nowMs + days * 86_400_000).toISOString(), now, now, (ctx.request.headers.get('User-Agent') ?? '').slice(0, 300)),
    ctx.env.DB.prepare('DELETE FROM auth_attempts WHERE email_hash = ?').bind(emailHash),
  ]);
  return json({ user: publicUser(row!), household: {
    id: row!.household_id, name: row!.household_name, currency: row!.household_currency, timezone: row!.household_timezone,
  } }, 200, { 'Set-Cookie': sessionCookie(token, days * 86_400) });
}

export async function handleLogout(ctx: RouteContext): Promise<Response> {
  requireMethod(ctx.request.method, ['POST']);
  const token = parseCookies(ctx.request)[SESSION_COOKIE];
  if (token) await ctx.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await hashSessionToken(token)).run();
  return noContent({ 'Set-Cookie': clearSessionCookie() });
}

export async function handleMe(ctx: RouteContext): Promise<Response> {
  requireMethod(ctx.request.method, ['GET']);
  const auth = ctx.auth!;
  const household = await ctx.env.DB.prepare('SELECT id, name, currency, timezone FROM households WHERE id = ?').bind(auth.householdId).first<Record<string, unknown>>();
  return json({ user: { id: auth.userId, email: auth.email, displayName: auth.displayName, role: auth.role, householdId: auth.householdId, active: true, mustChangePassword: auth.mustChangePassword }, household: household && { id: household.id, name: household.name, currency: household.currency, timezone: household.timezone } });
}

export async function handleChangePassword(ctx: RouteContext): Promise<Response> {
  requireMethod(ctx.request.method, ['POST']);
  const body = await readJsonObject(ctx.request);
  const currentPassword = requiredString(body, 'currentPassword', { min: 1, max: 128, trim: false });
  const newPassword = passwordForPolicy(body, 'newPassword');
  const auth = ctx.auth!;
  const credentials = await ctx.env.DB.prepare(`SELECT password_hash, password_salt, password_iterations
    FROM users WHERE id = ? AND household_id = ? AND active = 1`).bind(auth.userId, auth.householdId).first<Record<string, unknown>>();
  if (!credentials || !(await verifyPassword(currentPassword, String(credentials.password_hash), String(credentials.password_salt), Number(credentials.password_iterations), ctx.env.PASSWORD_PEPPER))) {
    throw new ApiError(401, 'INVALID_CURRENT_PASSWORD', 'The current password is incorrect.');
  }

  const passwordData = await hashPassword(newPassword, ctx.env.PASSWORD_PEPPER);
  const now = isoNow();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, must_change_password = 0, updated_at = ?
      WHERE id = ? AND household_id = ?`).bind(passwordData.hash, passwordData.salt, passwordData.iterations, now, auth.userId, auth.householdId),
    ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND household_id = ? AND id <> ?').bind(auth.userId, auth.householdId, auth.sessionId),
    ctx.env.DB.prepare(`INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, details_json, created_at)
      VALUES (?, ?, ?, 'auth.password_changed', 'users', ?, ?, ?)`).bind(newId(), auth.householdId, auth.userId, auth.userId, auditDetails({ otherSessionsRevoked: true }), now),
  ]);
  auth.mustChangePassword = false;
  return json({ user: { id: auth.userId, email: auth.email, displayName: auth.displayName, role: auth.role, householdId: auth.householdId, active: true, mustChangePassword: false } });
}
