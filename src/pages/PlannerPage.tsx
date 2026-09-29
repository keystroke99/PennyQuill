import { useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, CalendarClock, Check, Flag, Plus, Repeat2, Target } from "lucide-react";
import { api, ApiError } from "../api";
import { Button, Donut, EmptyState, InlineError, Sheet, Skeleton } from "../components/Primitives";
import type { AuthSession, Budget, Goal, RecurringRule, ReferenceData } from "../types";
import { apiItems, formatDate, formatMoney, toMinor, todayIso } from "../utils";

type PlanTab = "budgets" | "recurring" | "goals";

export default function PlannerPage({
  session,
  references,
  refreshKey,
  onChanged,
}: {
  session: AuthSession;
  references: ReferenceData;
  refreshKey: number;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<PlanTab>("budgets");
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [recurring, setRecurring] = useState<RecurringRule[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recurringDirection, setRecurringDirection] = useState<"expense" | "income">("expense");

  useEffect(() => {
    setLoading(true);
    Promise.all([api.budgets(), api.recurring(), api.goals()])
      .then(([budgetData, recurringData, goalData]) => {
        setBudgets(apiItems(budgetData));
        setRecurring(apiItems(recurringData));
        setGoals(apiItems(goalData));
      })
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : "Planning data could not be loaded."))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      if (tab === "budgets") {
        const created = await api.createBudget({
          name: String(form.get("name")),
          amountMinor: toMinor(String(form.get("amount"))),
          categoryId: String(form.get("categoryId") || "") || null,
          memberId: String(form.get("memberId") || "") || null,
          period: String(form.get("period")),
          startsOn: String(form.get("startsOn")),
          endsOn: null,
          rollover: form.get("rollover") === "on",
        });
        setBudgets((current) => [created, ...current]);
      } else if (tab === "recurring") {
        const created = await api.createRecurring({
          name: String(form.get("name")),
          direction: String(form.get("direction")),
          amountMinor: toMinor(String(form.get("amount"))),
          memberId: String(form.get("memberId") || "") || null,
          categoryId: String(form.get("categoryId") || "") || null,
          accountId: String(form.get("accountId") || "") || null,
          merchant: String(form.get("merchant") || "") || null,
          note: null,
          cadence: String(form.get("cadence")),
          intervalCount: 1,
          nextDueOn: String(form.get("nextDueOn")),
          endsOn: null,
          autoPost: false,
        });
        setRecurring((current) => [created, ...current]);
      } else {
        const created = await api.createGoal({
          name: String(form.get("name")),
          goalType: String(form.get("goalType")),
          targetMinor: toMinor(String(form.get("target"))),
          currentMinor: toMinor(String(form.get("current") || "0")),
          targetDate: String(form.get("targetDate") || "") || null,
          memberId: String(form.get("memberId") || "") || null,
          icon: "goal",
          color: "#385B45",
        });
        setGoals((current) => [created, ...current]);
      }
      setAddOpen(false);
      onChanged();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save this plan.");
    } finally {
      setSaving(false);
    }
  }

  const labels = { budgets: "budget", recurring: "recurring item", goals: "goal" };

  return (
    <div className="page">
      <header className="page-title">
        <div><p className="eyebrow">Turn intentions into a system</p><h1>Plan</h1><p>Budgets, salary, bills and goals in one calendar.</p></div>
        <Button onClick={() => setAddOpen(true)}><Plus size={18} /> Add {labels[tab]}</Button>
      </header>

      <div className="planner-tabs">
        <button aria-label="Budgets — set guardrails" className={tab === "budgets" ? "is-active" : ""} onClick={() => setTab("budgets")}><Flag size={19} /><span>Budgets<small>Set guardrails</small></span></button>
        <button aria-label="Recurring income and bills" className={tab === "recurring" ? "is-active" : ""} onClick={() => setTab("recurring")}><Repeat2 size={19} /><span>Recurring<small>Income & bills</small></span></button>
        <button aria-label="Savings and debt goals" className={tab === "goals" ? "is-active" : ""} onClick={() => setTab("goals")}><Target size={19} /><span>Goals<small>Save with purpose</small></span></button>
      </div>

      {error && <InlineError message={error} />}
      {loading ? <Skeleton rows={5} /> : (
        <section className="plan-grid">
          {tab === "budgets" && budgets.map((budget) => {
            const used = budget.amountMinor ? ((budget.spentMinor ?? 0) / budget.amountMinor) * 100 : 0;
            return (
              <article className="plan-card" key={budget.id}>
                <div className="plan-card__top"><span className="plan-icon"><Flag size={20} /></span><span className="status-pill">{budget.period.replace("_", " ")}</span></div>
                <h3>{budget.name}</h3>
                <p>{formatMoney(budget.spentMinor ?? 0, session.household)} of {formatMoney(budget.amountMinor, session.household)}</p>
                <div className="progress"><i style={{ width: `${Math.min(100, used)}%` }} /></div>
                <footer><span>{Math.round(used)}% used</span><strong>{formatMoney(Math.max(0, budget.amountMinor - (budget.spentMinor ?? 0)), session.household)} left</strong></footer>
              </article>
            );
          })}
          {tab === "recurring" && recurring.map((item) => (
            <article className="plan-card recurring-card" key={item.id}>
              <div className="plan-card__top">
                <span className={`plan-icon plan-icon--${item.direction}`}>{item.direction === "income" ? <ArrowDownLeft size={20} /> : <ArrowUpRight size={20} />}</span>
                <span className="status-pill">{item.cadence}</span>
              </div>
              <h3>{item.name}</h3>
              <strong className={item.direction === "income" ? "is-positive" : ""}>{item.direction === "income" ? "+" : "−"}{formatMoney(item.amountMinor, session.household)}</strong>
              <footer><span><CalendarClock size={14} /> Next {formatDate(item.nextDueOn, "short")}</span><span>{item.autoPost ? "Auto post" : "Review first"}</span></footer>
            </article>
          ))}
          {tab === "goals" && goals.map((goal) => {
            const progress = goal.targetMinor ? (goal.currentMinor / goal.targetMinor) * 100 : 0;
            return (
              <article className="plan-card goal-card" key={goal.id}>
                <Donut value={progress} label="funded" color={goal.color} />
                <div><span className="status-pill">{goal.goalType.replace("_", " ")}</span><h3>{goal.name}</h3><p>{formatMoney(goal.currentMinor, session.household)} of {formatMoney(goal.targetMinor, session.household)}</p>{goal.targetDate && <small>Target {formatDate(goal.targetDate, "short")}</small>}</div>
              </article>
            );
          })}
          {((tab === "budgets" && !budgets.length) || (tab === "recurring" && !recurring.length) || (tab === "goals" && !goals.length)) && (
            <EmptyState
              title={tab === "budgets" ? "Create your first guardrail" : tab === "recurring" ? "Teach the forecast what repeats" : "Name what you’re saving for"}
              message={tab === "budgets" ? "A monthly category budget makes overspending visible early." : tab === "recurring" ? "Add salary, rent, subscriptions or any repeating income and expense." : "Track an emergency fund, purchase or debt payoff."}
              action={<Button onClick={() => setAddOpen(true)}>Add {labels[tab]}</Button>}
            />
          )}
        </section>
      )}

      <Sheet open={addOpen} onClose={() => setAddOpen(false)} title={`New ${labels[tab]}`} eyebrow="Planning">
        <form className="form-stack" onSubmit={save}>
          <label>Name<input name="name" required maxLength={100} placeholder={tab === "budgets" ? "Groceries" : tab === "recurring" ? "Monthly salary" : "Emergency fund"} /></label>
          {tab === "budgets" && (
            <>
              <label>Limit<input name="amount" required inputMode="decimal" placeholder="25000" /></label>
              <div className="field-row">
                <label>Period<select name="period" defaultValue="monthly"><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="half_yearly">Half-yearly</option><option value="yearly">Yearly</option></select></label>
                <label>Starts<input name="startsOn" type="date" defaultValue={todayIso(session.household.timezone)} required /></label>
              </div>
              <label>Category<select name="categoryId"><option value="">Whole household</option>{references.categories.filter((item) => item.kind !== "income").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            </>
          )}
          {tab === "recurring" && (
            <>
              <div className="field-row"><label>Type<select name="direction" value={recurringDirection} onChange={(event) => setRecurringDirection(event.target.value as "expense" | "income")}><option value="expense">Expense / bill</option><option value="income">Income / salary</option></select></label><label>Amount<input name="amount" required inputMode="decimal" placeholder="0.00" /></label></div>
              <div className="field-row"><label>Repeats<select name="cadence" defaultValue="monthly"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="half_yearly">Half-yearly</option><option value="yearly">Yearly</option></select></label><label>Next date<input name="nextDueOn" type="date" defaultValue={todayIso(session.household.timezone)} required /></label></div>
              <label>Category<select name="categoryId"><option value="">Choose later</option>{references.categories.filter((item) => item.kind === recurringDirection || item.kind === "both").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label>Account<select name="accountId"><option value="">Not specified</option>{references.accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label>Employer / merchant<input name="merchant" maxLength={120} /></label>
            </>
          )}
          {tab === "goals" && (
            <>
              <div className="field-row"><label>Target amount<input name="target" required inputMode="decimal" placeholder="100000" /></label><label>Already saved<input name="current" inputMode="decimal" placeholder="0" /></label></div>
              <label>Goal type<select name="goalType" defaultValue="savings"><option value="savings">Savings</option><option value="emergency_fund">Emergency fund</option><option value="purchase">Purchase</option><option value="debt_payoff">Debt payoff</option><option value="other">Other</option></select></label>
              <label>Target date<input name="targetDate" type="date" /></label>
            </>
          )}
          <label>Family member<select name="memberId"><option value="">Whole household</option>{references.members.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : <><Check size={17} /> Save {labels[tab]}</>}</Button>
        </form>
      </Sheet>
    </div>
  );
}
