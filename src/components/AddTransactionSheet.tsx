import { useEffect, useMemo, useState } from "react";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, CalendarDays, Check, RotateCcw, SlidersHorizontal } from "lucide-react";
import { api, ApiError } from "../api";
import { CategoryGlyph, InlineError, Sheet, Button } from "./Primitives";
import type { Household, ReferenceData, Transaction, TransactionDirection, TransactionStatus } from "../types";
import { toMinor, todayIso } from "../utils";

const directions: Array<{ value: TransactionDirection; label: string; icon: typeof ArrowUpRight }> = [
  { value: "expense", label: "Expense", icon: ArrowUpRight },
  { value: "income", label: "Income", icon: ArrowDownLeft },
  { value: "transfer", label: "Transfer", icon: ArrowLeftRight },
  { value: "refund", label: "Refund", icon: RotateCcw },
  { value: "adjustment", label: "Adjustment", icon: SlidersHorizontal },
];

function amountText(amountMinor: number) {
  return (amountMinor / 100).toFixed(2).replace(/\.00$/, "");
}

export default function AddTransactionSheet({
  open,
  initialDirection = "expense",
  initialTransaction = null,
  onClose,
  onSaved,
  references,
  household,
}: {
  open: boolean;
  initialDirection?: TransactionDirection;
  initialTransaction?: Transaction | null;
  onClose: () => void;
  onSaved: (transaction: Transaction) => void;
  references: ReferenceData;
  household: Household;
}) {
  const [direction, setDirection] = useState<TransactionDirection>(initialDirection);
  const [amount, setAmount] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [selectedAccount, setSelectedAccount] = useState("");
  const [transferAccountId, setTransferAccountId] = useState("");
  const [memberId, setMemberId] = useState("");
  const [occurredOn, setOccurredOn] = useState("");
  const [status, setStatus] = useState<TransactionStatus>("cleared");
  const [merchant, setMerchant] = useState("");
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setDirection(initialTransaction?.direction ?? initialDirection);
    setAmount(initialTransaction ? amountText(initialTransaction.amountMinor) : "");
    setSelectedCategory(initialTransaction?.categoryId ?? "");
    setSelectedAccount(initialTransaction?.accountId ?? "");
    setTransferAccountId(initialTransaction?.transferAccountId ?? "");
    setMemberId(initialTransaction?.memberId ?? "");
    setOccurredOn(initialTransaction?.occurredOn ?? todayIso(household.timezone));
    setStatus(initialTransaction?.status ?? "cleared");
    setMerchant(initialTransaction?.merchant ?? "");
    setTags(initialTransaction?.tags.join(", ") ?? "");
    setNote(initialTransaction?.note ?? "");
    setError("");
  }, [open, initialDirection, initialTransaction, household.timezone]);

  const categories = useMemo(
    () => references.categories.filter((category) => {
      if ((!category.active && category.id !== selectedCategory) || direction === "transfer" || direction === "adjustment") return false;
      const intended = direction === "refund" ? "expense" : direction;
      return category.kind === intended || category.kind === "both";
    }),
    [direction, references.categories, selectedCategory],
  );

  const requiresCategory = direction !== "transfer" && direction !== "adjustment";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amountMinor = toMinor(amount);
    if (amountMinor <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    if (requiresCategory && !selectedCategory) {
      setError("Choose a category for this transaction.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const payload: Record<string, unknown> = {
        direction,
        amountMinor,
        occurredOn,
        merchant: merchant.trim() || null,
        note: note.trim() || null,
        memberId: memberId || null,
        categoryId: requiresCategory ? selectedCategory : null,
        accountId: selectedAccount || null,
        transferAccountId: direction === "transfer" ? transferAccountId || null : null,
        status,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 10),
      };
      const saved = initialTransaction
        ? await api.updateTransaction(initialTransaction.id, payload)
        : await api.createTransaction({ ...payload, source: "manual", externalRef: null });
      onSaved(saved);
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : `Could not ${initialTransaction ? "update" : "save"} this transaction.`);
    } finally {
      setLoading(false);
    }
  }

  const symbol = new Intl.NumberFormat(household.currency === "INR" ? "en-IN" : "en", {
    style: "currency",
    currency: household.currency,
  }).formatToParts(0).find((part) => part.type === "currency")?.value ?? household.currency;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={initialTransaction ? "Edit transaction" : "Record money"}
      eyebrow={initialTransaction ? "Activity details" : "Quick entry"}
    >
      <form className="transaction-form" onSubmit={submit}>
        <div className="segmented segmented--five" aria-label="Transaction type">
          {directions.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              className={direction === value ? "is-active" : ""}
              aria-pressed={direction === value}
              onClick={() => {
                setDirection(value);
                setSelectedCategory("");
                if (value !== "transfer") setTransferAccountId("");
              }}
            >
              <Icon size={17} />{label}
            </button>
          ))}
        </div>

        <label className="amount-field">
          <span>{symbol}</span>
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            pattern="[0-9.,]*"
            placeholder="0"
            aria-label="Amount"
            autoFocus
            required
          />
          <small>{household.currency}</small>
        </label>

        {requiresCategory && (
          <fieldset className="category-picker">
            <legend>Category</legend>
            <div className="category-picker__grid">
              {categories.map((category) => (
                <button
                  type="button"
                  key={category.id}
                  className={selectedCategory === category.id ? "is-selected" : ""}
                  aria-pressed={selectedCategory === category.id}
                  onClick={() => setSelectedCategory(category.id)}
                >
                  <CategoryGlyph icon={category.icon} color={category.color} />
                  <span>{category.name}</span>
                  {selectedCategory === category.id && <Check size={14} className="category-picker__check" />}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        <div className="field-row">
          <label>
            <span><CalendarDays size={16} /> Date</span>
            <input type="date" value={occurredOn} onChange={(event) => setOccurredOn(event.target.value)} required />
          </label>
          <label>
            Status
            <select value={status} onChange={(event) => setStatus(event.target.value as TransactionStatus)}>
              <option value="cleared">Cleared</option>
              <option value="pending">Pending</option>
              <option value="planned">Planned</option>
            </select>
          </label>
        </div>

        <label>
          {direction === "income" ? "Source / employer" : direction === "transfer" ? "Reference" : direction === "adjustment" ? "Adjustment reason" : "Merchant"}
          <input value={merchant} onChange={(event) => setMerchant(event.target.value)} maxLength={120} placeholder={direction === "income" ? "Employer or client" : direction === "adjustment" ? "Balance correction" : "Where was this?"} />
        </label>

        <div className="field-row">
          <label>
            Family member
            <select value={memberId} onChange={(event) => setMemberId(event.target.value)}>
              <option value="">Household</option>
              {references.members.filter((member) => member.active || member.id === memberId).map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}
            </select>
          </label>
          <label>
            {direction === "transfer" ? "From account" : "Account"}
            <select
              value={selectedAccount}
              onChange={(event) => {
                setSelectedAccount(event.target.value);
                if (event.target.value === transferAccountId) setTransferAccountId("");
              }}
              required={direction === "transfer"}
            >
              <option value="">Not specified</option>
              {references.accounts.filter((account) => account.active || account.id === selectedAccount).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}
            </select>
          </label>
        </div>

        {direction === "transfer" && (
          <label>
            To account
            <select value={transferAccountId} onChange={(event) => setTransferAccountId(event.target.value)} required disabled={!selectedAccount}>
              <option value="">Choose destination</option>
              {references.accounts.filter((account) => (account.active || account.id === transferAccountId) && account.id !== selectedAccount).map((account) => <option value={account.id} key={account.id}>{account.name}</option>)}
            </select>
          </label>
        )}

        <label>
          Tags <span className="label-hint">comma separated</span>
          <input value={tags} onChange={(event) => setTags(event.target.value)} maxLength={180} placeholder="work, reimbursable" />
        </label>
        <label>
          Note
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={500} placeholder="Optional context" />
        </label>
        {error && <InlineError message={error} />}
        <Button type="submit" disabled={loading || (requiresCategory && !selectedCategory)}>
          {loading ? "Saving…" : initialTransaction ? "Update transaction" : "Save transaction"}
        </Button>
      </form>
    </Sheet>
  );
}
