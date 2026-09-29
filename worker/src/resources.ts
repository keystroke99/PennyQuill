import { passwordForPolicy, requireAdmin, requireWrite } from './auth';
import { auditDetails, isoNow, json, noContent } from './http';
import { hashPassword, newId } from './security';
import type { D1Value, RouteContext } from './types';
import { ApiError, booleanValue, emailAddress, enumValue, hexColor, integer, isoDate, optionalId, optionalInteger, optionalIsoDate, optionalString, pagination, readJsonObject, requiredString } from './validation';

type ResourceName = 'members' | 'categories' | 'accounts' | 'budgets' | 'recurring' | 'goals';
type Values = Record<string, D1Value>;

const CONFIG = {
  members: { table: 'members', order: 'name COLLATE NOCASE', booleans: ['active'], refs: { user_id: 'users' } },
  categories: { table: 'categories', order: 'name COLLATE NOCASE', booleans: ['is_system', 'active'], refs: { parent_id: 'categories' } },
  accounts: { table: 'accounts', order: 'name COLLATE NOCASE', booleans: ['include_in_net_worth', 'active'], refs: {} },
  budgets: { table: 'budgets', order: 'starts_on DESC', booleans: ['rollover', 'active'], refs: { category_id: 'categories', member_id: 'members' } },
  recurring: { table: 'recurring_rules', order: 'next_due_on, name COLLATE NOCASE', booleans: ['auto_post', 'active'], refs: { member_id: 'members', category_id: 'categories', account_id: 'accounts' } },
  goals: { table: 'goals', order: 'active DESC, target_date, name COLLATE NOCASE', booleans: ['active'], refs: { member_id: 'members' } },
} as const;

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function serialize(row: Record<string, unknown>, booleans: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [snakeToCamel(key), booleans.includes(key) ? Boolean(value) : value]));
}

function dateInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function advanceBudgetDate(value: string, period: string): string {
  const source = new Date(`${value}T00:00:00Z`);
  if (period === 'weekly') {
    source.setUTCDate(source.getUTCDate() + 7);
    return source.toISOString().slice(0, 10);
  }
  const months = period === 'monthly' ? 1 : period === 'quarterly' ? 3 : period === 'half_yearly' ? 6 : 12;
  const day = source.getUTCDate();
  source.setUTCDate(1);
  source.setUTCMonth(source.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + 1, 0)).getUTCDate();
  source.setUTCDate(Math.min(day, lastDay));
  return source.toISOString().slice(0, 10);
}

function currentBudgetCycleStart(item: Record<string, unknown>, today: string): string {
  let start = String(item.startsOn);
  const period = String(item.period);
  if (period === 'custom' || start > today) return start;
  for (let guard = 0; guard < 1_000; guard += 1) {
    const next = advanceBudgetDate(start, period);
    if (next > today) return start;
    start = next;
  }
  throw new ApiError(500, 'BUDGET_RANGE_ERROR', 'The budget cycle could not be calculated.');
}

function existingBody(existing: Record<string, unknown> | null, dbKey: string): unknown {
  return existing ? existing[dbKey] : undefined;
}

function merged(body: Record<string, unknown>, apiKey: string, existing: Record<string, unknown> | null, dbKey: string, fallback?: unknown): unknown {
  return body[apiKey] !== undefined ? body[apiKey] : (existingBody(existing, dbKey) ?? fallback);
}

function stringField(body: Record<string, unknown>, key: string, existing: Record<string, unknown> | null, dbKey: string, max: number, fallback?: string): string {
  const value = merged(body, key, existing, dbKey, fallback);
  return requiredString({ [key]: value }, key, { max });
}

function optionalStringField(body: Record<string, unknown>, key: string, existing: Record<string, unknown> | null, dbKey: string, max: number): string | null {
  return optionalString({ [key]: merged(body, key, existing, dbKey, null) }, key, max);
}

function idField(body: Record<string, unknown>, key: string, existing: Record<string, unknown> | null, dbKey: string): string | null {
  return optionalId({ [key]: merged(body, key, existing, dbKey, null) }, key);
}

function enumField<T extends string>(body: Record<string, unknown>, key: string, existing: Record<string, unknown> | null, dbKey: string, allowed: readonly T[], fallback?: T): T {
  return enumValue({ [key]: merged(body, key, existing, dbKey, fallback) }, key, allowed);
}

