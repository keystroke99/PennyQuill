export interface MonthlyHistory {
  month: string;
  incomeMinor: number;
  expenseMinor: number;
}

export interface ForecastRecurringRule {
  direction: 'income' | 'expense';
  amountMinor: number;
  cadence: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'half_yearly' | 'yearly';
  intervalCount: number;
  nextDueOn: string;
  endsOn: string | null;
  additive?: boolean;
}

export interface ForecastMonth {
  month: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  lowerExpenseMinor: number;
  upperExpenseMinor: number;
  committedExpenseMinor: number;
}

const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function weightedAverage(values: number[]): number {
  if (!values.length) return 0;
  let total = 0;
  let weights = 0;
  values.forEach((value, index) => { total += value * (index + 1); weights += index + 1; });
  return total / weights;
}

function linearSlope(values: number[]): number {
  if (values.length < 3) return 0;
  const meanX = (values.length - 1) / 2;
  const meanY = average(values);
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - meanX) * (value - meanY);
    denominator += (index - meanX) ** 2;
  });
  return denominator ? numerator / denominator : 0;
}

const parseUtcDate = (value: string) => new Date(`${value}T00:00:00Z`);
const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export function addMonthsClamped(value: string, months: number): string {
  const source = parseUtcDate(value);
  const ordinal = source.getUTCFullYear() * 12 + source.getUTCMonth() + months;
  const year = Math.floor(ordinal / 12);
  const month = ((ordinal % 12) + 12) % 12;
  const finalDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return isoDate(new Date(Date.UTC(year, month, Math.min(source.getUTCDate(), finalDay))));
}

