# Expense-product research and PennyQuill scope

Reviewed 29 September 2026. “Every existing expense tracker” is not a finite or verifiable set, so this review uses a representative group of established products and their first-party feature pages. It separates ideas adopted in PennyQuill from features that would require regulated data partners, native clients or a materially larger operating model.

## Representative product patterns

| Product | First-party capabilities reviewed | PennyQuill response |
| --- | --- | --- |
| [YNAB](https://www.ynab.com/features) | Bank import, multi-device sync, household sharing, goals/targets, loan planning, spending and net-worth reports | Household roles, goals, account balances, spending reports and mobile PWA are shipped. Bank aggregation and loan-interest simulation are not claimed. |
| [Monarch Money](https://www.monarchmoney.com/features/recurring) | Search/edit transactions, deep report slicing, recurring calendar, subscriptions, investments/net worth, configurable dashboard and collaboration | Search/edit, recurring items, household attribution, drill-down analytics, account balances and dashboard are shipped. Market-data investments and automatic subscription discovery are not claimed. |
| [Copilot Money](https://www.copilot.money/) | Automatic categorization, budgets/rollovers, cash flow, upcoming bills, subscriptions, investments and net worth | Manual categorization, budget progress, cash flow, recurring/planned items and account balances are shipped. PennyQuill deliberately uses transparent deterministic rules rather than claiming AI categorization. Rollover is rejected by the API until a tested carry-forward model exists. |
| [Rocket Money](https://www.rocketmoney.com/learn/personal-finance/what-is-rocket-money) | Spend tracking, custom budgets, subscription management, bill negotiation, goals, credit monitoring and net worth | Spending, custom categories/budgets, recurring charges, goals and account balances are shipped. Bill negotiation, credit-bureau data, money movement and cancellation concierge are outside the self-hosted scope. |

## Shipped product contract

- Expenses, income, salary, refunds, adjustments and account-to-account transfers stored in integer minor units.
- Cleared, pending and planned lifecycle with editing, deletion and human review.
- Family-member attribution, household-scoped roles, accounts, custom/system categories and tags.
- Category/member budgets, recurring expenses or salaries, goals and current account balances.
- Dashboard and date-range analytics for week, month, quarter, half-year, year and custom windows.
- Drill-down by category, member, account and merchant, plus previous-period comparisons and accessible tables.
- A deterministic future projection using weighted history, bounded trend, damped seasonality, recurring floors, additive planned items and a visible variability range.
- SMS/bank-alert paste, preview, edit, approve and duplicate protection without retaining the raw message.
- Administrator JSON export that excludes passwords, sessions, login-attempt data, setup secrets, raw SMS and import fingerprints.
- Installable mobile-first PWA, local public Lucide icons, strict same-origin authentication and Cloudflare D1 persistence.

## Deliberately not represented as shipped

- Direct bank aggregation, payment initiation or money movement.
- General iOS Messages-inbox access or unrestricted Android SMS access.
- Investment quotes, property estimates, credit reports, bill negotiation or subscription cancellation.
- Budget rollover, automatic transaction splitting, native push alerts, offline financial writes or biometric vault access.
- AI categorization or AI forecasting. Predictions are deterministic and explainable.

These boundaries prevent a simple self-hosted finance tracker from implying access, automation or regulatory coverage it does not have. They also provide a concrete backlog if PennyQuill later gains native clients or approved financial-data providers.
