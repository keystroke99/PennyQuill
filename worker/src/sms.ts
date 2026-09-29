export interface SmsPreview {
  direction: 'expense' | 'income' | 'refund' | null;
  amountMinor: number | null;
  currency: string;
  occurredOn: string | null;
  merchant: string | null;
  accountLast4: string | null;
  suggestedCategoryName: string | null;
  confidence: number;
  warnings: string[];
}

function toMinorUnits(raw: string): number | null {
  const normalized = raw.replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ''] = normalized.split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

function parsedDate(text: string): string | null {
  const match = text.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (!match) return null;
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  const month = Number(match[2]);
  const day = Number(match[1]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function suggestedCategory(text: string, direction: SmsPreview['direction']): string | null {
  const lower = text.toLowerCase();
  if (direction === 'income') {
    if (/salary|payroll|wage/.test(lower)) return 'Salary';
    if (/interest|dividend/.test(lower)) return 'Investment Income';
    return 'Other Income';
  }
  if (direction === 'refund') return 'Refunds';
  const categories: Array<[RegExp, string]> = [
    [/swiggy|zomato|restaurant|cafe|food/, 'Food & Dining'],
    [/uber|ola|rapido|fuel|petrol|diesel|metro|railway/, 'Transport'],
    [/amazon|flipkart|myntra|retail|store/, 'Shopping'],
    [/electric|water bill|gas bill|broadband|mobile bill|utility/, 'Utilities'],
    [/hospital|clinic|pharmacy|medical/, 'Healthcare'],
    [/netflix|spotify|cinema|movie|game/, 'Entertainment'],
    [/rent|landlord/, 'Housing'],
    [/school|college|tuition|course/, 'Education'],
    [/insurance|premium/, 'Insurance'],
  ];
  return categories.find(([pattern]) => pattern.test(lower))?.[1] ?? (direction === 'expense' ? 'Other Expense' : null);
}

function merchantName(text: string): string | null {
  const patterns = [
    /(?:at|to)\s+([A-Za-z0-9][A-Za-z0-9 .&'_-]{1,60}?)(?=\s+(?:on|via|using|ref|avl|available|balance)\b|[.,]|$)/i,
    /(?:merchant)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 .&'_-]{1,60})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim().replace(/\s+/g, ' ').slice(0, 120);
  }
  return null;
}

export function parseSmsMessage(text: string): SmsPreview {
  const lower = text.toLowerCase();
  const refund = /\b(refund|reversal|reversed|cashback)\b/.test(lower);
  const expense = /\b(debited|spent|paid|purchase|withdrawn|payment|debit)\b/.test(lower);
  const income = /\b(credited|deposited|received|salary)\b/.test(lower);
  const direction: SmsPreview['direction'] = refund ? 'refund' : expense && !income ? 'expense' : income && !expense ? 'income' : null;
  const amountMatch = text.match(/(?:₹|inr|rs\.?)(?:\s*)([0-9][0-9,]*(?:\.\d{1,2})?)/i)
    ?? text.match(/\b([0-9][0-9,]*\.\d{2})\b/);
  const amountMinor = amountMatch?.[1] ? toMinorUnits(amountMatch[1]) : null;
  const accountMatch = text.match(/(?:a\/c|acct|account|card)(?:\s*(?:no\.?|ending|x+|\*+)?)?\s*[:\-]?\s*(?:x+|\*+)?(\d{4})\b/i);
  const occurredOn = parsedDate(text);
  const merchant = merchantName(text);
  const warnings: string[] = [];
  if (!direction) warnings.push('Could not reliably decide whether this is income, expense, or refund.');
  if (!amountMinor) warnings.push('Could not find a positive currency amount.');
  if (!occurredOn) warnings.push('No unambiguous DD/MM/YYYY or DD-MM-YYYY date was found; choose the date during review.');
  if (!merchant && direction === 'expense') warnings.push('Merchant was not identified; add or correct it during review.');
  const recognized = [direction, amountMinor, occurredOn, merchant, accountMatch].filter(Boolean).length;
  return {
    direction,
    amountMinor,
    currency: /(?:\$|usd)/i.test(text) ? 'USD' : 'INR',
    occurredOn,
    merchant,
    accountLast4: accountMatch?.[1] ?? null,
    suggestedCategoryName: suggestedCategory(text, direction),
    confidence: Math.round((recognized / 5) * 100),
    warnings,
  };
}
