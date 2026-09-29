import { requireWrite } from './auth';
import { auditDetails, isoNow, json, noContent } from './http';
import { hashSessionToken, newId } from './security';
import { parseSmsMessage } from './sms';
import type { D1Value, RouteContext, TransactionInput } from './types';
import { ApiError, enumValue, integer, isoDate, optionalId, optionalString, pagination, queryId, readJsonObject, requiredString } from './validation';

const SELECT_TRANSACTION = `SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color,
  m.name AS member_name, a.name AS account_name, ta.name AS transfer_account_name
  FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN members m ON m.id = t.member_id
  LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN accounts ta ON ta.id = t.transfer_account_id`;

async function householdToday(ctx: RouteContext): Promise<string> {
  const household = await ctx.env.DB.prepare('SELECT timezone FROM households WHERE id = ?')
    .bind(ctx.auth!.householdId).first<{ timezone: string }>();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: household?.timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function parseTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  let tags: unknown = value;
  if (typeof value === 'string') {
    try { tags = JSON.parse(value); } catch { throw new ApiError(422, 'VALIDATION_ERROR', 'tags must be an array of strings.'); }
  }
  if (!Array.isArray(tags) || tags.length > 20) throw new ApiError(422, 'VALIDATION_ERROR', 'tags must contain at most 20 strings.');
  const clean = tags.map((tag) => {
    if (typeof tag !== 'string' || !tag.trim() || tag.trim().length > 30) throw new ApiError(422, 'VALIDATION_ERROR', 'Each tag must contain 1 to 30 characters.');
    return tag.trim().toLowerCase();
  });
  return [...new Set(clean)];
}

function bodyValue(body: Record<string, unknown>, key: string, current: Record<string, unknown> | null, dbKey: string, fallback?: unknown): unknown {
  return body[key] !== undefined ? body[key] : (current?.[dbKey] ?? fallback);
}

function transactionInput(body: Record<string, unknown>, current: Record<string, unknown> | null = null): TransactionInput {
  const direction = enumValue({ direction: bodyValue(body, 'direction', current, 'direction') }, 'direction', ['expense', 'income', 'transfer', 'refund', 'adjustment'] as const);
  let categoryId = optionalId({ categoryId: bodyValue(body, 'categoryId', current, 'category_id', null) }, 'categoryId');
  const accountId = optionalId({ accountId: bodyValue(body, 'accountId', current, 'account_id', null) }, 'accountId');
  let transferAccountId = optionalId({ transferAccountId: bodyValue(body, 'transferAccountId', current, 'transfer_account_id', null) }, 'transferAccountId');
  if (direction === 'transfer') {
    categoryId = null;
    if (!accountId || !transferAccountId || accountId === transferAccountId) throw new ApiError(422, 'VALIDATION_ERROR', 'Transfers require two different accounts.');
  } else transferAccountId = null;
  const tagsValue = body.tags !== undefined ? body.tags : current?.tags_json;
  return {
    memberId: optionalId({ memberId: bodyValue(body, 'memberId', current, 'member_id', null) }, 'memberId'), categoryId, accountId, transferAccountId,
    direction,
    status: enumValue({ status: bodyValue(body, 'status', current, 'status', 'cleared') }, 'status', ['pending', 'cleared', 'planned'] as const),
    amountMinor: integer({ amountMinor: bodyValue(body, 'amountMinor', current, 'amount_minor') }, 'amountMinor', { min: 1, max: 9_000_000_000_000 }),
    occurredOn: isoDate(bodyValue(body, 'occurredOn', current, 'occurred_on'), 'occurredOn'),
    merchant: optionalString({ merchant: bodyValue(body, 'merchant', current, 'merchant', null) }, 'merchant', 120),
    note: optionalString({ note: bodyValue(body, 'note', current, 'note', null) }, 'note', 500),
    source: enumValue({ source: bodyValue(body, 'source', current, 'source', 'manual') }, 'source', ['manual', 'sms', 'recurring', 'import'] as const),
    externalRef: optionalString({ externalRef: bodyValue(body, 'externalRef', current, 'external_ref', null) }, 'externalRef', 200),
    importHash: current?.import_hash ? String(current.import_hash) : null,
    tags: parseTags(tagsValue), reviewedAt: current?.reviewed_at ? String(current.reviewed_at) : null,
  };
}

