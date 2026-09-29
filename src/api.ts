import type {
  Account,
  AnalyticsData,
  AuthSession,
  Budget,
  Category,
  DashboardData,
  ForecastData,
  Goal,
  Member,
  Paginated,
  RecurringRule,
  ReferenceData,
  SmsCandidate,
  Transaction,
  User,
} from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  headers.set("Accept", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "include" });
  const payload = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { code?: string; message?: string; details?: unknown };
  } & T;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload.error?.code ?? "REQUEST_FAILED",
      payload.error?.message ?? "Something went wrong. Please try again.",
      payload.error?.details,
    );
  }
  return (payload.data ?? payload) as T;
}

function query(params: Record<string, string | number | null | undefined>) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const api = {
  setupStatus: () => request<{ configured: boolean }>("/api/setup/status"),
  setup: (body: Record<string, unknown>) =>
    request<AuthSession>("/api/setup", { method: "POST", body: JSON.stringify(body) }),
  login: (email: string, password: string) =>
    request<AuthSession>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<AuthSession>("/api/auth/me"),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ user: User }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  referenceData: async (): Promise<ReferenceData> => {
    const [members, categories, accounts] = await Promise.all([
      request<{ items: Member[] } | Member[]>("/api/members"),
      request<{ items: Category[] } | Category[]>("/api/categories"),
      request<{ items: Account[] } | Account[]>("/api/accounts"),
    ]);
    const unwrap = <T>(value: { items: T[] } | T[]) => Array.isArray(value) ? value : value.items;
    return { members: unwrap(members), categories: unwrap(categories), accounts: unwrap(accounts) };
  },

  dashboard: (from: string, to: string) =>
    request<DashboardData>(`/api/dashboard${query({ from, to })}`),
  analytics: (params: Record<string, string | number | null | undefined>) =>
    request<AnalyticsData>(`/api/analytics${query(params)}`),
  forecast: (params: Record<string, string | number | null | undefined> = { months: 6 }) =>
    request<ForecastData>(`/api/analytics/forecast${query(params)}`),

  transactions: (params: Record<string, string | number | null | undefined> = {}) =>
    request<Paginated<Transaction>>(`/api/transactions${query(params)}`),
  createTransaction: (body: Record<string, unknown>) =>
    request<Transaction>("/api/transactions", { method: "POST", body: JSON.stringify(body) }),
  updateTransaction: (id: string, body: Record<string, unknown>) =>
    request<Transaction>(`/api/transactions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteTransaction: (id: string) =>
    request<{ ok: true }>(`/api/transactions/${id}`, { method: "DELETE" }),

  smsPreview: (text: string) =>
    request<{ candidates: SmsCandidate[]; privacyNotice?: string }>("/api/transactions/sms/preview", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  smsImport: (candidate: SmsCandidate & Record<string, unknown>) =>
    request<Transaction>("/api/transactions/sms/import", { method: "POST", body: JSON.stringify(candidate) }),

  members: () => request<{ items: Member[] } | Member[]>("/api/members"),
  createMember: (body: Record<string, unknown>) =>
    request<Member>("/api/members", { method: "POST", body: JSON.stringify(body) }),
  updateMember: (id: string, body: Record<string, unknown>) =>
    request<Member>(`/api/members/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteMember: (id: string) =>
    request<void>(`/api/members/${id}`, { method: "DELETE" }),
  categories: () => request<{ items: Category[] } | Category[]>("/api/categories"),
  accounts: () => request<{ items: Account[] } | Account[]>("/api/accounts"),
  createAccount: (body: Record<string, unknown>) =>
    request<Account>("/api/accounts", { method: "POST", body: JSON.stringify(body) }),
  createCategory: (body: Record<string, unknown>) =>
    request<Category>("/api/categories", { method: "POST", body: JSON.stringify(body) }),
  budgets: () => request<{ items: Budget[] } | Budget[]>("/api/budgets"),
  createBudget: (body: Record<string, unknown>) =>
    request<Budget>("/api/budgets", { method: "POST", body: JSON.stringify(body) }),
  recurring: () => request<{ items: RecurringRule[] } | RecurringRule[]>("/api/recurring"),
  createRecurring: (body: Record<string, unknown>) =>
    request<RecurringRule>("/api/recurring", { method: "POST", body: JSON.stringify(body) }),
  goals: () => request<{ items: Goal[] } | Goal[]>("/api/goals"),
  createGoal: (body: Record<string, unknown>) =>
    request<Goal>("/api/goals", { method: "POST", body: JSON.stringify(body) }),
};
