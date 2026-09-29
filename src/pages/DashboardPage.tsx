import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  Eye,
  EyeOff,
  MessageSquareText,
  Plus,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { api, ApiError } from "../api";
import { Button, CategoryGlyph, EmptyState, InlineError, Skeleton, TransactionRow } from "../components/Primitives";
import type { AuthSession, DashboardData, Household, TransactionDirection, TrendPoint } from "../types";
import { formatDate, formatMoney, percent, periodRange } from "../utils";

function MiniCashflowChart({ points, household }: { points: TrendPoint[]; household: Household }) {
  const width = 620;
  const height = 220;
  const top = 12;
  const bottom = 31;
  const plotHeight = height - top - bottom;
  const max = Math.max(1, ...points.flatMap((point) => [point.incomeMinor, point.expenseMinor]));
  const x = (index: number) => points.length === 1 ? width / 2 : 12 + (index / (points.length - 1)) * (width - 24);
  const y = (value: number) => top + (1 - value / max) * plotHeight;
  const line = (key: "incomeMinor" | "expenseMinor") => points.map((point, index) => `${x(index)},${y(point[key])}`).join(" ");
  const expenseArea = `M ${x(0)} ${height - bottom} L ${points.map((point, index) => `${x(index)} ${y(point.expenseMinor)}`).join(" L ")} L ${x(points.length - 1)} ${height - bottom} Z`;
  const labelIndexes = Array.from(new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]));
  return (
    <div className="chart chart--dashboard" aria-label="Income and expense trend chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="cashflow-chart-title cashflow-chart-description">
        <title id="cashflow-chart-title">Income and spending for the current month</title>
        <desc id="cashflow-chart-description">A visual trend. Open Analytics for the exact values in an accessible table.</desc>
        {[0, 0.5, 1].map((ratio) => <line key={ratio} x1="12" x2={width - 12} y1={top + plotHeight * ratio} y2={top + plotHeight * ratio} className="mini-chart__grid" />)}
        <path d={expenseArea} className="mini-chart__area" />
        <polyline points={line("expenseMinor")} className="mini-chart__expense" />
        <polyline points={line("incomeMinor")} className="mini-chart__income" />
        {labelIndexes.map((index) => <text key={index} x={x(index)} y={height - 8} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}>{points[index]?.label}</text>)}
        <text x={width - 12} y={top + 9} textAnchor="end" className="mini-chart__max">{formatMoney(max, household, true)}</text>
      </svg>
    </div>
  );
}