async function validateReferences(ctx: RouteContext, input: TransactionInput): Promise<void> {
  const auth = ctx.auth!;
  const refs: Array<[string | null, string, string]> = [
    [input.memberId, 'members', 'memberId'], [input.accountId, 'accounts', 'accountId'], [input.transferAccountId, 'accounts', 'transferAccountId'],
  ];
  for (const [id, table, label] of refs) {
    if (id && !(await ctx.env.DB.prepare(`SELECT id FROM ${table} WHERE id = ? AND household_id = ?`).bind(id, auth.householdId).first())) {
      throw new ApiError(422, 'INVALID_REFERENCE', `${label} does not belong to this household.`);
    }
  }
  if (input.categoryId) {
    const category = await ctx.env.DB.prepare('SELECT kind FROM categories WHERE id = ? AND household_id = ?').bind(input.categoryId, auth.householdId).first<{ kind: string }>();
    if (!category) throw new ApiError(422, 'INVALID_REFERENCE', 'categoryId does not belong to this household.');
    if (input.direction === 'income' && !['income', 'both'].includes(category.kind)) throw new ApiError(422, 'INVALID_REFERENCE', 'Income requires an income or both category.');
    if (['expense', 'refund'].includes(input.direction) && !['expense', 'both'].includes(category.kind)) throw new ApiError(422, 'INVALID_REFERENCE', 'Expense and refund records require an expense or both category.');
  }
}

function serializeTransaction(row: Record<string, unknown>) {
  let tags: string[] = [];
  try { tags = JSON.parse(String(row.tags_json ?? '[]')) as string[]; } catch { tags = []; }
  return {
    id: row.id, householdId: row.household_id, memberId: row.member_id, categoryId: row.category_id,
    accountId: row.account_id, transferAccountId: row.transfer_account_id, direction: row.direction, status: row.status,
    amountMinor: Number(row.amount_minor), occurredOn: row.occurred_on, merchant: row.merchant, note: row.note,
    source: row.source, externalRef: row.external_ref, tags, reviewedAt: row.reviewed_at,
    createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
    memberName: row.member_name ?? null, categoryName: row.category_name ?? null,
    categoryIcon: row.category_icon ?? null, categoryColor: row.category_color ?? null,
    accountName: row.account_name ?? null, transferAccountName: row.transfer_account_name ?? null,
    member: row.member_name ? { id: row.member_id, name: row.member_name } : null,
    category: row.category_name ? { id: row.category_id, name: row.category_name, icon: row.category_icon, color: row.category_color } : null,
    account: row.account_name ? { id: row.account_id, name: row.account_name } : null,
    transferAccount: row.transfer_account_name ? { id: row.transfer_account_id, name: row.transfer_account_name } : null,
  };
}

async function loadTransaction(ctx: RouteContext, id: string): Promise<Record<string, unknown>> {
  const row = await ctx.env.DB.prepare(`${SELECT_TRANSACTION} WHERE t.id = ? AND t.household_id = ?`).bind(id, ctx.auth!.householdId).first<Record<string, unknown>>();
  if (!row) throw new ApiError(404, 'NOT_FOUND', 'Transaction not found.');
  return row;
}

