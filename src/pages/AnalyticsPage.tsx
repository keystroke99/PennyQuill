import { useEffect, useMemo, useState } from "react";
import { ArrowDownRight, ArrowUpRight, CalendarRange, ChevronDown, Info, SlidersHorizontal, Sparkles } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api, ApiError } from "../api";
import { CategoryGlyph, EmptyState, InlineError, Sheet, Skeleton } from "../components/Primitives";
import type { AnalyticsData, AuthSession, BreakdownItem, ForecastData, ReferenceData } from "../types";
import { formatMoney, percent, periodRange, type PeriodKey } from "../utils";

const periodOptions: Array<{ key: PeriodKey; label: string }> = [
  { key: "7d", label: "7 days" },
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
  { key: "half", label: "6 months" },
  { key: "year", label: "Year" },
  { key: "custom", label: "Custom" },
];

export default function AnalyticsPage({
  session,
  references,
  refreshKey,
}: {
  session: AuthSession;
  references: ReferenceData;
  refreshKey: number;
}) {
  const [period, setPeriod] = useState<PeriodKey>("month");
  const initialRange = useMemo(() => periodRange("month", new Date(), session.household.timezone), [session.household.timezone]);
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [memberId, setMemberId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [merchant, setMerchant] = useState("");
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [forecast, setForecast] = useState<ForecastData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"categories" | "family" | "merchants">("categories");
  const [explainOpen, setExplainOpen] = useState(false);

  useEffect(() => {
    if (period === "custom") return;
    const range = periodRange(period, new Date(), session.household.timezone);
    setFrom(range.from);
    setTo(range.to);
  }, [period, session.household.timezone]);

  useEffect(() => {
    setLoading(true);
    setError("");
    const daySpan = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));
    const granularity = daySpan <= 45 ? "day" : daySpan <= 370 ? "month" : "quarter";
    Promise.all([
      api.analytics({ from, to, granularity, memberId, categoryId, accountId, merchant }),
      api.forecast({ months: 6, memberId, categoryId, accountId, merchant }),
    ])
      .then(([analytics, predicted]) => {
        setData(analytics);
        setForecast(predicted);
      })
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : "Analytics could not be loaded."))
      .finally(() => setLoading(false));
  }, [from, to, memberId, categoryId, accountId, merchant, refreshKey]);

  const breakdown: BreakdownItem[] = tab === "categories"
    ? data?.categories ?? []
    : tab === "family"
      ? data?.members ?? []
      : data?.merchants ?? [];
  const colors = ["#385b45", "#e7833c", "#7d8e4b", "#d3a44d", "#6d7f9f", "#b66a61", "#8a6ca8"];
  const visibleBreakdown = breakdown.slice(0, 7);
  const visibleBreakdownTotal = visibleBreakdown.reduce((sum, item) => sum + item.amountMinor, 0);
  const forecastSeries = (forecast?.months ?? []).map((month) => ({
    ...month,
    expenseRange: [month.lowerExpenseMinor, month.upperExpenseMinor],
  }));

  return (
    <div className="page">
      <header className="page-title">
        <div><p className="eyebrow">Past, present & next</p><h1>Analytics</h1><p>Every prediction shows its assumptions. No AI or black box.</p></div>
        <span className="smart-badge"><Sparkles size={16} /> Explainable forecast</span>
      </header>

      <div className="period-scroller" role="tablist" aria-label="Analytics period">
        {periodOptions.map((option) => (
          <button key={option.key} role="tab" aria-selected={period === option.key} className={period === option.key ? "is-active" : ""} onClick={() => setPeriod(option.key)}>
            {option.label}
          </button>
        ))}
      </div>

      {period === "custom" && (
        <section className="custom-range">
          <CalendarRange size={20} />
          <label>From<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>To<input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
        </section>
      )}

      <section className="analytics-filters">
        <SlidersHorizontal size={18} />
        <select value={memberId} onChange={(event) => setMemberId(event.target.value)} aria-label="Filter family member">
          <option value="">All family</option>
          {references.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select>
        <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} aria-label="Filter category">
          <option value="">All categories</option>
          {references.categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
        <select value={accountId} onChange={(event) => setAccountId(event.target.value)} aria-label="Filter account">
          <option value="">All accounts</option>
          {references.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
        </select>
        {merchant && <button className="filter-chip" onClick={() => setMerchant("")} aria-label={`Clear merchant filter ${merchant}`}>Merchant: {merchant} ×</button>}
      </section>

      {error && <InlineError message={error} />}
      {loading && !data ? <Skeleton rows={7} /> : (
        <>
          <section className="analytics-metrics">
            <article><span>Income</span><strong className="is-positive">{formatMoney(data?.summary.incomeMinor ?? 0, session.household)}</strong><small><ArrowUpRight size={14} /> cleared entries</small></article>
            <article><span>Spent</span><strong>{formatMoney(data?.summary.expenseMinor ?? 0, session.household)}</strong><small><ArrowDownRight size={14} /> refunds removed</small></article>
            <article><span>Net saved</span><strong>{formatMoney(data?.summary.netMinor ?? 0, session.household)}</strong><small>{percent(data?.summary.savingsRate)} savings rate</small></article>
            <article><span>Vs prior period</span><strong>{percent(data?.comparison?.changePercent)}</strong><small>equal-length comparison</small></article>
          </section>

          <section className="panel analytics-chart-panel">
            <div className="section-heading">
              <div><p className="eyebrow">Actual cash flow</p><h2>Income against spending</h2></div>
              <span className="data-freshness">Cleared entries</span>
            </div>
            {(data?.series?.length ?? 0) ? (
              <>
                <div className="chart chart--analytics" aria-label="Cash flow by selected period">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data?.series} margin={{ top: 14, right: 4, bottom: 0, left: -18 }}>
                      <CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#e5e1d8" />
                      <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: "#626b64", fontSize: 11 }} />
                      <YAxis axisLine={false} tickLine={false} tickFormatter={(value) => formatMoney(Number(value), session.household, true)} tick={{ fill: "#626b64", fontSize: 10 }} />
                      <Tooltip formatter={(value) => formatMoney(Number(value), session.household)} contentStyle={{ borderRadius: 14, borderColor: "#e5e1d8" }} />
                      <Bar dataKey="incomeMinor" name="Income" fill="#385b45" radius={[5, 5, 0, 0]} />
                      <Bar dataKey="expenseMinor" name="Spent" fill="#f3a95f" radius={[5, 5, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <details className="accessible-data">
                  <summary>View chart as table <ChevronDown size={16} /></summary>
                  <div className="table-scroll"><table><thead><tr><th>Period</th><th>Income</th><th>Spent</th></tr></thead><tbody>
                    {data?.series.map((point) => <tr key={point.date}><td>{point.label}</td><td>{formatMoney(point.incomeMinor, session.household)}</td><td>{formatMoney(point.expenseMinor, session.household)}</td></tr>)}
                  </tbody></table></div>
                </details>
              </>
            ) : <EmptyState title="Not enough activity" message="This view will build as cleared transactions are recorded." />}
          </section>

          <div className="analytics-grid">
            <section className="panel breakdown-panel">
              <div className="section-heading"><div><p className="eyebrow">Drill down</p><h2>Spending composition</h2></div></div>
              <div className="mini-tabs">
                <button className={tab === "categories" ? "is-active" : ""} onClick={() => setTab("categories")}>Category</button>
                <button className={tab === "family" ? "is-active" : ""} onClick={() => setTab("family")}>Family</button>
                <button className={tab === "merchants" ? "is-active" : ""} onClick={() => setTab("merchants")}>Merchant</button>
              </div>
              <div className="breakdown-layout">
                <div className="donut-chart" aria-hidden="true">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={visibleBreakdown} dataKey="amountMinor" nameKey="name" innerRadius="58%" outerRadius="90%" paddingAngle={2}>
                        {visibleBreakdown.map((item, index) => <Cell key={item.id} fill={item.color || colors[index % colors.length]} />)}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  <span><strong>{formatMoney(visibleBreakdownTotal, session.household, true)}</strong><small>shown</small></span>
                </div>
                <div className="breakdown-list">
                  {breakdown.slice(0, 8).map((item, index) => (
                    <button key={item.id} onClick={() => {
                      if (tab === "categories") setCategoryId(item.id);
                      if (tab === "family" && item.id !== "unassigned") setMemberId(item.id);
                      if (tab === "merchants") setMerchant(item.name);
                    }}>
                      <CategoryGlyph icon={item.icon} color={item.color || colors[index % colors.length]} size="sm" />
                      <span><strong>{item.name}</strong><small>{item.transactionCount} entries</small></span>
                      <span><strong>{formatMoney(item.amountMinor, session.household)}</strong><small>{Math.round(item.percentage)}%</small></span>
                    </button>
                  ))}
                  {!breakdown.length && <p className="panel-placeholder">No spending breakdown for these filters.</p>}
                </div>
              </div>
            </section>

            <section className="panel essential-panel">
              <div className="section-heading"><div><p className="eyebrow">Lifestyle mix</p><h2>Needs vs choices</h2></div></div>
              {(data?.essentialVsDiscretionary ?? []).map((item) => (
                <div className="classification-row" key={item.id}>
                  <span><strong>{item.name}</strong><small>{formatMoney(item.amountMinor, session.household)}</small></span>
                  <div><i style={{ width: `${Math.min(100, item.percentage)}%` }} /></div>
                  <strong>{Math.round(item.percentage)}%</strong>
                </div>
              ))}
              {!data?.essentialVsDiscretionary?.length && <p className="panel-placeholder">Categories are marked essential or discretionary during setup.</p>}
            </section>
          </div>

          <section className="panel forecast-panel">
            <div className="section-heading">
              <div><p className="eyebrow">Next 6 months</p><h2>Smart forecast</h2></div>
              <button className="how-button" onClick={() => setExplainOpen(true)}><Info size={16} /> How calculated</button>
            </div>
            <div className="forecast-meta">
              <span className={`confidence confidence--${forecast?.confidence ?? "low"}`}>{forecast?.confidence ?? "low"} confidence</span>
              <span>{forecast?.historyMonths ?? 0} months of history</span>
              <span>Recurring commitments included</span>
            </div>
            {(forecast?.months?.length ?? 0) ? (
              <>
                <div className="chart chart--forecast" aria-label="Six month expense prediction with confidence range">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={forecastSeries} margin={{ top: 15, right: 8, left: -14, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 5" vertical={false} stroke="#e5e1d8" />
                      <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: "#626b64", fontSize: 11 }} />
                      <YAxis axisLine={false} tickLine={false} tickFormatter={(value) => formatMoney(Number(value), session.household, true)} tick={{ fill: "#626b64", fontSize: 10 }} />
                      <Tooltip formatter={(value, name) => Array.isArray(value) ? [`${formatMoney(Number(value[0]), session.household)} – ${formatMoney(Number(value[1]), session.household)}`, name] : [formatMoney(Number(value), session.household), name]} contentStyle={{ borderRadius: 14, borderColor: "#e5e1d8" }} />
                      <Area dataKey="expenseRange" stroke="transparent" fill="#f3a95f" fillOpacity={0.12} name="Expected range" />
                      <Area dataKey="expenseMinor" stroke="#e7833c" strokeWidth={2.4} fill="#f3a95f" fillOpacity={0.2} name="Expected spend" />
                      <Area dataKey="incomeMinor" stroke="#385b45" strokeWidth={2.2} fill="transparent" name="Expected income" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <details className="accessible-data">
                  <summary>View forecast as table</summary>
                  <div className="table-scroll"><table><thead><tr><th>Month</th><th>Income</th><th>Expected spend</th><th>Spend range</th><th>Net</th></tr></thead><tbody>
                    {forecast?.months.map((month) => <tr key={month.month}><td>{month.month}</td><td>{formatMoney(month.incomeMinor, session.household)}</td><td>{formatMoney(month.expenseMinor, session.household)}</td><td>{formatMoney(month.lowerExpenseMinor, session.household)} – {formatMoney(month.upperExpenseMinor, session.household)}</td><td>{formatMoney(month.netMinor, session.household)}</td></tr>)}
                  </tbody></table></div>
                </details>
                <div className="forecast-cards">
                  {forecast?.months.slice(0, 3).map((month) => (
                    <article key={month.month}><span>{month.month}</span><strong>{formatMoney(month.netMinor, session.household)}</strong><small>predicted net</small></article>
                  ))}
                </div>
              </>
            ) : (
              <EmptyState title="Forecast needs history" message="Add recurring income and expenses now. Confidence improves after three completed months." />
            )}
          </section>
        </>
      )}

      <Sheet open={explainOpen} onClose={() => setExplainOpen(false)} title="How this forecast works" eyebrow="Transparent, not AI">
        <div className="methodology">
          <span className="methodology__icon"><Sparkles size={24} /></span>
          <p>{forecast?.methodology || "A deterministic forecast combines recent cleared spending, recurring commitments and a robust trend. It never sends data to an AI model."}</p>
          <h3>Current assumptions</h3>
          <ul>{(forecast?.assumptions ?? ["Cleared transactions only", "Transfers and adjustments excluded", "Refunds reduce spending"]).map((item) => <li key={item}>{item}</li>)}</ul>
          <p className="fine-print">The range reflects variation in your historical data. Forecasts are estimates for planning, not financial advice.</p>
        </div>
      </Sheet>
    </div>
  );
}
