# Cloudflare deployment

This runbook deploys PennyQuill as one Cloudflare Worker with Static Assets and one D1 database. Static asset requests are served by Cloudflare's asset layer; /api/* invokes the Worker.

## 1. Install and authenticate

~~~powershell
npm install
npx wrangler login
~~~

Do not put Cloudflare tokens, passwords or the setup key in Git.

## 2. Create D1

~~~powershell
npx wrangler d1 create pennyquill-db --location=apac
~~~

Copy the returned database UUID into `wrangler.jsonc` and verify that its `database_name` is `pennyquill-db`. APAC is a placement hint, not a residency guarantee. This repository already contains the production database binding created for the initial PennyQuill deployment; create a different database only for a new Cloudflare account or isolated environment.

## 3. Configure the first-run secret

Generate two independent long random values in your password manager, then store them as Worker secrets:

~~~powershell
npx wrangler secret put APP_SETUP_KEY
npx wrangler secret put PASSWORD_PEPPER
~~~

Enter each value only at its prompt. Do not place either value in `wrangler.jsonc`, source code, a screenshot or shell history. `APP_SETUP_KEY` is accepted exactly once; D1 closes setup after the owner account exists. `PASSWORD_PEPPER` must be at least 32 characters, must remain configured for every deployment and must be backed up in an approved password manager—losing it prevents password verification.

After setup is complete, remove only the one-time setup secret:

~~~powershell
npx wrangler secret delete APP_SETUP_KEY
~~~

Never remove or rotate `PASSWORD_PEPPER` without a tested password rehash migration.

SESSION_DAYS defaults to 30 and accepts 1–90. Keep UI and API on one origin for strict cookies.

## 4. Apply the remote schema

~~~powershell
npm run db:migrate:remote
npx wrangler d1 migrations list pennyquill-db --remote
~~~

Confirm both `0001_initial.sql` and `0002_force_password_change.sql` are applied. The schema includes household indexes, forced-password state, throttled login-attempt storage and append-only audit triggers.

## 5. Build and deploy

~~~powershell
npm run icons
npm run typecheck
npm test
npm run deploy
~~~

Wrangler prints the workers.dev address. Open it and complete one-time setup with the secret from step 3.

## 6. Production checks

1. GET /api/health returns ok.
2. GET /api/setup/status changes from configured false to true after setup.
3. Sign out and sign in again.
4. Verify a temporary-password account is taken directly to the mandatory password-change screen and cannot reach financial APIs until the change succeeds.
5. Add a family member, account, expense and income, then edit a pending item to cleared.
6. Verify dashboard totals exclude transfers.
7. Paste a synthetic bank message, review and import it; importing it again must return a duplicate error.
8. Download the administrator household export and confirm it contains no password/session/setup credentials or raw SMS.
9. Verify every analytics chart has a table alternative.
10. Install the PWA from a phone and sign in from standalone mode.

## Optional Cloudflare Access layer

For a private family deployment you can add Cloudflare Access in front of the Worker and allow exact household emails with one-time PIN. Access Free currently supports small teams. This is defense in depth; PennyQuill's own session and household authorization remain enabled. If enforcing Access in code, validate Cf-Access-Jwt-Assertion against the team JWKS, issuer and application audience. Static Assets do not automatically expose Access context to Worker code.

## Free-tier design

- Cloudflare Static Assets for the Vite bundle
- Workers Free for API calls
- D1 Free for household data
- local Lucide SVG components instead of a remote icon service
- deterministic in-Worker forecasting instead of an AI API

Usage above Cloudflare's free limits can be throttled or billed depending on the account plan. Check current Workers and D1 pricing before a wider rollout.

## Backup and recovery

Before a schema change or major import:

~~~powershell
npx wrangler d1 export pennyquill-db --remote --output pennyquill-backup.sql
~~~

Treat the export as sensitive financial data. Encrypt it, restrict access and delete obsolete copies under your retention policy. Test restoration into a separate non-production D1 database.

## Rollback

Worker versions can be rolled back from the Cloudflare dashboard. A code rollback does not reverse D1 migrations. Use additive migrations, back up first, and prepare a tested forward-fix for data changes.