function boolField(body: Record<string, unknown>, key: string, existing: Record<string, unknown> | null, dbKey: string, fallback: boolean): number {
  const value = body[key] !== undefined ? body[key] : existing ? Boolean(existing[dbKey]) : fallback;
  return booleanValue({ [key]: value }, key, fallback) ? 1 : 0;
}

function intField(body: Record<string, unknown>, key: string, existing: Record<string, unknown> | null, dbKey: string, min: number, max: number, fallback?: number): number {
  return integer({ [key]: merged(body, key, existing, dbKey, fallback) }, key, { min, max });
}

function inputFor(resource: ResourceName, body: Record<string, unknown>, existing: Record<string, unknown> | null): Values {
  switch (resource) {
    case 'members': return {
      user_id: idField(body, 'userId', existing, 'user_id'), name: stringField(body, 'name', existing, 'name', 100),
      relationship: stringField(body, 'relationship', existing, 'relationship', 50, 'family'),
      avatar_icon: stringField(body, 'avatarIcon', existing, 'avatar_icon', 80, 'user-round'), active: boolField(body, 'active', existing, 'active', true),
    };
    case 'categories': return {
      parent_id: idField(body, 'parentId', existing, 'parent_id'), name: stringField(body, 'name', existing, 'name', 80),
      kind: enumField(body, 'kind', existing, 'kind', ['expense', 'income', 'both'] as const),
      classification: enumField(body, 'classification', existing, 'classification', ['essential', 'discretionary', 'savings'] as const, 'discretionary'),
      icon: stringField(body, 'icon', existing, 'icon', 80, 'circle-dollar-sign'),
      color: hexColor({ color: merged(body, 'color', existing, 'color', '#64748B') }, 'color', '#64748B'),
      is_system: existing ? Number(existing.is_system) : 0, active: boolField(body, 'active', existing, 'active', true),
    };
    case 'accounts': {
      const currency = stringField(body, 'currency', existing, 'currency', 3, 'INR').toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new ApiError(422, 'VALIDATION_ERROR', 'currency must be a 3-letter ISO code.');
      return {
        name: stringField(body, 'name', existing, 'name', 80), type: enumField(body, 'type', existing, 'type', ['cash', 'bank', 'credit_card', 'wallet', 'investment', 'other'] as const),
        currency, opening_balance_minor: intField(body, 'openingBalanceMinor', existing, 'opening_balance_minor', -9_000_000_000_000, 9_000_000_000_000, 0),
        include_in_net_worth: boolField(body, 'includeInNetWorth', existing, 'include_in_net_worth', true),
        icon: stringField(body, 'icon', existing, 'icon', 80, 'wallet-cards'), color: hexColor({ color: merged(body, 'color', existing, 'color', '#2563EB') }, 'color', '#2563EB'),
        active: boolField(body, 'active', existing, 'active', true),
      };
    }
    case 'budgets': {
      const startsOn = isoDate(merged(body, 'startsOn', existing, 'starts_on'), 'startsOn');
      const endsOn = optionalIsoDate(merged(body, 'endsOn', existing, 'ends_on', null), 'endsOn');
      if (endsOn && endsOn < startsOn) throw new ApiError(422, 'VALIDATION_ERROR', 'endsOn must not precede startsOn.');
      const rollover = boolField(body, 'rollover', existing, 'rollover', false);
      if (rollover) throw new ApiError(422, 'UNSUPPORTED_ROLLOVER', 'Budget rollover is not enabled. Create a new budget amount that includes any carried balance.');
      return {
        name: stringField(body, 'name', existing, 'name', 100), category_id: idField(body, 'categoryId', existing, 'category_id'), member_id: idField(body, 'memberId', existing, 'member_id'),
        period: enumField(body, 'period', existing, 'period', ['weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly', 'custom'] as const),
        amount_minor: intField(body, 'amountMinor', existing, 'amount_minor', 1, 9_000_000_000_000), starts_on: startsOn, ends_on: endsOn,
        rollover: 0, active: boolField(body, 'active', existing, 'active', true),
      };
    }
    case 'recurring': {
      const nextDueOn = isoDate(merged(body, 'nextDueOn', existing, 'next_due_on'), 'nextDueOn');
      const endsOn = optionalIsoDate(merged(body, 'endsOn', existing, 'ends_on', null), 'endsOn');
      if (endsOn && endsOn < nextDueOn) throw new ApiError(422, 'VALIDATION_ERROR', 'endsOn must not precede nextDueOn.');
      return {
        member_id: idField(body, 'memberId', existing, 'member_id'), category_id: idField(body, 'categoryId', existing, 'category_id'), account_id: idField(body, 'accountId', existing, 'account_id'),
        name: stringField(body, 'name', existing, 'name', 100), direction: enumField(body, 'direction', existing, 'direction', ['expense', 'income'] as const),
        amount_minor: intField(body, 'amountMinor', existing, 'amount_minor', 1, 9_000_000_000_000), merchant: optionalStringField(body, 'merchant', existing, 'merchant', 120),
        note: optionalStringField(body, 'note', existing, 'note', 500), cadence: enumField(body, 'cadence', existing, 'cadence', ['daily', 'weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly'] as const),
        interval_count: intField(body, 'intervalCount', existing, 'interval_count', 1, 100, 1), next_due_on: nextDueOn, ends_on: endsOn,
        auto_post: boolField(body, 'autoPost', existing, 'auto_post', false), active: boolField(body, 'active', existing, 'active', true),
      };
    }
    case 'goals': return {
      member_id: idField(body, 'memberId', existing, 'member_id'), name: stringField(body, 'name', existing, 'name', 100),
      goal_type: enumField(body, 'goalType', existing, 'goal_type', ['savings', 'debt_payoff', 'purchase', 'emergency_fund', 'other'] as const, 'savings'),
      target_minor: intField(body, 'targetMinor', existing, 'target_minor', 1, 9_000_000_000_000), current_minor: intField(body, 'currentMinor', existing, 'current_minor', 0, 9_000_000_000_000, 0),
      target_date: optionalIsoDate(merged(body, 'targetDate', existing, 'target_date', null), 'targetDate'),
      icon: stringField(body, 'icon', existing, 'icon', 80, 'goal'), color: hexColor({ color: merged(body, 'color', existing, 'color', '#16A34A') }, 'color', '#16A34A'),
      active: boolField(body, 'active', existing, 'active', true),
    };
  }
}