function addDays(value: string, days: number): string {
  const date = parseUtcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function advanceDueDate(rule: ForecastRecurringRule, current: string): string {
  switch (rule.cadence) {
    case 'daily': return addDays(current, rule.intervalCount);
    case 'weekly': return addDays(current, rule.intervalCount * 7);
    case 'monthly': return addMonthsClamped(current, rule.intervalCount);
    case 'quarterly': return addMonthsClamped(current, rule.intervalCount * 3);
    case 'half_yearly': return addMonthsClamped(current, rule.intervalCount * 6);
    case 'yearly': return addMonthsClamped(current, rule.intervalCount * 12);
  }
}

const nextMonth = (month: string, offset: number) => addMonthsClamped(`${month}-01`, offset).slice(0, 7);

function recurringCommitments(rules: ForecastRecurringRule[], firstMonth: string, count: number) {
  const expense = new Map<string, number>();
  const income = new Map<string, number>();
  const additiveExpense = new Map<string, number>();
  const additiveIncome = new Map<string, number>();
  const start = `${firstMonth}-01`;
  const endExclusive = `${nextMonth(firstMonth, count)}-01`;
  for (const rule of rules) {
    let due = rule.nextDueOn;
    let guard = 0;
    while (due < start && guard < 5_000) { due = advanceDueDate(rule, due); guard += 1; }
    while (due < endExclusive && (!rule.endsOn || due <= rule.endsOn) && guard < 5_000) {
      const month = due.slice(0, 7);
      const target = rule.additive
        ? rule.direction === 'expense' ? additiveExpense : additiveIncome
        : rule.direction === 'expense' ? expense : income;
      target.set(month, (target.get(month) ?? 0) + rule.amountMinor);
      due = advanceDueDate(rule, due);
      guard += 1;
    }
  }
  return { expense, income, additiveExpense, additiveIncome };
}

function seasonality(history: MonthlyHistory[], field: 'incomeMinor' | 'expenseMinor', monthNumber: number): number {
  if (history.length < 12) return 1;
  const overall = average(history.map((point) => point[field]));
  const matching = history.filter((point) => Number(point.month.slice(5, 7)) === monthNumber);
  if (overall <= 0 || !matching.length) return 1;
  const raw = average(matching.map((point) => point[field])) / overall;
  return clamp(1 + (raw - 1) * 0.35, 0.8, 1.2);
}

export function deterministicForecast(
  history: MonthlyHistory[], recurring: ForecastRecurringRule[], numberOfMonths: number, asOfDate: string,
) {
  const recent = [...history].sort((a, b) => a.month.localeCompare(b.month)).slice(-12);
  const methodology = 'Deterministic weighted moving average with capped linear trend, damped calendar seasonality, recurring commitment floors, additive planned items, and a volatility range. No AI or external model is used.';
  const assumptions = [
    'Recorded cleared transactions are representative and use complete integer-minor amounts.',
    'Active recurring rules set a known monthly floor; one-off planned items are added to the baseline so they remain visible.',
    'Monthly trend is capped at 8% of the historical mean and seasonal effects are damped and capped.',
    'The range describes historical variability, not a statistical guarantee.',
  ];
  if (!recent.length && !recurring.length) return {
    methodology, historyMonths: 0, months: [] as ForecastMonth[], confidence: 'low' as const,
    confidenceDetails: { score: 0, reason: 'No completed history or future commitments are available.' }, assumptions,
  };
  const expenseValues = recent.map((point) => point.expenseMinor);
  const incomeValues = recent.map((point) => point.incomeMinor);
  const expenseMean = average(expenseValues);
  const incomeMean = average(incomeValues);
  const expenseSlope = clamp(linearSlope(expenseValues), -expenseMean * 0.08, expenseMean * 0.08);
  const incomeSlope = clamp(linearSlope(incomeValues), -incomeMean * 0.08, incomeMean * 0.08);
  const expenseBase = weightedAverage(expenseValues.slice(-6));
  const incomeBase = weightedAverage(incomeValues.slice(-6));
  const volatility = standardDeviation(expenseValues);
  const firstMonth = nextMonth(asOfDate.slice(0, 7), 1);
  const commitments = recurringCommitments(recurring, firstMonth, numberOfMonths);
  const months: ForecastMonth[] = [];
  for (let index = 0; index < numberOfMonths; index += 1) {
    const month = nextMonth(firstMonth, index);
    const monthNumber = Number(month.slice(5, 7));
    const committedExpenseMinor = commitments.expense.get(month) ?? 0;
    const committedIncomeMinor = commitments.income.get(month) ?? 0;
    const additiveExpenseMinor = commitments.additiveExpense.get(month) ?? 0;
    const additiveIncomeMinor = commitments.additiveIncome.get(month) ?? 0;
    const expenseMinor = additiveExpenseMinor + Math.max(committedExpenseMinor, Math.round(
      Math.max(0, expenseBase + expenseSlope * (index + 1)) * seasonality(recent, 'expenseMinor', monthNumber),
    ));
    const incomeMinor = additiveIncomeMinor + Math.max(committedIncomeMinor, Math.round(
      Math.max(0, incomeBase + incomeSlope * (index + 1)) * seasonality(recent, 'incomeMinor', monthNumber),
    ));
    const totalCommittedExpense = committedExpenseMinor + additiveExpenseMinor;
    const interval = Math.round(volatility * Math.min(1.75, 0.8 + Math.sqrt(index + 1) * 0.25));
    months.push({
      month, incomeMinor, expenseMinor, netMinor: incomeMinor - expenseMinor,
      lowerExpenseMinor: Math.max(totalCommittedExpense, expenseMinor - interval),
      upperExpenseMinor: expenseMinor + interval, committedExpenseMinor: totalCommittedExpense,
    });
  }
  const nonEmpty = recent.filter((point) => point.incomeMinor > 0 || point.expenseMinor > 0).length;
  const variation = expenseMean > 0 ? volatility / expenseMean : 1;
  const score = Math.round(clamp(25 + nonEmpty * 5 - variation * 20, 10, 90));
  const level: 'low' | 'medium' | 'high' = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low';
  return {
    methodology,
    historyMonths: recent.length,
    months,
    confidence: level,
    confidenceDetails: { score, reason: `${nonEmpty} month(s) contain activity; expense volatility is ${Math.round(variation * 100)}% of the mean.` },
    assumptions,
  };
}
