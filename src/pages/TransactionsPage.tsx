import { useEffect, useState } from "react";
import { Filter, MessageSquareText, Plus, Search, Trash2 } from "lucide-react";
import { api, ApiError } from "../api";
import AddTransactionSheet from "../components/AddTransactionSheet";
import { Button, EmptyState, InlineError, Skeleton, TransactionRow } from "../components/Primitives";
import type { AuthSession, ReferenceData, Transaction, TransactionDirection } from "../types";

export default function TransactionsPage({
  session,
  references,
  refreshKey,
  onAdd,
  onImport,
}: {
  session: AuthSession;
  references: ReferenceData;
  refreshKey: number;
  onAdd: (direction?: TransactionDirection) => void;
  onImport: () => void;
}) {
  const [items, setItems] = useState<Transaction[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [direction, setDirection] = useState("");
  const [memberId, setMemberId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [localRefreshKey, setLocalRefreshKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError("");
    api.transactions({ page, pageSize: 25, search, direction, memberId, categoryId })
      .then((result) => {
        setItems(result.items);
        setTotalPages(result.totalPages || Math.max(1, Math.ceil(result.total / result.pageSize)));
      })
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : "Transactions could not be loaded."))
      .finally(() => setLoading(false));
  }, [page, search, direction, memberId, categoryId, refreshKey, localRefreshKey]);

  async function remove(transaction: Transaction) {
    if (!window.confirm(`Delete ${transaction.merchant || transaction.categoryName || "this transaction"}? This action is recorded in the audit log.`)) return;
    try {
      await api.deleteTransaction(transaction.id);
      setItems((current) => current.filter((item) => item.id !== transaction.id));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not delete this transaction.");
    }
  }

  return (
    <div className="page">
      <header className="page-title">
        <div><p className="eyebrow">Complete money history</p><h1>Activity</h1><p>Search, filter and review every entry.</p></div>
        <div className="page-title__actions">
          <Button variant="secondary" onClick={onImport}><MessageSquareText size={18} /> Import message</Button>
          <Button onClick={() => onAdd("expense")}><Plus size={18} /> Add entry</Button>
        </div>
      </header>

      <section className="filter-card">
        <label className="search-field">
          <Search size={19} />
          <input aria-label="Search activity by merchant or note" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search merchant or note" />
        </label>
        <button type="button" className={`filter-toggle ${showFilters ? "is-active" : ""}`} onClick={() => setShowFilters((value) => !value)} aria-expanded={showFilters} aria-controls="activity-filters">
          <Filter size={18} /> Filters
        </button>
        <div id="activity-filters" className={`filter-drawer ${showFilters ? "is-open" : ""}`} aria-hidden={!showFilters}>
          <label>
            Type
            <select value={direction} onChange={(event) => { setDirection(event.target.value); setPage(1); }}>
              <option value="">All money</option>
              <option value="expense">Expenses</option>
              <option value="income">Income</option>
              <option value="refund">Refunds</option>
              <option value="transfer">Transfers</option>
            </select>
          </label>
          <label>
            Family member
            <select value={memberId} onChange={(event) => { setMemberId(event.target.value); setPage(1); }}>
              <option value="">Everyone</option>
              {references.members.map((member) => <option value={member.id} key={member.id}>{member.name}</option>)}
            </select>
          </label>
          <label>
            Category
            <select value={categoryId} onChange={(event) => { setCategoryId(event.target.value); setPage(1); }}>
              <option value="">Every category</option>
              {references.categories.map((category) => <option value={category.id} key={category.id}>{category.name}</option>)}
            </select>
          </label>
          {(direction || memberId || categoryId) && <Button variant="ghost" onClick={() => { setDirection(""); setMemberId(""); setCategoryId(""); }}>Clear filters</Button>}
        </div>
      </section>

      {error && <InlineError message={error} />}
      <section className="panel activity-panel">
        {loading ? <Skeleton rows={6} /> : items.length ? (
          <div className="transaction-list transaction-list--full">
            {items.map((transaction) => (
              <div className="transaction-action-row" key={transaction.id}>
                <TransactionRow transaction={transaction} household={session.household} onClick={() => setEditing(transaction)} />
                <button className="icon-button delete-button" onClick={() => remove(transaction)} aria-label="Delete transaction"><Trash2 size={17} /></button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState title="No matching activity" message="Try clearing filters, or add a daily expense or income." action={<Button onClick={() => onAdd("expense")}>Add transaction</Button>} />
        )}
        {totalPages > 1 && (
          <div className="pagination">
            <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button>
            <span>Page {page} of {totalPages}</span>
            <Button variant="secondary" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>Next</Button>
          </div>
        )}
      </section>

      <AddTransactionSheet
        open={Boolean(editing)}
        initialTransaction={editing}
        onClose={() => setEditing(null)}
        onSaved={() => setLocalRefreshKey((value) => value + 1)}
        references={references}
        household={session.household}
      />
    </div>
  );
}