async function validateReferences(ctx: RouteContext, resource: ResourceName, values: Values, entityId?: string): Promise<void> {
  const refs = CONFIG[resource].refs as Record<string, string>;
  for (const [field, table] of Object.entries(refs)) {
    const value = values[field];
    if (!value) continue;
    if (resource === 'categories' && field === 'parent_id' && value === entityId) throw new ApiError(422, 'VALIDATION_ERROR', 'A category cannot be its own parent.');
    const found = await ctx.env.DB.prepare(`SELECT id FROM ${table} WHERE id = ? AND household_id = ?`).bind(value, ctx.auth!.householdId).first();
    if (!found) throw new ApiError(422, 'INVALID_REFERENCE', `${snakeToCamel(field)} does not belong to this household.`);
  }
  if ((resource === 'budgets' || resource === 'recurring') && values.category_id) {
    const category = await ctx.env.DB.prepare('SELECT kind FROM categories WHERE id = ? AND household_id = ?')
      .bind(values.category_id, ctx.auth!.householdId).first<{ kind: string }>();
    const direction = resource === 'budgets' ? 'expense' : String(values.direction);
    if (!category || ![direction, 'both'].includes(category.kind)) {
      throw new ApiError(422, 'INVALID_REFERENCE', `${direction === 'income' ? 'Income' : 'Expense'} rules require a matching category.`);
    }
  }
}

function selectSql(resource: ResourceName): string {
  if (resource !== 'accounts') return `SELECT * FROM ${CONFIG[resource].table}`;
  return `SELECT a.*, a.opening_balance_minor + COALESCE(SUM(CASE
    WHEN t.status <> 'cleared' THEN 0 WHEN t.direction IN ('income','refund') AND t.account_id = a.id THEN t.amount_minor
    WHEN t.direction = 'expense' AND t.account_id = a.id THEN -t.amount_minor
    WHEN t.direction = 'transfer' AND t.account_id = a.id THEN -t.amount_minor
    WHEN t.direction = 'transfer' AND t.transfer_account_id = a.id THEN t.amount_minor ELSE 0 END), 0) AS current_balance_minor
    FROM accounts a LEFT JOIN transactions t ON (t.account_id = a.id OR t.transfer_account_id = a.id)`;
}

