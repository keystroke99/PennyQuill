import { describe, expect, it } from 'vitest';
import { addMonthsClamped, deterministicForecast, type MonthlyHistory } from '../worker/src/analytics';
import { parseSmsMessage } from '../worker/src/sms';

describe('deterministic forecast', () => {
  const history: MonthlyHistory[] = Array.from({ length: 12 }, (_, index) => ({
    month: `2025-${String(index + 1).padStart(2, '0')}`,
    incomeMinor: 100_000,
    expenseMinor: 60_000 + index * 1_000,
  }));

  it('is repeatable and keeps commitments as an expense floor', () => {
    const recurring = [{ direction: 'expense' as const, amountMinor: 80_000, cadence: 'monthly' as const, intervalCount: 1, nextDueOn: '2026-01-05', endsOn: null }];
    const first = deterministicForecast(history, recurring, 3, '2025-12-31');
    expect(first).toEqual(deterministicForecast(history, recurring, 3, '2025-12-31'));
    expect(first.months).toHaveLength(3);
    expect(first.months.every((month) => month.expenseMinor >= month.committedExpenseMinor)).toBe(true);
    expect(first.methodology).toContain('No AI');
  });

  it('returns no invented forecast without history or commitments', () => {
    expect(deterministicForecast([], [], 6, '2025-12-31').months).toEqual([]);
    expect(deterministicForecast([], [], 6, '2025-12-31').historyMonths).toBe(0);
  });

  it('adds one-off planned items to the baseline instead of hiding them behind the recurring floor', () => {
    const baseline: MonthlyHistory[] = [{ month: '2026-08', incomeMinor: 200_000, expenseMinor: 50_000 }];
    const rules = [
      { direction: 'expense' as const, amountMinor: 20_000, cadence: 'monthly' as const, intervalCount: 1, nextDueOn: '2026-10-05', endsOn: null },
      { direction: 'expense' as const, amountMinor: 30_000, cadence: 'yearly' as const, intervalCount: 1, nextDueOn: '2026-10-10', endsOn: '2026-10-10', additive: true },
    ];
    const result = deterministicForecast(baseline, rules, 1, '2026-09-29');
    expect(result.months[0]?.expenseMinor).toBe(80_000);
    expect(result.months[0]?.committedExpenseMinor).toBe(50_000);
    expect(result.months[0]?.lowerExpenseMinor).toBeGreaterThanOrEqual(50_000);
  });

  it('clamps month-end dates', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2024-01-31', 1)).toBe('2024-02-29');
  });
});

describe('SMS parser', () => {
  it('extracts integer minor units', () => {
    const parsed = parseSmsMessage('INR 1,234.50 debited from A/c XX9988 at ABC STORE on 29/09/2026.');
    expect(parsed.direction).toBe('expense');
    expect(parsed.amountMinor).toBe(123450);
    expect(parsed.occurredOn).toBe('2026-09-29');
    expect(parsed.accountLast4).toBe('9988');
  });

  it('recognizes refunds as spending offsets', () => {
    expect(parseSmsMessage('Rs.500.00 refund credited on 20-09-2026').direction).toBe('refund');
  });

  it('does not confuse generic UPI transaction wording with incoming money', () => {
    const parsed = parseSmsMessage('INR 799 debited from A/c XX4455 via UPI Txn at ACME STORE on 29/09/2026');
    expect(parsed.direction).toBe('expense');
    expect(parsed.amountMinor).toBe(79_900);
  });
});