async function createTransaction(ctx: RouteContext, input: TransactionInput): Promise<Record<string, unknown>> {
  await validateReferences(ctx, input);
  const auth = ctx.auth!; const id = newId(); const now = isoNow();
  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(`INSERT INTO transactions (id, household_id, member_id, category_id, account_id, transfer_account_id,
        direction, status, amount_minor, occurred_on, merchant, note, source, external_ref, import_hash, tags_json, reviewed_at, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(id, auth.householdId, input.memberId, input.categoryId, input.accountId, input.transferAccountId, input.direction, input.status,
          input.amountMinor, input.occurredOn, input.merchant, input.note, input.source, input.externalRef, input.importHash, JSON.stringify(input.tags), input.reviewedAt, auth.userId, now, now),
      ctx.env.DB.prepare(`INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, details_json, created_at)
        VALUES (?, ?, ?, 'transactions.created', 'transactions', ?, ?, ?)`)
        .bind(newId(), auth.householdId, auth.userId, id, auditDetails({ direction: input.direction, status: input.status, source: input.source }), now),
    ]);
  } catch (error) {
    if (input.importHash && /UNIQUE constraint/i.test(error instanceof Error ? error.message : String(error))) throw new ApiError(409, 'DUPLICATE_IMPORT', 'This message appears to have already been imported.');
    throw error;
  }
  return loadTransaction(ctx, id);
}

export async function handleTransactions(ctx: RouteContext, id?: string): Promise<Response> {
  const auth = ctx.auth!;
  if (ctx.request.method === 'GET') {
    if (id) return json(serializeTransaction(await loadTransaction(ctx, id)));
    const { page, pageSize, offset } = pagination(ctx.url); const clauses = ['t.household_id = ?']; const values: D1Value[] = [auth.householdId];
    const filters: Array<[string, string]> = [['memberId', 't.member_id'], ['categoryId', 't.category_id'], ['accountId', 't.account_id']];
    for (const [query, field] of filters) { const value = queryId(ctx.url, query); if (value) { clauses.push(`${field} = ?`); values.push(value); } }
    const from = ctx.url.searchParams.get('from'); const to = ctx.url.searchParams.get('to');
    if (from) { clauses.push('t.occurred_on >= ?'); values.push(isoDate(from, 'from')); }
    if (to) { clauses.push('t.occurred_on <= ?'); values.push(isoDate(to, 'to')); }
    const direction = ctx.url.searchParams.get('direction');
    if (direction) { if (!['expense', 'income', 'transfer', 'refund', 'adjustment'].includes(direction)) throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid direction.'); clauses.push('t.direction = ?'); values.push(direction); }
    const status = ctx.url.searchParams.get('status');
    if (status) { if (!['pending', 'cleared', 'planned'].includes(status)) throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid status.'); clauses.push('t.status = ?'); values.push(status); }
    const search = ctx.url.searchParams.get('search')?.trim();
    if (search) { clauses.push("(t.merchant LIKE ? ESCAPE '\\' OR t.note LIKE ? ESCAPE '\\')"); const term = `%${search.replace(/[\\%_]/g, '\\$&').slice(0, 100)}%`; values.push(term, term); }
    const where = clauses.join(' AND ');
    const [rows, count] = await Promise.all([
      ctx.env.DB.prepare(`${SELECT_TRANSACTION} WHERE ${where} ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT ? OFFSET ?`).bind(...values, pageSize, offset).all<Record<string, unknown>>(),
      ctx.env.DB.prepare(`SELECT COUNT(*) AS total FROM transactions t WHERE ${where}`).bind(...values).first<{ total: number }>(),
    ]);
    const total = Number(count?.total ?? 0);
    return json({ items: (rows.results ?? []).map(serializeTransaction), page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  }
  requireWrite(auth);
  if (ctx.request.method === 'POST' && !id) {
    const input = transactionInput(await readJsonObject(ctx.request));
    input.source = 'manual'; input.importHash = null; input.reviewedAt = null;
    return json(serializeTransaction(await createTransaction(ctx, input)), 201);
  }
  if (!id) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Allowed methods: GET, POST.');
  if (ctx.request.method === 'PATCH') {
    const current = await loadTransaction(ctx, id); const body = await readJsonObject(ctx.request); const input = transactionInput(body, current);
    await validateReferences(ctx, input); const now = isoNow();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(`UPDATE transactions SET member_id=?, category_id=?, account_id=?, transfer_account_id=?, direction=?, status=?, amount_minor=?,
        occurred_on=?, merchant=?, note=?, source=?, external_ref=?, tags_json=?, updated_at=? WHERE id=? AND household_id=?`)
        .bind(input.memberId, input.categoryId, input.accountId, input.transferAccountId, input.direction, input.status, input.amountMinor,
          input.occurredOn, input.merchant, input.note, input.source, input.externalRef, JSON.stringify(input.tags), now, id, auth.householdId),
      ctx.env.DB.prepare(`INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, details_json, created_at)
        VALUES (?, ?, ?, 'transactions.updated', 'transactions', ?, ?, ?)`)
        .bind(newId(), auth.householdId, auth.userId, id, auditDetails({ changedFields: Object.keys(body) }), now),
    ]);
    return json(serializeTransaction(await loadTransaction(ctx, id)));
  }
  if (ctx.request.method === 'DELETE') {
    await loadTransaction(ctx, id); const now = isoNow();
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('DELETE FROM transactions WHERE id = ? AND household_id = ?').bind(id, auth.householdId),
      ctx.env.DB.prepare(`INSERT INTO audit_logs (id, household_id, user_id, action, entity_type, entity_id, details_json, created_at)
        VALUES (?, ?, ?, 'transactions.deleted', 'transactions', ?, '{}', ?)`).bind(newId(), auth.householdId, auth.userId, id, now),
    ]); return noContent();
  }
  throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Allowed methods: GET, PATCH, DELETE.');
}

export async function handleSmsPreview(ctx: RouteContext): Promise<Response> {
  if (ctx.request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Allowed method: POST.');
  requireWrite(ctx.auth!); const body = await readJsonObject(ctx.request); const text = requiredString(body, 'text', { min: 5, max: 2_000 });
  const preview = parseSmsMessage(text);
  let categoryId: string | null = null;
  if (preview.suggestedCategoryName) {
    const suggested = await ctx.env.DB.prepare('SELECT id FROM categories WHERE household_id = ? AND name = ? AND active = 1 LIMIT 1')
      .bind(ctx.auth!.householdId, preview.suggestedCategoryName).first<{ id: string }>();
    categoryId = suggested?.id ?? null;
  }
  const occurredOn = preview.occurredOn ?? await householdToday(ctx);
  const candidates = preview.direction && preview.amountMinor ? [{
    direction: preview.direction === 'refund' ? 'expense' : preview.direction,
    originalDirection: preview.direction,
    amountMinor: preview.amountMinor,
    currency: preview.currency,
    occurredOn,
    merchant: preview.merchant,
    categoryId,
    confidence: preview.confidence / 100,
    reasons: preview.warnings.length ? preview.warnings : ['Amount, direction, and transaction details were recognized.'],
    maskedPreview: `${preview.direction} · ${preview.currency} · account ${preview.accountLast4 ? `••${preview.accountLast4}` : 'not identified'}`,
    originalText: text,
  }] : [];
  return json({ preview, candidates, privacyNotice: 'The raw message is returned only to this review screen and is not stored. Only a SHA-256 idempotency hash and the approved transaction are saved on import.', persisted: false });
}

export async function handleSmsImport(ctx: RouteContext): Promise<Response> {
  if (ctx.request.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Allowed method: POST.');
  requireWrite(ctx.auth!); const body = await readJsonObject(ctx.request);
  if (body.confirmed !== true && body.reviewed !== true) throw new ApiError(422, 'REVIEW_REQUIRED', 'Confirm the parsed transaction after user review before importing.');
  const originalText = requiredString(body, 'originalText', { min: 5, max: 2_000 }); const preview = parseSmsMessage(originalText);
  const reviewed = body.transaction ?? body;
  if (!reviewed || typeof reviewed !== 'object' || Array.isArray(reviewed)) throw new ApiError(422, 'VALIDATION_ERROR', 'transaction must be the reviewed transaction object.');
  const reviewedBody = { ...(reviewed as Record<string, unknown>) };
  if (typeof reviewedBody.originalDirection === 'string') reviewedBody.direction = reviewedBody.originalDirection;
  if (reviewedBody.direction === undefined) reviewedBody.direction = preview.direction;
  if (reviewedBody.amountMinor === undefined) reviewedBody.amountMinor = preview.amountMinor;
  if (reviewedBody.occurredOn === undefined) reviewedBody.occurredOn = preview.occurredOn ?? await householdToday(ctx);
  if (reviewedBody.merchant === undefined) reviewedBody.merchant = preview.merchant;
  if (reviewedBody.status === undefined) reviewedBody.status = 'cleared';
  reviewedBody.source = 'sms';
  if (reviewedBody.categoryId === undefined && preview.suggestedCategoryName) {
    const suggested = await ctx.env.DB.prepare('SELECT id FROM categories WHERE household_id = ? AND name = ? AND active = 1 LIMIT 1').bind(ctx.auth!.householdId, preview.suggestedCategoryName).first<{ id: string }>();
    if (suggested) reviewedBody.categoryId = suggested.id;
  }
  const input = transactionInput(reviewedBody); const normalized = originalText.toLowerCase().replace(/\s+/g, ' ').trim();
  input.importHash = await hashSessionToken(`sms|${normalized}`); input.externalRef = `sms:${input.importHash}`; input.source = 'sms'; input.reviewedAt = isoNow();
  if (await ctx.env.DB.prepare('SELECT id FROM transactions WHERE household_id = ? AND import_hash = ?').bind(ctx.auth!.householdId, input.importHash).first()) {
    throw new ApiError(409, 'DUPLICATE_IMPORT', 'This message appears to have already been imported.');
  }
  const row = await createTransaction(ctx, input);
  return json({ ...serializeTransaction(row), parsedPreview: preview, rawMessageStored: false }, 201);
}