export async function handleResource(ctx: RouteContext, resource: ResourceName, id?: string): Promise<Response> {
  const config = CONFIG[resource]; const auth = ctx.auth!;
  if (ctx.request.method === 'GET') {
    if (id) {
      const group = resource === 'accounts' ? ' GROUP BY a.id' : '';
      const alias = resource === 'accounts' ? 'a.' : '';
      const row = await ctx.env.DB.prepare(`${selectSql(resource)} WHERE ${alias}id = ? AND ${alias}household_id = ?${group}`).bind(id, auth.householdId).first<Record<string, unknown>>();
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Record not found.');
      return json(serialize(row, config.booleans));
    }
    const { page, pageSize, offset } = pagination(ctx.url, 100);
    const includeInactive = ctx.url.searchParams.get('includeInactive') === 'true';
    const alias = resource === 'accounts' ? 'a.' : '';
    const clauses = [`${alias}household_id = ?`]; const values: D1Value[] = [auth.householdId];
    if (!includeInactive) clauses.push(`${alias}active = 1`);
    if (resource === 'categories' && ctx.url.searchParams.get('kind')) { clauses.push(`kind IN (?, 'both')`); values.push(ctx.url.searchParams.get('kind')!); }
    const where = clauses.join(' AND '); const group = resource === 'accounts' ? ' GROUP BY a.id' : '';
    const [rows, count] = await Promise.all([
      ctx.env.DB.prepare(`${selectSql(resource)} WHERE ${where}${group} ORDER BY ${config.order} LIMIT ? OFFSET ?`).bind(...values, pageSize, offset).all<Record<string, unknown>>(),
      ctx.env.DB.prepare(`SELECT COUNT(*) AS total FROM ${config.table} ${resource === 'accounts' ? 'a' : ''} WHERE ${where}`).bind(...values).first<{ total: number }>(),
    ]);
    const total = Number(count?.total ?? 0);
    let items = (rows.results ?? []).map((row) => serialize(row, config.booleans));
    if (resource === 'budgets' && items.length) {
      const household = await ctx.env.DB.prepare('SELECT timezone FROM households WHERE id = ?').bind(auth.householdId).first<{ timezone: string }>();
      const today = dateInTimeZone(household?.timezone ?? 'UTC');
      const statements = items.map((item) => {
        const start = currentBudgetCycleStart(item, today);
        const configuredEnd = item.endsOn ? String(item.endsOn) : today;
        const end = configuredEnd < today ? configuredEnd : today;
        const clauses = ["household_id = ?", "status = 'cleared'", "direction IN ('expense','refund')", 'occurred_on >= ?', 'occurred_on <= ?'];
        const bound: D1Value[] = [String(item.id), auth.householdId, start, end];
        if (item.categoryId) { clauses.push('category_id = ?'); bound.push(String(item.categoryId)); }
        if (item.memberId) { clauses.push('member_id = ?'); bound.push(String(item.memberId)); }
        return ctx.env.DB.prepare(`SELECT ? AS id, COALESCE(SUM(CASE WHEN direction='expense' THEN amount_minor ELSE -amount_minor END),0) AS spent_minor FROM transactions WHERE ${clauses.join(' AND ')}`).bind(...bound);
      });
      const spentResults = await ctx.env.DB.batch<Record<string, unknown>>(statements);
      const spent = new Map(spentResults.map((result) => {
        const row = result.results?.[0];
        return [String(row?.id ?? ''), Number(row?.spent_minor ?? 0)];
      }));
      items = items.map((item) => ({ ...item, spentMinor: spent.get(String(item.id)) ?? 0 }));
    }
    return json({ items, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  }

  requireWrite(auth);
  if (ctx.request.method === 'POST' && !id) {
    const body = await readJsonObject(ctx.request); const values = inputFor(resource, body, null); await validateReferences(ctx, resource, values);
    const entityId = newId(); const now = isoNow(); const columns = Object.keys(values);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(`INSERT INTO ${config.table} (id, household_id, ${columns.join(', ')}, created_at, updated_at) VALUES (?, ?, ${columns.map(() => '?').join(', ')}, ?, ?)`)
        .bind(entityId, auth.householdId, ...Object.values(values), now, now),
      ctx.env.DB.prepare(`INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(newId(), auth.householdId, auth.userId, `${resource}.created`, resource, entityId, auditDetails({}), now),
    ]);
    const row = await ctx.env.DB.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).bind(entityId).first<Record<string, unknown>>();
    return json(serialize(row!, config.booleans), 201);
  }
  if (ctx.request.method === 'PATCH' && id) {
    const current = await ctx.env.DB.prepare(`SELECT * FROM ${config.table} WHERE id = ? AND household_id = ?`).bind(id, auth.householdId).first<Record<string, unknown>>();
    if (!current) throw new ApiError(404, 'NOT_FOUND', 'Record not found.');
    const body = await readJsonObject(ctx.request); const values = inputFor(resource, body, current); await validateReferences(ctx, resource, values, id);
    const now = isoNow(); const columns = Object.keys(values);
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(`UPDATE ${config.table} SET ${columns.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND household_id = ?`)
        .bind(...Object.values(values), now, id, auth.householdId),
      ctx.env.DB.prepare(`INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(newId(), auth.householdId, auth.userId, `${resource}.updated`, resource, id, auditDetails({ changedFields: Object.keys(body) }), now),
    ]);
    const row = await ctx.env.DB.prepare(`SELECT * FROM ${config.table} WHERE id = ?`).bind(id).first<Record<string, unknown>>();
    return json(serialize(row!, config.booleans));
  }
  if (ctx.request.method === 'DELETE' && id) {
    const exists = await ctx.env.DB.prepare(`SELECT id FROM ${config.table} WHERE id = ? AND household_id = ?`).bind(id, auth.householdId).first();
    if (!exists) throw new ApiError(404, 'NOT_FOUND', 'Record not found.');
    const now = isoNow();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(`UPDATE ${config.table} SET active = 0, updated_at = ? WHERE id = ? AND household_id = ?`).bind(now, id, auth.householdId),
      ctx.env.DB.prepare(`INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`)
        .bind(newId(), auth.householdId, auth.userId, `${resource}.deactivated`, resource, id, now),
    ]);
    return noContent();
  }
  throw new ApiError(405, 'METHOD_NOT_ALLOWED', id ? 'Allowed methods: GET, PATCH, DELETE.' : 'Allowed methods: GET, POST.');
}

