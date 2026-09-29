import { addMonthsClamped, deterministicForecast, type ForecastRecurringRule, type MonthlyHistory } from './analytics';
import { json } from './http';
import type { D1Value, RouteContext } from './types';
import { ApiError, dateRange, isoDate, pagination, queryId } from './validation';

const num = (value: unknown) => Number(value ?? 0);
const percent = (value: number, total: number) => total > 0 ? Math.round(value / total * 10_000) / 100 : 0;
const changePercent = (current: number, previous: number) => previous === 0 ? null : Math.round((current - previous) / Math.abs(previous) * 10_000) / 100;

function shiftDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
}

function todayInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function forecastFilters(ctx: RouteContext, prefix: string): { clauses: string[]; values: D1Value[] } {
  const clauses: string[] = [];
  const values: D1Value[] = [];
  for (const [key, field] of [['memberId', 'member_id'], ['categoryId', 'category_id'], ['accountId', 'account_id']] as const) {
    const id = queryId(ctx.url, key);
    if (id) { clauses.push(`${prefix}${field} = ?`); values.push(id); }
  }
  const merchant = ctx.url.searchParams.get('merchant')?.trim();
  if (merchant) {
    if (merchant.length > 120) throw new ApiError(422, 'VALIDATION_ERROR', 'merchant must be at most 120 characters.');
    if (merchant.toLowerCase() === 'unspecified') clauses.push(`NULLIF(TRIM(${prefix}merchant), '') IS NULL`);
    else { clauses.push(`LOWER(TRIM(${prefix}merchant)) = LOWER(?)`); values.push(merchant); }
  }
  return { clauses, values };
}

function budgetAllocation(row: Record<string, unknown>, from: string, to: string): number {
  const startsOn = String(row.starts_on); const endsOn = row.ends_on ? String(row.ends_on) : null;
  if (startsOn > to || (endsOn && endsOn < from)) return 0;
  if (row.period === 'custom') return num(row.amount_minor);
  const advance = (date: string) => row.period === 'weekly' ? shiftDays(date, 7)
    : addMonthsClamped(date, row.period === 'monthly' ? 1 : row.period === 'quarterly' ? 3 : row.period === 'half_yearly' ? 6 : 12);
  let cycleStart = startsOn; let guard = 0;
  while (advance(cycleStart) <= from && guard < 1_000) { cycleStart = advance(cycleStart); guard += 1; }
  let total = 0;
  while (cycleStart <= to && (!endsOn || cycleStart <= endsOn) && guard < 2_000) {
    const cycleEnd = shiftDays(advance(cycleStart), -1);
    if (cycleEnd >= from) total += num(row.amount_minor);
    cycleStart = advance(cycleStart); guard += 1;
  }
  return total;
}

function analyticsFilters(ctx: RouteContext, from: string, to: string): { where: string; values: D1Value[] } {
  const clauses = ["t.household_id = ?", "t.status = 'cleared'", 't.occurred_on >= ?', 't.occurred_on <= ?'];
  const values: D1Value[] = [ctx.auth!.householdId, from, to];
  for (const [key, field] of [['memberId', 't.member_id'], ['categoryId', 't.category_id'], ['accountId', 't.account_id']] as const) {
    const id = queryId(ctx.url, key); if (id) { clauses.push(`${field} = ?`); values.push(id); }
  }
  const merchant = ctx.url.searchParams.get('merchant')?.trim();
  if (merchant) {
    if (merchant.length > 120) throw new ApiError(422, 'VALIDATION_ERROR', 'merchant must be at most 120 characters.');
    if (merchant.toLowerCase() === 'unspecified') clauses.push("NULLIF(TRIM(t.merchant), '') IS NULL");
    else { clauses.push('LOWER(TRIM(t.merchant)) = LOWER(?)'); values.push(merchant); }
  }
  return { where: clauses.join(' AND '), values };
}

function bucketExpression(granularity: string): string {
  switch (granularity) {
    case 'day': return 't.occurred_on';
    case 'week': return "date(t.occurred_on, '-' || ((CAST(strftime('%w', t.occurred_on) AS INTEGER) + 6) % 7) || ' days')";
    case 'month': return "strftime('%Y-%m-01', t.occurred_on)";
    case 'quarter': return "strftime('%Y', t.occurred_on) || '-' || printf('%02d', (((CAST(strftime('%m', t.occurred_on) AS INTEGER) - 1) / 3) * 3) + 1) || '-01'";
    case 'year': return "strftime('%Y-01-01', t.occurred_on)";
    default: throw new ApiError(422, 'VALIDATION_ERROR', 'granularity must be day, week, month, quarter, or year.');
  }
}

