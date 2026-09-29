# PennyQuill Worker API

This directory contains a framework-free Cloudflare Worker API backed by D1. All monetary values are signed or positive **integer minor units** (`₹12.34` is `1234`); the household's ISO currency controls display only. The Worker can serve the compiled SPA through the optional `ASSETS` binding.

## Security and setup

- Apply all migrations in order (including `migrations/0002_force_password_change.sql`), set the `APP_SETUP_KEY` Worker secret (minimum 16 characters), then call `POST /api/setup` once. D1's transactional `batch` creates the household, owner, linked member, Cash account, default categories, session, and audit event. The `setup_state` primary key closes concurrent setup attempts.
- Normal and replacement passwords require at least 8 characters with a letter and number. Admin-created temporary passwords also require at least 8 characters when `mustChangePassword` is true; new managed users default to that forced-change state. Passwords use PBKDF2-SHA-256 with a random 128-bit salt, Cloudflare Workers' supported 100,000-iteration maximum, and a separate production `PASSWORD_PEPPER` secret.
- Login failures are tracked only by a SHA-256 email identifier, never plaintext email. Eight failures in a rolling 15-minute window block more attempts until the window expires; successful login clears the record. Unknown and inactive accounts still execute PBKDF2 against fixed dummy credentials and return the same generic invalid-credentials error.
- Session tokens contain 256 random bits; only their SHA-256 hashes are stored. Completing a password change preserves the current session and revokes every other session for that user.
- The browser receives `pennyquill_session` with `Secure; HttpOnly; SameSite=Strict; Path=/`. Sessions default to 30 days (`SESSION_DAYS`, range 1–90).
- Mutation requests reject cross-site Fetch Metadata and unexpected `Origin` values. `APP_ORIGIN` may contain comma-separated same-site origins when needed. Deploy the UI and API on one origin for the strict cookie to work.
- Every lookup and mutation is constrained by the authenticated `household_id`. `viewer` is read-only; household/user administration and audit access require `owner` or `admin`.
- Audit records are append-only at the database layer. API errors use `{ "error": { "code", "message", "details?" } }` and never return SQL text.

## Public routes

| Method | Route | Contract |
|---|---|---|
| `GET` | `/api/health` | `{ok:true}` |
| `GET` | `/api/setup/status` | `{configured:boolean}` only; exposes no household data |
| `POST` | `/api/setup` | `{setupKey,householdName,displayName,email,password,currency?,timezone?}` → `{user,household}` and session cookie |
| `POST` | `/api/auth/login` | `{email,password}` → `{user}` (including `mustChangePassword`) and session cookie |
| `POST` | `/api/auth/logout` | Revokes the presented token and clears the cookie |

## Authenticated routes

| Method | Route | Notes |
|---|---|---|
| `GET` | `/api/auth/me` | `{user,household}`; `user.mustChangePassword` reports the forced-change state |
| `POST` | `/api/auth/change-password` | `{currentPassword,newPassword}`; changes the password, clears the forced-change state, audits, and revokes other sessions |
| `GET/PATCH` | `/api/household` | Name, three-letter currency, and IANA timezone; patch is admin-only |
| `GET/POST` | `/api/users` | Admin-only login-account list/create; POST accepts `mustChangePassword` (default `true`) |
| `PATCH/DELETE` | `/api/users/:id` | Admin-only update/deactivate; PATCH accepts and returns `mustChangePassword`; self-deactivation is rejected |
| `GET/POST` | `/api/{members,categories,accounts,budgets,recurring,goals}` | Lists are `{items,pagination}`; create returns the item |
| `GET/PATCH/DELETE` | `/api/{members,categories,accounts,budgets,recurring,goals}/:id` | Delete safely deactivates referenced master data |
| `GET/POST` | `/api/transactions` | List/filter or create; list pagination fields are top-level |
| `GET/PATCH/DELETE` | `/api/transactions/:id` | Fetch, edit, or delete one household transaction |
| `POST` | `/api/transactions/sms/preview` | `{text}` → `{preview,candidates,privacyNotice,persisted:false}`; saves nothing |
| `POST` | `/api/transactions/sms/import` | Reviewed candidate (`reviewed:true`) or `{confirmed:true,originalText,transaction}`; saves parsed fields, never raw SMS |
| `GET` | `/api/dashboard?from&to` | Mobile dashboard aggregates, category breakdown, recent activity, upcoming recurring rules |
| `GET` | `/api/analytics?from&to&granularity&memberId&categoryId&accountId` | Deep drill-down; granularity is `day`, `week`, `month`, `quarter`, or `year` |
| `GET` | `/api/analytics/forecast?months=6&historyMonths=12&asOf=YYYY-MM-DD` | Transparent deterministic projection; 1–24 future and 6–36 history months |
| `GET` | `/api/audit?page&pageSize` | Admin-only append-only activity trail |

List routes accept `page` (default 1) and `pageSize` (default 25, maximum 100). Transaction lists additionally accept `from`, `to`, `direction`, `status`, `memberId`, `categoryId`, `accountId`, and `search`. Master lists accept `includeInactive=true`; categories also accept `kind`.

When an authenticated user has `mustChangePassword: true`, only `GET /api/auth/me`, `POST /api/auth/change-password`, and the public logout endpoint are usable. Every other authenticated API route returns `403 PASSWORD_CHANGE_REQUIRED` until the password is changed.

## Transaction semantics

`direction` is `expense`, `income`, `transfer`, `refund`, or `adjustment`. `status` is `pending`, `cleared`, or `planned`. Transfers require distinct source/destination accounts and no category. Refunds use expense categories and reduce cleared spending. Adjustments and transfers are excluded from income/spending analytics. Historical analytics use cleared entries only; planned entries and active recurring rules become forecast commitments. Tags are a JSON string array (maximum 20 normalized tags).

Confirmed SMS imports derive a server-side SHA-256 hash from normalized message text. `(household_id, import_hash)` is unique, so the same alert returns `409 DUPLICATE_IMPORT`. The raw SMS is never written to D1 or the audit log. iOS web apps cannot read the Messages inbox; the intended flow is paste/share text, preview locally through this endpoint, review, then approve. A future native Android bridge must call the same preview/review API and must not bypass consent.

## Analytics and forecast response shapes

`GET /api/dashboard` returns:

```json
{"period":{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"},"summary":{"incomeMinor":0,"expenseMinor":0,"netMinor":0,"savingsRate":null,"budgetMinor":0,"budgetUsedPercent":null},"trend":[],"categoryBreakdown":[],"recentTransactions":[],"upcomingRecurring":[]}
```

`GET /api/analytics` returns `period`, `summary`, `series`, `categories`, `members`, `merchants`, `essentialVsDiscretionary`, `largestTransactions`, and equal-duration `comparison`. Refunds offset spending in every aggregate.

`GET /api/analytics/forecast` returns `methodology`, `historyMonths`, `months`, `confidence`, `confidenceDetails`, and `assumptions`. It uses a six-month weighted moving average, capped linear trend, damped/capped calendar seasonality, recurring/planned commitments, and historical volatility bounds. It does not call AI, an external service, or a nondeterministic model.

## D1 notes

All user values are passed through prepared statement bindings. The only SQL fragments composed at runtime are allow-listed table/column/order/bucket expressions. Apply migrations with the repository command before local development or deploy. D1 foreign keys protect references, and unique constraints cover users, household category/account names, external references, and import hashes.