export async function handleHousehold(ctx: RouteContext): Promise<Response> {
  const auth = ctx.auth!;
  if (ctx.request.method === 'GET') {
    const row = await ctx.env.DB.prepare('SELECT id, name, currency, timezone, created_at, updated_at FROM households WHERE id = ?').bind(auth.householdId).first<Record<string, unknown>>();
    return json({ item: serialize(row!, []) });
  }
  if (ctx.request.method !== 'PATCH') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Allowed methods: GET, PATCH.');
  requireAdmin(auth); const body = await readJsonObject(ctx.request);
  const current = await ctx.env.DB.prepare('SELECT * FROM households WHERE id = ?').bind(auth.householdId).first<Record<string, unknown>>();
  const name = body.name === undefined ? String(current!.name) : requiredString(body, 'name', { max: 100 });
  const currency = body.currency === undefined ? String(current!.currency) : requiredString(body, 'currency', { min: 3, max: 3 }).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ApiError(422, 'VALIDATION_ERROR', 'currency must be a 3-letter ISO code.');
  const timezone = body.timezone === undefined ? String(current!.timezone) : requiredString(body, 'timezone', { max: 100 });
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { throw new ApiError(422, 'VALIDATION_ERROR', 'timezone must be a valid IANA timezone.'); }
  const now = isoNow(); await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE households SET name = ?, currency = ?, timezone = ?, updated_at = ? WHERE id = ?').bind(name, currency, timezone, now, auth.householdId),
    ctx.env.DB.prepare(`INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, 'household.updated', 'household', ?, ?, ?)`)
      .bind(newId(), auth.householdId, auth.userId, auth.householdId, auditDetails({ changedFields: Object.keys(body) }), now),
  ]);
  return json({ item: { id: auth.householdId, name, currency, timezone, updatedAt: now } });
}

