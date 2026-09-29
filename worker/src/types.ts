export type D1Value = string | number | null | ArrayBuffer;

export interface D1Result<T = Record<string, unknown>> {
  success: boolean;
  results?: T[];
  meta?: Record<string, unknown>;
  error?: string;
}

export interface D1PreparedStatement {
  bind(...values: D1Value[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface AssetFetcher {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  DB: D1Database;
  APP_SETUP_KEY: string;
  PASSWORD_PEPPER?: string;
  APP_ENV?: string;
  APP_ORIGIN?: string;
  SESSION_DAYS?: string;
  ASSETS?: AssetFetcher;
}

export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export interface AuthContext {
  sessionId: string;
  userId: string;
  householdId: string;
  email: string;
  displayName: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface RouteContext {
  request: Request;
  env: Env;
  url: URL;
  auth?: AuthContext;
}

export interface TransactionInput {
  memberId: string | null;
  categoryId: string | null;
  accountId: string | null;
  transferAccountId: string | null;
  direction: 'expense' | 'income' | 'transfer' | 'refund' | 'adjustment';
  status: 'pending' | 'cleared' | 'planned';
  amountMinor: number;
  occurredOn: string;
  merchant: string | null;
  note: string | null;
  source: 'manual' | 'sms' | 'recurring' | 'import';
  externalRef: string | null;
  importHash: string | null;
  tags: string[];
  reviewedAt: string | null;
}
