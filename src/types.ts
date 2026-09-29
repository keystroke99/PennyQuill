export type TransactionDirection = "expense" | "income" | "transfer" | "refund" | "adjustment";
export type TransactionStatus = "pending" | "cleared" | "planned";

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: "owner" | "admin" | "member" | "viewer";
  mustChangePassword: boolean;
}

export interface Household {
  id: string;
  name: string;
  currency: string;
  timezone: string;
}

export interface AuthSession {
  user: User;
  household: Household;
}

export interface Member {
  id: string;
  userId?: string | null;
  name: string;
  relationship: string;
  avatarIcon: string;
  active: boolean;
}

export interface Category {
  id: string;
  parentId: string | null;
  name: string;
  kind: "expense" | "income" | "both";
  classification: "essential" | "discretionary" | "savings";
  icon: string;
  color: string;
  isSystem: boolean;
  active: boolean;
}

export interface Account {
  id: string;
  name: string;
  type: "cash" | "bank" | "credit_card" | "wallet" | "investment" | "other";
  currency: string;
  openingBalanceMinor: number;
  currentBalanceMinor?: number;
  includeInNetWorth: boolean;
  icon: string;
  color: string;
  active: boolean;
}

export interface Transaction {
  id: string;
  memberId: string | null;
  memberName?: string | null;
  categoryId: string | null;
  categoryName?: string | null;
  categoryIcon?: string | null;
  categoryColor?: string | null;
  accountId: string | null;
  accountName?: string | null;
  transferAccountId: string | null;
  direction: TransactionDirection;
  status: TransactionStatus;
  amountMinor: number;
  occurredOn: string;
  merchant: string | null;
  note: string | null;
  source: "manual" | "sms" | "recurring" | "import";
  tags: string[];
  reviewedAt: string | null;
  createdAt: string;
}

export interface Budget {
  id: string;
  name: string;
  categoryId: string | null;
  memberId: string | null;
  period: "weekly" | "monthly" | "quarterly" | "half_yearly" | "yearly" | "custom";
  amountMinor: number;
  startsOn: string;
  endsOn: string | null;
  rollover: boolean;
  active: boolean;
  spentMinor?: number;
}

export interface RecurringRule {
  id: string;
  name: string;
  direction: "expense" | "income";
  amountMinor: number;
  memberId: string | null;
  categoryId: string | null;
  accountId: string | null;
  merchant: string | null;
  cadence: "daily" | "weekly" | "monthly" | "quarterly" | "half_yearly" | "yearly";
  intervalCount: number;
  nextDueOn: string;
  endsOn: string | null;
  autoPost: boolean;
  active: boolean;
}

export interface Goal {
  id: string;
  memberId: string | null;
  name: string;
  goalType: "savings" | "debt_payoff" | "purchase" | "emergency_fund" | "other";
  targetMinor: number;
  currentMinor: number;
  targetDate: string | null;
  icon: string;
  color: string;
  active: boolean;
}

export interface Summary {
  incomeMinor: number;
  expenseMinor: number;
  refundMinor?: number;
  netMinor: number;
  savingsRate: number | null;
  budgetMinor?: number;
  budgetUsedPercent?: number | null;
  transactionCount?: number;
}

export interface TrendPoint {
  date: string;
  label: string;
  incomeMinor: number;
  expenseMinor: number;
  refundMinor?: number;
  netMinor?: number;
}

export interface BreakdownItem {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  amountMinor: number;
  percentage: number;
  transactionCount: number;
  changePercent?: number | null;
}

export interface DashboardData {
  period: { from: string; to: string };
  summary: Summary;
  trend: TrendPoint[];
  categoryBreakdown: BreakdownItem[];
  recentTransactions: Transaction[];
  upcomingRecurring: RecurringRule[];
  budgets?: Budget[];
}

export interface AnalyticsData {
  period: { from: string; to: string; granularity?: string };
  summary: Summary;
  comparison?: Summary & { changePercent?: number | null };
  series: TrendPoint[];
  categories: BreakdownItem[];
  members: BreakdownItem[];
  merchants: BreakdownItem[];
  essentialVsDiscretionary: BreakdownItem[];
  largestTransactions: Transaction[];
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

export interface ForecastData {
  methodology: string;
  historyMonths: number;
  confidence: "low" | "medium" | "high";
  assumptions: string[];
  months: ForecastMonth[];
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface SmsCandidate {
  id?: string;
  direction: "expense" | "income";
  amountMinor: number;
  currency: string;
  occurredOn: string;
  merchant: string | null;
  sender?: string | null;
  categoryId?: string | null;
  confidence: number;
  reasons: string[];
  maskedPreview: string;
  externalRef?: string;
  originalDirection?: "expense" | "income" | "refund";
  originalText?: string;
}

export interface ReferenceData {
  members: Member[];
  categories: Category[];
  accounts: Account[];
}

export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}