export async function handleUsers(ctx: RouteContext, id?: string): Promise<Response> {
  const auth = ctx.auth!; requireAdmin(auth);
  if (ctx.request.method === 'GET' && !id) {
    const rows = await ctx.env.DB.prepare('SELECT id, household_id, email, display_name, role, active, must_change_password, created_at, updated_at FROM users WHERE household_id = ? ORDER BY display_name').bind(auth.householdId).all<Record<string, unknown>>();
    return json({ items: (rows.results ?? []).map((row) => serialize(row, ['active', 'must_change_password'])) });
  }
  if (ctx.request.method === 'POST' && !id) {
    const body = await readJsonObject(ctx.request); const email = emailAddress(body); const displayName = requiredString(body, 'displayName', { max: 100 });
    const role = enumValue(body, 'role', ['admin', 'member', 'viewer'] as const);
    const mustChangePassword = booleanValue(body, 'mustChangePassword', true);
    const password = passwordForPolicy(body, 'password', mustChangePassword);
    const passwordData = await hashPassword(password, ctx.env.PASSWORD_PEPPER); const userId = newId(); const now = isoNow();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(`INSERT INTO users (id, household_id, email, display_name, role, password_hash, password_salt, password_iterations, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(userId, auth.householdId, email, displayName, role, passwordData.hash, passwordData.salt, passwordData.iterations, mustChangePassword ? 1 : 0, now, now),
      ctx.env.DB.prepare(`INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, 'users.created', 'users', ?, ?, ?)`)
        .bind(newId(), auth.householdId, auth.userId, userId, auditDetails({ role, mustChangePassword }), now),
    ]);
    return json({ item: { id: userId, householdId: auth.householdId, email, displayName, role, active: true, mustChangePassword } }, 201);
  }
  if (!id) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Allowed methods: GET, POST.');
  const current = await ctx.env.DB.prepare('SELECT * FROM users WHERE id = ? AND household_id = ?').bind(id, auth.householdId).first<Record<string, unknown>>();
  if (!current) throw new ApiError(404, 'NOT_FOUND', 'User not found.');
  if (current.role === 'owner' && auth.role !== 'owner') throw new ApiError(403, 'OWNER_REQUIRED', 'Only the household owner can change the owner account.');
  if (ctx.request.method === 'PATCH') {
    const body = await readJsonObject(ctx.request); const displayName = body.displayName === undefined ? String(current.display_name) : requiredString(body, 'displayName', { max: 100 });
    const role = body.role === undefined ? String(current.role) : enumValue(body, 'role', ['admin', 'member', 'viewer'] as const);
    const active = body.active === undefined ? Boolean(current.active) : booleanValue(body, 'active', true);
    const mustChangePassword = body.mustChangePassword === undefined ? Boolean(current.must_change_password) : booleanValue(body, 'mustChangePassword', true);
    if (id === auth.userId && !active) throw new ApiError(422, 'VALIDATION_ERROR', 'You cannot deactivate your own account.');
    if (current.role === 'owner' && (role !== 'owner' || !active)) throw new ApiError(422, 'OWNER_REQUIRED', 'The household owner cannot be demoted or deactivated.');
    const newPassword = body.password === undefined ? null : passwordForPolicy(body, 'password', mustChangePassword);
    const passwordData = newPassword ? await hashPassword(newPassword, ctx.env.PASSWORD_PEPPER) : null;
    const now = isoNow();
    const statements = [
      passwordData
        ? ctx.env.DB.prepare('UPDATE users SET display_name = ?, role = ?, active = ?, must_change_password = ?, password_hash = ?, password_salt = ?, password_iterations = ?, updated_at = ? WHERE id = ? AND household_id = ?').bind(displayName, role, active ? 1 : 0, mustChangePassword ? 1 : 0, passwordData.hash, passwordData.salt, passwordData.iterations, now, id, auth.householdId)
        : ctx.env.DB.prepare('UPDATE users SET display_name = ?, role = ?, active = ?, must_change_password = ?, updated_at = ? WHERE id = ? AND household_id = ?').bind(displayName, role, active ? 1 : 0, mustChangePassword ? 1 : 0, now, id, auth.householdId),
      ctx.env.DB.prepare(`INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, 'users.updated', 'users', ?, ?, ?)`)
        .bind(newId(), auth.householdId, auth.userId, id, auditDetails({ changedFields: Object.keys(body) }), now),
    ];
    if (passwordData) statements.push(id === auth.userId
      ? ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND household_id = ? AND id <> ?').bind(id, auth.householdId, auth.sessionId)
      : ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND household_id = ?').bind(id, auth.householdId));
    await ctx.env.DB.batch(statements);
    return json({ item: { id, householdId: auth.householdId, email: current.email, displayName, role, active, mustChangePassword } });
  }
  if (ctx.request.method === 'DELETE') {
    if (id === auth.userId) throw new ApiError(422, 'VALIDATION_ERROR', 'You cannot deactivate your own account.');
    if (current.role === 'owner') throw new ApiError(422, 'OWNER_REQUIRED', 'The household owner cannot be deactivated.');
    const now = isoNow(); await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE users SET active = 0, updated_at = ? WHERE id = ? AND household_id = ?').bind(now, id, auth.householdId),
      ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND household_id = ?').bind(id, auth.householdId),
      ctx.env.DB.prepare(`INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, details_json, created_at) VALUES (?, ?, ?, 'users.deactivated', 'users', ?, '{}', ?)`).bind(newId(), auth.householdId, auth.userId, id, now),
    ]); return noContent();
  }
  throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Allowed methods: PATCH, DELETE.');
}
