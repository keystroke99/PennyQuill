# Explainable forecasting

PennyQuill intentionally provides AI-like planning without an AI model, external inference API or opaque recommendation engine.

## Inputs

- cleared historical expense, income and refund transactions;
- user-confirmed planned transactions;
- active recurring salary, other income, bills and subscriptions;
- selected household, member, category and account dimensions;
- data availability and historical volatility.

Transfers and balance adjustments are excluded. Refunds reduce expense totals. Pending activity is visible in the ledger but is not historical actual spend.

## Method

The Worker:

1. Aggregates the configured history window into calendar months.
2. Calculates a recency-weighted baseline, giving recent completed months more influence.
3. Fits a bounded linear trend so one unusual period cannot produce an unlimited slope.
4. Applies damped calendar seasonality only where enough observations exist.
5. Adds confirmed planned and recurring commitments in their due months.
6. Builds lower/upper expense bounds from historical residual variation.
7. Produces expected income, expense and net for each future month.

The API returns a method version, history count, confidence, assumptions and each month's committed component. The UI displays these beside the chart.

## Confidence

- **Low** — sparse history or high variation; treat as an early directional guide.
- **Medium** — several completed periods with moderate variation.
- **High** — sufficient consistent history plus confirmed recurring commitments.

Confidence is about data stability, not a guarantee. Forecasts are planning estimates, not financial advice.

## Backtesting roadmap

For production evolution, store each monthly forecast version without changing the original baseline. At month close, compare expected versus cleared actuals using mean absolute percentage error where the denominator is safe, and absolute error otherwise. Display error history and lower confidence when recent accuracy deteriorates.

## Honest edge cases

- With no history, show recurring/planned commitments and say history is insufficient.
- With one exceptional month, robust bounds and capped trend limit overreaction.
- Seasonal factors should require at least two observations for the same calendar period.
- An income delay or one-off purchase belongs in an explicit scenario; it should not silently rewrite the baseline.
