# PennyQuill

PennyQuill is a mobile-first household expense, income, budget and forecast application built for Cloudflare Workers and D1. It installs from Safari or Chrome as a Progressive Web App and uses one same-origin Worker for the private API and static React interface.

## What is included

- Fast amount-first entry for expenses, income, transfers and refunds
- Cleared, pending and planned transaction states
- Household members with mobile add, edit and history-safe removal, plus accounts, categories, tags and recurring money
- Salary and other income attributed to individual family members
- Category budgets, savings/debt goals and upcoming bills
- Dashboard cash flow, savings rate, category mix and recent activity
- Analytics for 7 days, month, quarter, half-year, year or custom dates
- Drill-down by family member, category, account and merchant
- Previous-period comparison and accessible chart tables
- Deterministic six-month forecast with range, confidence and assumptions
- Bank/SMS paste, preview and human-approval flow with duplicate protection
- Installable PWA shell; authenticated API responses are never cached
- Administrator JSON export that excludes credentials, sessions, raw SMS and import fingerprints
- Mandatory first-login password replacement for managed accounts
- One-time setup secret, salted and secret-peppered PBKDF2 passwords, throttled login attempts, opaque hashed sessions, strict cookies, household-scoped D1 queries and append-only audit logs

## Architecture

~~~text
iPhone / Android / browser
        |
        | HTTPS, same origin
        v
Cloudflare Worker
  |-- React/Vite static assets
  |-- framework-free TypeScript API
  |-- authentication and household authorization
  |-- deterministic analytics/forecasting
        |
        v
Cloudflare D1 (SQLite semantics)
~~~

Amounts are stored as integer minor units. Transfers and adjustments do not inflate income or spending. Refunds reduce spending. Historical analytics use cleared entries; planned and recurring entries inform forecasts.

## Local development

Prerequisites: Node.js 22+, npm, and a Cloudflare account for remote deployment.

~~~powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run icons
npm run build:web
npm run db:migrate:local
npm run dev
~~~

Open http://localhost:5173. Use the APP_SETUP_KEY value in .dev.vars on the one-time setup screen. Vite proxies /api to Wrangler on port 8787.

APP_ORIGIN in the local example permits the two Vite development origins. Production remains same-origin unless you deliberately configure another trusted UI origin.

Useful checks:

~~~powershell
npm run typecheck
npm test
npm run build
npm run preview
~~~

## Deploy

Read [Cloudflare deployment](docs/CLOUDFLARE_DEPLOYMENT.md) for the exact D1, secret, migration and Worker commands. Read [Mobile installation](docs/MOBILE_INSTALLATION.md) for iPhone, iPad, Android, the supported PWA installation path, future native-client prerequisites and the SMS limitations.

The [market feature review](docs/MARKET_RESEARCH.md) records the representative expense products reviewed, the patterns adopted and the features PennyQuill deliberately does not claim.

## Important SMS boundary

An installed web app cannot read the SMS inbox on iOS or Android. On iPhone there is no general third-party Messages inbox API. Android SMS permissions are hard-restricted and Google Play generally limits them to genuine default SMS handlers or narrow approved use cases. PennyQuill therefore ships a safe baseline: paste an alert, preview the extracted fields, edit them, and explicitly approve the transaction. Raw message text is not written to D1.

## Forecasting boundary

The smart forecast does not use AI. It combines weighted historical spending, a bounded linear trend, damped seasonality, recurring/planned commitments and historical variation. The UI shows the method, confidence level, history length and assumptions. See [Forecasting](docs/FORECASTING.md).

## Repository map

- src/ — React mobile UI
- worker/ — Cloudflare Worker API and route contract
- migrations/ — versioned D1 schema
- public/ — manifest, service worker, headers and icons
- docs/ — deployment, mobile and operational guidance
- scripts/generate-icons.mjs — dependency-free PWA icon generator

## License notices

PennyQuill uses Lucide icons. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