export default function DashboardPage({
  session,
  refreshKey,
  onAdd,
  onImport,
  onAnalytics,
  onSettings,
}: {
  session: AuthSession;
  refreshKey: number;
  onAdd: (direction?: TransactionDirection) => void;
  onImport: () => void;
  onAnalytics: () => void;
  onSettings: () => void;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showMoney, setShowMoney] = useState(true);
  const range = useMemo(() => periodRange("month", new Date(), session.household.timezone), [session.household.timezone]);

  useEffect(() => {
    setLoading(true);
    api.dashboard(range.from, range.to)
      .then(setData)
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : "Dashboard could not be loaded."))
      .finally(() => setLoading(false));
  }, [range.from, range.to, refreshKey]);

  if (loading && !data) return <div className="page"><Skeleton rows={6} /></div>;

  const summary = data?.summary ?? { incomeMinor: 0, expenseMinor: 0, netMinor: 0, savingsRate: null };
  const money = (value: number, compact = false) => showMoney ? formatMoney(value, session.household, compact) : "••••••";
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="page dashboard-page">
      <header className="mobile-page-header">
        <div>
          <p>{greeting},</p>
          <h1>{session.user.displayName.split(" ")[0]}</h1>
        </div>
        <button className="avatar-button" onClick={onSettings} aria-label="Open settings and your profile">{session.user.displayName.charAt(0).toUpperCase()}</button>
      </header>

      {error && <InlineError message={error} />}

      <section className="balance-card">
        <div className="balance-card__top">
          <div>
            <span>This month’s balance</span>
            <strong>{money(summary.netMinor)}</strong>
          </div>
          <button className="icon-button icon-button--dark" onClick={() => setShowMoney((value) => !value)} aria-label={showMoney ? "Hide balances" : "Show balances"}>
            {showMoney ? <Eye size={19} /> : <EyeOff size={19} />}
          </button>
        </div>
        <div className="balance-card__metrics">
          <div><span className="metric-icon metric-icon--income"><ArrowDownLeft size={17} /></span><p>Income<strong>{money(summary.incomeMinor)}</strong></p></div>
          <div><span className="metric-icon metric-icon--expense"><ArrowUpRight size={17} /></span><p>Spent<strong>{money(summary.expenseMinor)}</strong></p></div>
          <div><span className="metric-icon metric-icon--saving"><TrendingUp size={17} /></span><p>Saved<strong>{percent(summary.savingsRate)}</strong></p></div>
        </div>
        <div className="balance-card__actions">
          <button onClick={() => onAdd("expense")}><Plus size={18} /> Add expense</button>
          <button onClick={() => onAdd("income")}><ArrowDownLeft size={18} /> Add income</button>
          <button onClick={onImport}><MessageSquareText size={18} /> Import SMS</button>
        </div>
      </section>

      <section className="insight-strip">
        <span className={summary.netMinor >= 0 ? "is-good" : "is-warning"}>
          {summary.netMinor >= 0 ? <TrendingUp size={20} /> : <TrendingDown size={20} />}
        </span>
        <div>
          <strong>{summary.netMinor >= 0 ? "You’re keeping more than you spend" : "Spending is ahead of income"}</strong>
          <p>{summary.netMinor >= 0 ? `${percent(summary.savingsRate)} savings rate so far this month.` : "Open analytics to see which categories changed."}</p>
        </div>
        <button onClick={onAnalytics} aria-label="Open analytics"><ArrowRight size={20} /></button>
      </section>

      <div className="dashboard-grid">
        <section className="panel cashflow-panel">
          <div className="section-heading">
            <div><p className="eyebrow">Cash flow</p><h2>Daily pulse</h2></div>
            <button className="text-button" onClick={onAnalytics}>Deep dive <ArrowRight size={15} /></button>
          </div>
          {(data?.trend?.length ?? 0) > 0 ? (
            <>
              <MiniCashflowChart points={data?.trend ?? []} household={session.household} />
              <div className="chart-legend"><span className="legend-income">Income</span><span className="legend-expense">Spent</span></div>
              <details className="accessible-data">
                <summary>View chart as table</summary>
                <div className="table-scroll"><table><thead><tr><th>Period</th><th>Income</th><th>Spent</th></tr></thead><tbody>
                  {(data?.trend ?? []).map((point) => <tr key={point.date}><td>{point.label}</td><td>{formatMoney(point.incomeMinor, session.household)}</td><td>{formatMoney(point.expenseMinor, session.household)}</td></tr>)}
                </tbody></table></div>
              </details>
            </>
          ) : (
            <EmptyState title="Your chart starts here" message="Record the first expense or income to see your daily cash-flow pulse." action={<Button onClick={() => onAdd("expense")}>Add first entry</Button>} />
          )}
        </section>

        <section className="panel category-panel">
          <div className="section-heading">
            <div><p className="eyebrow">Where it went</p><h2>Top categories</h2></div>
            <button className="text-button" onClick={onAnalytics}>All <ArrowRight size={15} /></button>
          </div>
          <div className="category-list">
            {(data?.categoryBreakdown ?? []).slice(0, 5).map((category) => (
              <button key={category.id} className="category-line" onClick={onAnalytics}>
                <CategoryGlyph icon={category.icon} color={category.color} />
                <span><strong>{category.name}</strong><small>{category.transactionCount} entries · {Math.round(category.percentage)}%</small></span>
                <span className="category-line__amount">{money(category.amountMinor)}</span>
              </button>
            ))}
            {!data?.categoryBreakdown?.length && <p className="panel-placeholder">No cleared expenses in this period.</p>}
          </div>
        </section>
      </div>

      <div className="dashboard-grid dashboard-grid--lower">
        <section className="panel recent-panel">
          <div className="section-heading">
            <div><p className="eyebrow">Ledger</p><h2>Recent activity</h2></div>
          </div>
          <div className="transaction-list">
            {(data?.recentTransactions ?? []).slice(0, 6).map((transaction) => (
              <TransactionRow key={transaction.id} transaction={transaction} household={session.household} />
            ))}
            {!data?.recentTransactions?.length && <p className="panel-placeholder">Nothing recorded yet.</p>}
          </div>
        </section>

        <section className="panel upcoming-panel">
          <div className="section-heading">
            <div><p className="eyebrow">Next up</p><h2>Planned money</h2></div>
            <CalendarClock size={21} />
          </div>
          <div className="upcoming-list">
            {(data?.upcomingRecurring ?? []).slice(0, 5).map((item) => (
              <div className="upcoming-row" key={item.id}>
                <span className={`metric-icon metric-icon--${item.direction}`}>{item.direction === "income" ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}</span>
                <span><strong>{item.name}</strong><small>{formatDate(item.nextDueOn, "short")} · {item.cadence}</small></span>
                <strong className={item.direction === "income" ? "is-positive" : ""}>{item.direction === "income" ? "+" : "−"}{money(item.amountMinor)}</strong>
              </div>
            ))}
            {!data?.upcomingRecurring?.length && <p className="panel-placeholder">Add salary, bills or subscriptions in Plan.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
