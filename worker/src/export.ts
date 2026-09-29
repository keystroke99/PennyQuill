import { requireAdmin } from './auth';
import { auditDetails, isoNow, json } from './http';
import { newId } from './security';
import type { D1Result, RouteContext } from './types';
import { ApiError } from './validation';

function camel(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function serialize(row: Record<string, unknown>): Record<string, unknown> {
  const result = Object.fromEntries(Object.entries(row).map(([key, value]) => [camel(key), value]));
  for (const field of ['tagsJson', 'detailsJson']) {
    if (typeof result[field] === 'string') {
      try { result[field.replace(/Json$/, '')] = JSON.parse(result[field] as string); } catch { result[field.replace(/Json$/, '')] = null; }
      delete result[field];
    }
  }
  for (const field of ['active', 'isSystem', 'includeInNetWorth', 'rollover', 'autoPost', 'mustChangePassword']) {
    if (field in result) result[field] = Boolean(result[field]);
  }
  return result;
}

function rows(result: D1Result<Record<string, unknown>>): Record<string, unknown>[] {
  return (result.results ?? []).map(serialize);
}

export async function handleExport(ctx: RouteContext): Promise<Response> {
  if (ctx.request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Allowed method: GET.');
  requireAdmin(ctx.auth!);
  const householdId = ctx.auth!.householdId;
  const [household, users, members, categories, accounts, transactions, budgets, recurringRules, goals, auditLogs] = await Promise.all([
    ctx.env.DB.prepare('SELECT id,name,currency,timezone,created_at,updated_at FROM households WHERE id=?').bind(householdId).first<Record<string, unknown>>(),
    ctx.env.DB.prepare('SELECT id,email,display_name,role,active,must_change_password,created_at,updated_at FROM users WHERE household_id=? ORDER BY created_at').bind(householdId).all<Record<string, unknown>>(),
    ctx.env.DB.prepare('SELECT id,user_id,name,relationship,avatar_icon,active,created_at,updated_at FROM members WHERE household_id=? ORDER BY created_at').bind(householdId).all<Record<string, unknown>>(),
    ctx.env.DB.prepare('SELECT id,parent_id,name,kind,classification,icon,color,is_system,active,created_at,updated_at FROM categories WHERE household_id=? ORDER BY created_at').bind(householdId).all<Record<string, unknown>>(),
    ctx.env.DB.prepare('SELECT id,name,type,currency,opening_balance_minor,include_in_net_worth,icon,color,active,created_at,updated_at FROM accounts WHERE household_id=? ORDER BY created_at').bind(householdId).all<Record<string, unknown>>(),
    ctx.env.DB.prepare('SELECT id,member_id,category_id,account_id,transfer_account_id,direction,status,amount_minor,occurred_on,merchant,note,source,tags_json,reviewed_at,created_by,created_at,updated_at FROM transactions WHERE household_id=? ORDER BY occurred_on,created_at').bind(householdId).all<Record<string, unknown>>(),
    ctx.env.DB.prepare('SELECT id,name,category_id,member_id,period,amount_minor,starts_on,ends_on,rollover,active,created_at,updated_at FROM budgets WHERE household_id=? ORDER BY created_at').bind(householdId).all<Record<string, unknown>>(),
    ctx.env.DB.prepare('SELECT id,member_id,category_id,account_id,name,direction,amount_minor,merchant,note,cadence,interval_count,next_due_on,ends_on,auto_post,active,created_at,updated_at FROM recurring_rules WHERE household_id=? ORDER BY created_at').bind(householdId).all<Record<string, unknown>>(),
    ctx.env.DB.prepare('SELECT id,member_id,name,goal_type,target_minor,current_minor,target_date,icon,color,active,created_at,updated_at FROM goals WHERE household_id=? ORDER BY created_at').bind(householdId).all<Record<string, unknown>>(),
    ctx.env.DB.prepare('SELECT id,user_id,action,entity_type,entity_id,details_json,created_at FROM audit_logs WHERE household_id=? ORDER BY created_at').bind(householdId).all<Record<string, unknown>>(),
  ]);
  const exportedAt = isoNow();
  await ctx.env.DB.prepare(`INSERT INTO audit_logs (id,household_id,user_id,action,entity_type,entity_id,details_json,created_at) VALUES (?,?,?,'household.exported','households',?,?,?)`)
    .bind(newId(), householdId, ctx.auth!.userId, householdId, auditDetails({ format: 'json', includesSecrets: false }), exportedAt).run();
  return json({
    product: 'PennyQuill', schemaVersion: 2, exportedAt,
    privacy: 'Password hashes, password salts, sessions, login-attempt records, setup credentials, SMS bodies, and import hashes are excluded.',
    household: household ? serialize(household) : null,
    users: rows(users), members: rows(members), categories: rows(categories), accounts: rows(accounts),
    transactions: rows(transactions), budgets: rows(budgets), recurringRules: rows(recurringRules), goals: rows(goals), auditLogs: rows(auditLogs),
  }, 200, { 'Content-Disposition': `attachment; filename="pennyquill-export-${exportedAt.slice(0, 10)}.json"` });
}
