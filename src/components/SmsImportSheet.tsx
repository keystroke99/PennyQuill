import { useState } from "react";
import { CheckCircle2, MessageSquareText, ShieldCheck, Sparkles } from "lucide-react";
import { api, ApiError } from "../api";
import type { Household, ReferenceData, SmsCandidate } from "../types";
import { formatMoney } from "../utils";
import { Button, CategoryGlyph, InlineError, Sheet } from "./Primitives";

export default function SmsImportSheet({
  open,
  onClose,
  onImported,
  references,
  household,
}: {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
  references: ReferenceData;
  household: Household;
}) {
  const [text, setText] = useState("");
  const [candidates, setCandidates] = useState<SmsCandidate[]>([]);
  const [candidate, setCandidate] = useState<SmsCandidate | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [memberId, setMemberId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function preview() {
    setLoading(true);
    setError("");
    try {
      const result = await api.smsPreview(text);
      setCandidates(result.candidates);
      const first = result.candidates[0] ?? null;
      setCandidate(first);
      setCategoryId(first?.categoryId ?? "");
      if (!first) setError("No amount and transaction direction could be recognized. You can still add it manually.");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not parse this message.");
    } finally {
      setLoading(false);
    }
  }

  async function importCandidate() {
    if (!candidate) return;
    setLoading(true);
    setError("");
    try {
      await api.smsImport({
        ...candidate,
        categoryId: categoryId || null,
        memberId: memberId || null,
        accountId: accountId || null,
        reviewed: true,
      });
      setText("");
      setCandidate(null);
      setCandidates([]);
      onImported();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not import this draft.");
    } finally {
      setLoading(false);
    }
  }

  const matchingCategories = references.categories.filter((category) => {
    if (!candidate) return false;
    return category.active && (category.kind === candidate.direction || category.kind === "both");
  });
  const reviewDirection = candidate?.originalDirection ?? candidate?.direction;

  return (
    <Sheet open={open} onClose={onClose} title="Review a bank message" eyebrow="Privacy-first SMS import" wide>
      <div className="privacy-callout">
        <ShieldCheck size={22} />
        <div>
          <strong>Paste only. No inbox permission.</strong>
          <p>iPhone web apps cannot scan Messages. The parser extracts a draft for your approval and does not store the raw message.</p>
        </div>
      </div>

      {!candidate ? (
        <div className="form-stack">
          <label>
            Bank or wallet message
            <textarea
              rows={7}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="Paste a debit or credit alert here…"
              maxLength={2000}
            />
          </label>
          <div className="example-message">
            <MessageSquareText size={18} />
            <span>Works with common “debited”, “spent”, “credited” and “received” wording. Always verify the result.</span>
          </div>
          {error && <InlineError message={error} />}
          <Button type="button" onClick={preview} disabled={loading || text.trim().length < 8}>
            <Sparkles size={18} /> {loading ? "Reading…" : "Create review draft"}
          </Button>
        </div>
      ) : (
        <div className="sms-review">
          <div className="sms-review__hero">
            <span className={`status-pill status-pill--${reviewDirection}`} aria-label={`Transaction direction: ${reviewDirection}`}>
              {reviewDirection === "refund" ? "Refund received" : reviewDirection}
            </span>
            <strong>{formatMoney(candidate.amountMinor, household)}</strong>
            <p>{candidate.merchant || "Merchant not recognized"} · {candidate.occurredOn}</p>
          </div>
          <div className="confidence-card">
            <CheckCircle2 size={20} />
            <div><strong>{Math.round(candidate.confidence * 100)}% parser confidence</strong><p>{candidate.reasons.join(" · ") || "Amount and direction recognized"}</p></div>
          </div>
          <div className="field-row">
            <label>
              Type
              <select value={candidate.originalDirection ?? candidate.direction} onChange={(event) => {
                const value = event.target.value as "expense" | "income" | "refund";
                setCandidate({ ...candidate, direction: value === "refund" ? "expense" : value, originalDirection: value });
                setCategoryId("");
              }}>
                <option value="expense">Expense</option>
                <option value="income">Income</option>
                <option value="refund">Refund</option>
              </select>
            </label>
            <label>
              Amount
              <input type="number" min="0.01" step="0.01" value={candidate.amountMinor / 100} onChange={(event) => setCandidate({ ...candidate, amountMinor: Math.round(Number(event.target.value) * 100) })} />
            </label>
          </div>
          <div className="field-row">
            <label>
              Date
              <input type="date" value={candidate.occurredOn} onChange={(event) => setCandidate({ ...candidate, occurredOn: event.target.value })} />
            </label>
            <label>
              Merchant / source
              <input maxLength={120} value={candidate.merchant ?? ""} onChange={(event) => setCandidate({ ...candidate, merchant: event.target.value || null })} />
            </label>
          </div>
          {candidates.length > 1 && (
            <label>
              Detected transaction
              <select value={candidates.indexOf(candidate)} onChange={(event) => {
                const next = candidates[Number(event.target.value)] ?? candidate;
                setCandidate(next);
                setCategoryId(next.categoryId ?? "");
              }}>
                {candidates.map((item, index) => <option value={index} key={index}>{item.originalDirection ?? item.direction} · {formatMoney(item.amountMinor, household)}</option>)}
              </select>
            </label>
          )}
          <fieldset className="category-picker">
            <legend>Confirm category</legend>
            <div className="category-picker__grid">
              {matchingCategories.map((category) => (
                <button type="button" key={category.id} className={categoryId === category.id ? "is-selected" : ""} onClick={() => setCategoryId(category.id)}>
                  <CategoryGlyph icon={category.icon} color={category.color} />
                  <span>{category.name}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="field-row">
            <label>
              Family member
              <select value={memberId} onChange={(event) => setMemberId(event.target.value)}>
                <option value="">Household</option>
                {references.members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
              </select>
            </label>
            <label>
              Account
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                <option value="">Not specified</option>
                {references.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
            </label>
          </div>
          {error && <InlineError message={error} />}
          <div className="button-row">
            <Button type="button" variant="secondary" onClick={() => setCandidate(null)}>Back</Button>
            <Button type="button" onClick={importCandidate} disabled={loading || !categoryId || candidate.amountMinor <= 0 || !candidate.occurredOn}>{loading ? "Importing…" : "Approve & save"}</Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
