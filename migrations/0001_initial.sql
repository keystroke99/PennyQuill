PRAGMA foreign_keys = ON;

CREATE TABLE setup_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  completed_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (length(currency) = 3),
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations >= 100000),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (household_id, email)
);

CREATE UNIQUE INDEX users_email_global_unique ON users(lower(email));

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE INDEX sessions_token_expiry_idx ON sessions(token_hash, expires_at);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  relationship TEXT NOT NULL DEFAULT 'self' CHECK (length(relationship) BETWEEN 1 AND 50),
  avatar_icon TEXT NOT NULL DEFAULT 'user-round',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (household_id, user_id)
);

CREATE INDEX members_household_idx ON members(household_id, active);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'both')),
  classification TEXT NOT NULL DEFAULT 'discretionary' CHECK (classification IN ('essential', 'discretionary', 'savings')),
  icon TEXT NOT NULL DEFAULT 'circle-dollar-sign',
  color TEXT NOT NULL DEFAULT '#64748B' CHECK (length(color) BETWEEN 4 AND 9),
  is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (household_id, name, kind)
);

CREATE INDEX categories_household_idx ON categories(household_id, kind, active);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  type TEXT NOT NULL CHECK (type IN ('cash', 'bank', 'credit_card', 'wallet', 'investment', 'other')),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  opening_balance_minor INTEGER NOT NULL DEFAULT 0,
  include_in_net_worth INTEGER NOT NULL DEFAULT 1 CHECK (include_in_net_worth IN (0, 1)),
  icon TEXT NOT NULL DEFAULT 'wallet-cards',
  color TEXT NOT NULL DEFAULT '#2563EB' CHECK (length(color) BETWEEN 4 AND 9),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (household_id, name)
);

CREATE INDEX accounts_household_idx ON accounts(household_id, active);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id TEXT REFERENCES members(id) ON DELETE RESTRICT,
  category_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
  account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  transfer_account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  direction TEXT NOT NULL CHECK (direction IN ('expense', 'income', 'transfer', 'refund', 'adjustment')),
  status TEXT NOT NULL DEFAULT 'cleared' CHECK (status IN ('pending', 'cleared', 'planned')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  occurred_on TEXT NOT NULL CHECK (length(occurred_on) = 10),
  merchant TEXT CHECK (merchant IS NULL OR length(merchant) <= 120),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'sms', 'recurring', 'import')),
  external_ref TEXT,
  import_hash TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array'),
  reviewed_at TEXT,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (direction = 'transfer' AND account_id IS NOT NULL AND transfer_account_id IS NOT NULL AND account_id <> transfer_account_id AND category_id IS NULL)
    OR
    (direction IN ('expense', 'income', 'refund', 'adjustment') AND transfer_account_id IS NULL)
  ),
  UNIQUE (household_id, external_ref),
  UNIQUE (household_id, import_hash)
);

CREATE INDEX transactions_household_date_idx ON transactions(household_id, occurred_on DESC, id);
CREATE INDEX transactions_category_date_idx ON transactions(household_id, category_id, occurred_on);
CREATE INDEX transactions_member_date_idx ON transactions(household_id, member_id, occurred_on);
CREATE INDEX transactions_account_date_idx ON transactions(household_id, account_id, occurred_on);
CREATE INDEX transactions_merchant_idx ON transactions(household_id, merchant);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  category_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
  member_id TEXT REFERENCES members(id) ON DELETE RESTRICT,
  period TEXT NOT NULL CHECK (period IN ('weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly', 'custom')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  starts_on TEXT NOT NULL CHECK (length(starts_on) = 10),
  ends_on TEXT CHECK (ends_on IS NULL OR length(ends_on) = 10),
  rollover INTEGER NOT NULL DEFAULT 0 CHECK (rollover IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);

CREATE INDEX budgets_household_idx ON budgets(household_id, active, starts_on, ends_on);

CREATE TABLE recurring_rules (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id TEXT REFERENCES members(id) ON DELETE RESTRICT,
  category_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
  account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  direction TEXT NOT NULL CHECK (direction IN ('expense', 'income')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  merchant TEXT CHECK (merchant IS NULL OR length(merchant) <= 120),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly')),
  interval_count INTEGER NOT NULL DEFAULT 1 CHECK (interval_count BETWEEN 1 AND 100),
  next_due_on TEXT NOT NULL CHECK (length(next_due_on) = 10),
  ends_on TEXT CHECK (ends_on IS NULL OR length(ends_on) = 10),
  auto_post INTEGER NOT NULL DEFAULT 0 CHECK (auto_post IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (ends_on IS NULL OR ends_on >= next_due_on)
);

CREATE INDEX recurring_household_due_idx ON recurring_rules(household_id, active, next_due_on);

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id TEXT REFERENCES members(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  goal_type TEXT NOT NULL DEFAULT 'savings' CHECK (goal_type IN ('savings', 'debt_payoff', 'purchase', 'emergency_fund', 'other')),
  target_minor INTEGER NOT NULL CHECK (target_minor > 0),
  current_minor INTEGER NOT NULL DEFAULT 0 CHECK (current_minor >= 0),
  target_date TEXT CHECK (target_date IS NULL OR length(target_date) = 10),
  icon TEXT NOT NULL DEFAULT 'goal',
  color TEXT NOT NULL DEFAULT '#16A34A' CHECK (length(color) BETWEEN 4 AND 9),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX goals_household_idx ON goals(household_id, active, target_date);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  entity_type TEXT NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 50),
  entity_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX audit_household_date_idx ON audit_logs(household_id, created_at DESC);

CREATE TRIGGER audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs are append-only');
END;

CREATE TRIGGER audit_logs_no_delete
BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs are append-only');
END;