export async function handleDashboard(ctx: RouteContext): Promise<Response> {
  if (ctx.request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Allowed method: GET.');
  const { from, to } = dateRange(ctx.url, 30); const householdId = ctx.auth!.householdId;
  const span = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const bucket = span <= 62 ? 'occurred_on' : "strftime('%Y-%m-01', occurred_on)";
  const [summary, budget, trend, categories, recent, recurring] = await Promise.all([
    ctx.env.DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN direction='income' THEN amount_minor ELSE 0 END),0) AS income_minor,
      COALESCE(SUM(CASE WHEN direction='expense' THEN amount_minor WHEN direction='refund' THEN -amount_minor ELSE 0 END),0) AS expense_minor,
      COUNT(CASE WHEN direction NOT IN ('transfer','adjustment') THEN 1 END) AS transaction_count
      FROM transactions WHERE household_id=? AND status='cleared' AND occurred_on BETWEEN ? AND ?`).bind(householdId, from, to).first<Record<string, unknown>>(),
    ctx.env.DB.prepare(`SELECT period,amount_minor,starts_on,ends_on FROM budgets
      WHERE household_id=? AND active=1 AND starts_on <= ? AND (ends_on IS NULL OR ends_on >= ?)`).bind(householdId, to, from).all<Record<string, unknown>>(),
    ctx.env.DB.prepare(`SELECT ${bucket} AS date,
      COALESCE(SUM(CASE WHEN direction='income' THEN amount_minor ELSE 0 END),0) AS income_minor,
      COALESCE(SUM(CASE WHEN direction='expense' THEN amount_minor WHEN direction='refund' THEN -amount_minor ELSE 0 END),0) AS expense_minor
      FROM transactions WHERE household_id=? AND status='cleared' AND occurred_on BETWEEN ? AND ? AND direction NOT IN ('transfer','adjustment')
      GROUP BY ${bucket} ORDER BY date`).bind(householdId, from, to).all<Record<string, unknown>>(),
    ctx.env.DB.prepare(`SELECT c.id, c.name, c.icon, c.color,
      SUM(CASE WHEN t.direction='expense' THEN t.amount_minor WHEN t.direction='refund' THEN -t.amount_minor ELSE 0 END) AS amount_minor,
      COUNT(*) AS transaction_count FROM transactions t JOIN categories c ON c.id=t.category_id
      WHERE t.household_id=? AND t.status='cleared' AND t.occurred_on BETWEEN ? AND ? AND t.direction IN ('expense','refund')
      GROUP BY c.id HAVING amount_minor > 0 ORDER BY amount_minor DESC`).bind(householdId, from, to).all<Record<string, unknown>>(),
    ctx.env.DB.prepare(`SELECT t.id,t.member_id,t.category_id,t.account_id,t.transfer_account_id,t.direction,t.status,t.amount_minor,t.occurred_on,t.merchant,t.note,t.source,t.tags_json,t.reviewed_at,t.created_at,c.name AS category_name,c.icon AS category_icon,c.color AS category_color,m.name AS member_name,a.name AS account_name
      FROM transactions t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN members m ON m.id=t.member_id LEFT JOIN accounts a ON a.id=t.account_id
      WHERE t.household_id=? AND t.status='cleared' AND t.occurred_on BETWEEN ? AND ? ORDER BY t.occurred_on DESC,t.created_at DESC LIMIT 8`).bind(householdId, from, to).all<Record<string, unknown>>(),
    ctx.env.DB.prepare(`SELECT r.id,r.name,r.direction,r.amount_minor,r.next_due_on,r.cadence,r.interval_count,r.merchant,c.name AS category_name,m.name AS member_name
      FROM recurring_rules r LEFT JOIN categories c ON c.id=r.category_id LEFT JOIN members m ON m.id=r.member_id
      WHERE r.household_id=? AND r.active=1 AND (r.ends_on IS NULL OR r.ends_on >= ?) ORDER BY r.next_due_on LIMIT 8`).bind(householdId, from).all<Record<string, unknown>>(),
  ]);
  const incomeMinor = num(summary?.income_minor); const expenseMinor = num(summary?.expense_minor);
  const budgetMinor = (budget.results ?? []).reduce((total, row) => total + budgetAllocation(row, from, to), 0);
  const categoryRows = categories.results ?? [];
  return json({
    period: { from, to },
    summary: {
      incomeMinor, expenseMinor, netMinor: incomeMinor - expenseMinor,
      savingsRate: incomeMinor > 0 ? Math.round((incomeMinor - expenseMinor) / incomeMinor * 10_000) / 100 : null,
      budgetMinor, budgetUsedPercent: budgetMinor > 0 ? percent(expenseMinor, budgetMinor) : null,
      transactionCount: num(summary?.transaction_count),
    },
    trend: (trend.results ?? []).map((row) => ({ label: String(row.date), date: row.date, incomeMinor: num(row.income_minor), expenseMinor: num(row.expense_minor) })),
    categoryBreakdown: categoryRows.map((row) => ({ id: row.id, name: row.name, icon: row.icon, color: row.color, amountMinor: num(row.amount_minor), percentage: percent(num(row.amount_minor), expenseMinor), transactionCount: num(row.transaction_count) })),
    recentTransactions: (recent.results ?? []).map((row) => ({
      id: row.id, direction: row.direction, status: row.status, amountMinor: num(row.amount_minor), occurredOn: row.occurred_on,
      memberId: row.member_id, categoryId: row.category_id, accountId: row.account_id, transferAccountId: row.transfer_account_id,
      merchant: row.merchant, note: row.note, source: row.source, tags: JSON.parse(String(row.tags_json ?? '[]')), reviewedAt: row.reviewed_at, createdAt: row.created_at,
      memberName: row.member_name, accountName: row.account_name, categoryName: row.category_name, categoryIcon: row.category_icon, categoryColor: row.category_color,
    })),
    upcomingRecurring: (recurring.results ?? []).map((row) => ({ id: row.id, name: row.name, direction: row.direction, amountMinor: num(row.amount_minor), nextDueOn: row.next_due_on, cadence: row.cadence, intervalCount: num(row.interval_count), merchant: row.merchant, categoryName: row.category_name, memberName: row.member_name })),
  });
}

export async function handleAnalytics(ctx: RouteContext): Promise<Response> {
  if (ctx.request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Allowed method: GET.');
  const { from, to } = dateRange(ctx.url, 30); const filters = analyticsFilters(ctx, from, to);
  const requested = ctx.url.searchParams.get('granularity');
  const span = Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const granularity = requested ?? (span <= 62 ? 'day' : span <= 730 ? 'month' : 'year'); const bucket = bucketExpression(granularity);
  const previousToDate = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000); const previousFromDate = new Date(previousToDate.getTime() - (span - 1) * 86_400_000);
  const previousFrom = previousFromDate.toISOString().slice(0, 10); const previousTo = previousToDate.toISOString().slice(0, 10);
  const previousFilters = analyticsFilters(ctx, previousFrom, previousTo);
  const metricSelect = `COALESCE(SUM(CASE WHEN t.direction='income' THEN t.amount_minor ELSE 0 END),0) AS income_minor,
    COALESCE(SUM(CASE WHEN t.direction='expense' THEN t.amount_minor WHEN t.direction='refund' THEN -t.amount_minor ELSE 0 END),0) AS expense_minor,
    COUNT(CASE WHEN t.direction NOT IN ('transfer','adjustment') THEN 1 END) AS transaction_count`;
  const [summary, series, categories, members, merchants, classification, largest, previous] = await Promise.all([
    ctx.env.DB.prepare(`SELECT ${metricSelect} FROM transactions t WHERE ${filters.where}`).bind(...filters.values).first<Record<string, unknown>>(),
    ctx.env.DB.prepare(`SELECT ${bucket} AS date,${metricSelect} FROM transactions t WHERE ${filters.where} AND t.direction NOT IN ('transfer','adjustment') GROUP BY ${bucket} ORDER BY date`).bind(...filters.values).all<Record<string, unknown>>(),
    ctx.env.DB.prepare(`SELECT c.id,c.name,c.icon,c.color,c.classification,
      SUM(CASE WHEN t.direction='expense' THEN t.amount_minor WHEN t.direction='refund' THEN -t.amount_minor ELSE 0 END) AS amount_minor,COUNT(*) AS transaction_count
      FROM transactions t JOIN categories c ON c.id=t.category_id WHERE ${filters.where} AND t.direction IN ('expense','refund')
      GROUP BY c.id HAVING amount_minor <> 0 ORDER BY amount_minor DESC`).bind(...filters.values).all<Record<string, unknown>>(),
    ctx.env.DB.prepare(`SELECT m.id,m.name,SUM(CASE WHEN t.direction='expense' THEN t.amount_minor WHEN t.direction='refund' THEN -t.amount_minor ELSE 0 END) AS expense_minor,
      SUM(CASE WHEN t.direction='income' THEN t.amount_minor ELSE 0 END) AS income_minor,COUNT(*) AS transaction_count
      FROM transactions t LEFT JOIN members m ON m.id=t.member_id WHERE ${filters.where} AND t.direction NOT IN ('transfer','adjustment') GROUP BY t.member_id ORDER BY expense_minor DESC`).bind(...filters.values).all<Record<string, unknown>>(),
    ctx.env.DB.prepare(`SELECT COALESCE(NULLIF(TRIM(t.merchant),''),'Unspecified') AS merchant,
      SUM(CASE WHEN t.direction='expense' THEN t.amount_minor WHEN t.direction='refund' THEN -t.amount_minor ELSE 0 END) AS amount_minor,COUNT(*) AS transaction_count
      FROM transactions t WHERE ${filters.where} AND t.direction IN ('expense','refund') GROUP BY COALESCE(NULLIF(TRIM(t.merchant),''),'Unspecified') HAVING amount_minor > 0 ORDER BY amount_minor DESC LIMIT 20`).bind(...filters.values).all<Record<string, unknown>>(),
    ctx.env.DB.prepare(`SELECT c.classification,SUM(CASE WHEN t.direction='expense' THEN t.amount_minor WHEN t.direction='refund' THEN -t.amount_minor ELSE 0 END) AS amount_minor
      FROM transactions t JOIN categories c ON c.id=t.category_id WHERE ${filters.where} AND t.direction IN ('expense','refund') GROUP BY c.classification`).bind(...filters.values).all<Record<string, unknown>>(),
    ctx.env.DB.prepare(`SELECT t.id,t.amount_minor,t.occurred_on,t.merchant,t.note,c.name AS category_name,m.name AS member_name
      FROM transactions t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN members m ON m.id=t.member_id
      WHERE ${filters.where} AND t.direction='expense' ORDER BY t.amount_minor DESC LIMIT 10`).bind(...filters.values).all<Record<string, unknown>>(),
    ctx.env.DB.prepare(`SELECT ${metricSelect} FROM transactions t WHERE ${previousFilters.where}`).bind(...previousFilters.values).first<Record<string, unknown>>(),
  ]);
  const incomeMinor = num(summary?.income_minor); const expenseMinor = num(summary?.expense_minor);
  const previousIncome = num(previous?.income_minor); const previousExpense = num(previous?.expense_minor);
  const classes = Object.fromEntries((classification.results ?? []).map((row) => [String(row.classification), num(row.amount_minor)]));
  const classificationItems = [
    { id: 'essential', name: 'Essential', amountMinor: num(classes.essential) },
    { id: 'discretionary', name: 'Discretionary', amountMinor: num(classes.discretionary) },
    { id: 'savings', name: 'Savings', amountMinor: num(classes.savings) },
  ].map((item) => ({ ...item, percentage: percent(item.amountMinor, expenseMinor), transactionCount: 0 }));
  return json({
    period: { from, to, granularity }, summary: { incomeMinor, expenseMinor, netMinor: incomeMinor - expenseMinor, savingsRate: incomeMinor > 0 ? Math.round((incomeMinor - expenseMinor) / incomeMinor * 10_000) / 100 : null, transactionCount: num(summary?.transaction_count) },
    series: (series.results ?? []).map((row) => ({ date: row.date, label: String(row.date), incomeMinor: num(row.income_minor), expenseMinor: num(row.expense_minor), netMinor: num(row.income_minor) - num(row.expense_minor) })),
    categories: (categories.results ?? []).map((row) => ({ id: row.id, name: row.name, icon: row.icon, color: row.color, classification: row.classification, amountMinor: num(row.amount_minor), percentage: percent(num(row.amount_minor), expenseMinor), transactionCount: num(row.transaction_count) })),
    members: (members.results ?? []).map((row) => ({ id: row.id ?? 'unassigned', name: row.name ?? 'Unassigned', amountMinor: num(row.expense_minor), percentage: percent(num(row.expense_minor), expenseMinor), incomeMinor: num(row.income_minor), expenseMinor: num(row.expense_minor), netMinor: num(row.income_minor) - num(row.expense_minor), transactionCount: num(row.transaction_count) })),
    merchants: (merchants.results ?? []).map((row, index) => ({ id: `merchant-${index + 1}`, name: row.merchant, amountMinor: num(row.amount_minor), percentage: percent(num(row.amount_minor), expenseMinor), transactionCount: num(row.transaction_count) })),
    essentialVsDiscretionary: classificationItems,
    largestTransactions: (largest.results ?? []).map((row) => ({ id: row.id, amountMinor: num(row.amount_minor), occurredOn: row.occurred_on, merchant: row.merchant, note: row.note, categoryName: row.category_name, memberName: row.member_name })),
    comparison: {
      previousPeriod: { from: previousFrom, to: previousTo }, incomeMinor: previousIncome, expenseMinor: previousExpense, netMinor: previousIncome - previousExpense,
      savingsRate: previousIncome > 0 ? Math.round((previousIncome - previousExpense) / previousIncome * 10_000) / 100 : null,
      changePercent: changePercent(expenseMinor, previousExpense), previousIncomeMinor: previousIncome, previousExpenseMinor: previousExpense, previousNetMinor: previousIncome - previousExpense,
      incomeChangePercent: changePercent(incomeMinor, previousIncome), expenseChangePercent: changePercent(expenseMinor, previousExpense), netChangePercent: changePercent(incomeMinor - expenseMinor, previousIncome - previousExpense),
    },
  });
}

export async function handleForecast(ctx: RouteContext): Promise<Response> {
  if (ctx.request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Allowed method: GET.');
  const months = Number.parseInt(ctx.url.searchParams.get('months') ?? '6', 10); const historyMonths = Number.parseInt(ctx.url.searchParams.get('historyMonths') ?? '12', 10);
  if (!Number.isInteger(months) || months < 1 || months > 24) throw new ApiError(422, 'VALIDATION_ERROR', 'months must be between 1 and 24.');
  if (!Number.isInteger(historyMonths) || historyMonths < 6 || historyMonths > 36) throw new ApiError(422, 'VALIDATION_ERROR', 'historyMonths must be between 6 and 36.');
  const household = await ctx.env.DB.prepare('SELECT timezone FROM households WHERE id=?').bind(ctx.auth!.householdId).first<{ timezone: string }>();
  const asOf = ctx.url.searchParams.has('asOf') ? isoDate(ctx.url.searchParams.get('asOf'), 'asOf') : todayInTimeZone(household?.timezone ?? 'UTC');
  const currentMonthStart = `${asOf.slice(0, 7)}-01`;
  const lastHistoryMonth = addMonthsClamped(currentMonthStart, -1).slice(0, 7);
  const firstHistoryMonth = addMonthsClamped(`${lastHistoryMonth}-01`, -(historyMonths - 1)).slice(0, 7);
  const firstForecastMonth = addMonthsClamped(`${asOf.slice(0, 7)}-01`, 1).slice(0, 7);
  const forecastEnd = addMonthsClamped(`${firstForecastMonth}-01`, months).slice(0, 10);
  const householdId = ctx.auth!.householdId;
  const historyFilters = forecastFilters(ctx, '');
  const recurringFilters = forecastFilters(ctx, '');
  const plannedFilters = forecastFilters(ctx, '');
  const historyWhere = historyFilters.clauses.length ? ` AND ${historyFilters.clauses.join(' AND ')}` : '';
  const recurringWhere = recurringFilters.clauses.length ? ` AND ${recurringFilters.clauses.join(' AND ')}` : '';
  const plannedWhere = plannedFilters.clauses.length ? ` AND ${plannedFilters.clauses.join(' AND ')}` : '';
  const [historyRows, recurringRows, plannedRows] = await Promise.all([
    ctx.env.DB.prepare(`SELECT strftime('%Y-%m',occurred_on) AS month,
      SUM(CASE WHEN direction='income' THEN amount_minor ELSE 0 END) AS income_minor,
      SUM(CASE WHEN direction='expense' THEN amount_minor WHEN direction='refund' THEN -amount_minor ELSE 0 END) AS expense_minor
      FROM transactions WHERE household_id=? AND status='cleared' AND occurred_on>=? AND occurred_on<=? AND direction NOT IN ('transfer','adjustment')${historyWhere} GROUP BY month ORDER BY month`)
      .bind(householdId, `${firstHistoryMonth}-01`, shiftDays(currentMonthStart, -1), ...historyFilters.values).all<Record<string, unknown>>(),
    ctx.env.DB.prepare(`SELECT direction,amount_minor,cadence,interval_count,next_due_on,ends_on FROM recurring_rules WHERE household_id=? AND active=1 AND next_due_on<? AND (ends_on IS NULL OR ends_on>=?)${recurringWhere}`)
      .bind(householdId, forecastEnd, `${firstForecastMonth}-01`, ...recurringFilters.values).all<Record<string, unknown>>(),
    ctx.env.DB.prepare(`SELECT direction,amount_minor,occurred_on FROM transactions WHERE household_id=? AND status='planned' AND occurred_on>=? AND occurred_on<? AND direction IN ('income','expense')${plannedWhere}`)
      .bind(householdId, `${firstForecastMonth}-01`, forecastEnd, ...plannedFilters.values).all<Record<string, unknown>>(),
  ]);
  const observedRows = historyRows.results ?? [];
  const byMonth = new Map(observedRows.map((row) => [String(row.month), row])); const history: MonthlyHistory[] = [];
  const firstObservedMonth = observedRows.length ? String(observedRows[0]!.month) : null;
  for (let index = 0; index < historyMonths; index += 1) {
    const month = addMonthsClamped(`${firstHistoryMonth}-01`, index).slice(0, 7); const row = byMonth.get(month);
    if (firstObservedMonth && month >= firstObservedMonth) history.push({ month, incomeMinor: num(row?.income_minor), expenseMinor: num(row?.expense_minor) });
  }
  const recurring: ForecastRecurringRule[] = (recurringRows.results ?? []).map((row) => ({ direction: row.direction as 'income' | 'expense', amountMinor: num(row.amount_minor), cadence: row.cadence as ForecastRecurringRule['cadence'], intervalCount: num(row.interval_count), nextDueOn: String(row.next_due_on), endsOn: row.ends_on ? String(row.ends_on) : null }));
  for (const row of plannedRows.results ?? []) recurring.push({ direction: row.direction as 'income' | 'expense', amountMinor: num(row.amount_minor), cadence: 'daily', intervalCount: 1, nextDueOn: String(row.occurred_on), endsOn: String(row.occurred_on), additive: true });
  return json(deterministicForecast(history, recurring, months, asOf));
}

export async function handleAudit(ctx: RouteContext): Promise<Response> {
  if (ctx.request.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Allowed method: GET.');
  if (!['owner', 'admin'].includes(ctx.auth!.role)) throw new ApiError(403, 'ADMIN_REQUIRED', 'Household administrator access is required.');
  const { page, pageSize, offset } = pagination(ctx.url); const householdId = ctx.auth!.householdId;
  const [rows, count] = await Promise.all([
    ctx.env.DB.prepare(`SELECT a.id,a.action,a.entity_type,a.entity_id,a.details_json,a.created_at,u.display_name AS user_name
      FROM audit_logs a LEFT JOIN users u ON u.id=a.user_id WHERE a.household_id=? ORDER BY a.created_at DESC LIMIT ? OFFSET ?`).bind(householdId, pageSize, offset).all<Record<string, unknown>>(),
    ctx.env.DB.prepare('SELECT COUNT(*) AS total FROM audit_logs WHERE household_id=?').bind(householdId).first<{ total: number }>(),
  ]);
  const total = num(count?.total);
  return json({ items: (rows.results ?? []).map((row) => { let details: unknown = {}; try { details = JSON.parse(String(row.details_json)); } catch { details = {}; } return { id: row.id, action: row.action, entityType: row.entity_type, entityId: row.entity_id, details, createdAt: row.created_at, userName: row.user_name }; }), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}
