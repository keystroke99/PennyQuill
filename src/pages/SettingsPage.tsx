import { useState } from "react";
import {
  Banknote,
  Check,
  Cloud,
  Download,
  ExternalLink,
  KeyRound,
  LogOut,
  MessageSquareText,
  MonitorSmartphone,
  Pencil,
  Plus,
  ShieldCheck,
  Smartphone,
  Trash2,
  UserRound,
  UsersRound,
  WalletCards,
  Tags,
} from "lucide-react";
import { api, ApiError } from "../api";
import { BrandMark, NamedIcon } from "../icons";
import { Button, InlineError, Sheet } from "../components/Primitives";
import type { Account, AuthSession, BeforeInstallPromptEvent, Category, Member, ReferenceData } from "../types";
import { formatMoney, initials } from "../utils";

const RELATIONSHIPS = [
  ["self", "Self"],
  ["spouse", "Spouse / partner"],
  ["child", "Child"],
  ["parent", "Parent"],
  ["sibling", "Sibling"],
  ["family", "Family"],
  ["other", "Other"],
] as const;

function relationshipLabel(value: string): string {
  return RELATIONSHIPS.find(([key]) => key === value)?.[1] ?? value;
}

export default function SettingsPage({
  session,
  references,
  onReferencesChanged,
  onImport,
  onLogout,
  installPrompt,
  standalone,
  onInstallPromptConsumed,
}: {
  session: AuthSession;
  references: ReferenceData;
  onReferencesChanged: (data: Partial<ReferenceData>) => void;
  onImport: () => void;
  onLogout: () => void;
  installPrompt: BeforeInstallPromptEvent | null;
  standalone: boolean;
  onInstallPromptConsumed: () => void;
}) {
  const [form, setForm] = useState<"member" | "account" | "category" | null>(null);
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  const [memberToDelete, setMemberToDelete] = useState<Member | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const canManageMembers = session.user.role !== "viewer";

  function openForm(nextForm: "member" | "account" | "category") {
    setEditingMember(null);
    setFormError("");
    setForm(nextForm);
  }

  function editMember(member: Member) {
    setEditingMember(member);
    setFormError("");
    setForm("member");
  }

  function closeForm() {
    if (saving) return;
    setForm(null);
    setEditingMember(null);
    setFormError("");
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    const data = new FormData(event.currentTarget);
    try {
      if (form === "member") {
        const memberInput = {
          name: String(data.get("name")),
          relationship: String(data.get("relationship")),
          ...(editingMember ? {} : { avatarIcon: "user-round" }),
        };
        const member = editingMember
          ? await api.updateMember(editingMember.id, memberInput)
          : await api.createMember(memberInput);
        const members = editingMember
          ? references.members.map((item) => item.id === member.id ? member : item)
          : [...references.members, member];
        onReferencesChanged({ members: members.sort((a, b) => a.name.localeCompare(b.name)) });
      } else if (form === "account") {
        const account = await api.createAccount({
          name: String(data.get("name")),
          type: String(data.get("type")),
          currency: session.household.currency,
          openingBalanceMinor: Math.round(Number(data.get("openingBalance") || 0) * 100),
          includeInNetWorth: true,
          icon: "wallet-cards",
          color: "#385B45",
        });
        onReferencesChanged({ accounts: [...references.accounts, account] });
      } else if (form === "category") {
        const category = await api.createCategory({
          name: String(data.get("name")),
          kind: String(data.get("kind")),
          classification: String(data.get("classification")),
          icon: "circle-dollar-sign",
          color: String(data.get("color")),
          parentId: null,
        });
        onReferencesChanged({ categories: [...references.categories, category].sort((a, b) => a.name.localeCompare(b.name)) });
      }
      setForm(null);
      setEditingMember(null);
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : "Could not save this setting.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteMember() {
    if (!memberToDelete) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await api.deleteMember(memberToDelete.id);
      onReferencesChanged({ members: references.members.filter((member) => member.id !== memberToDelete.id) });
      setMemberToDelete(null);
    } catch (caught) {
      setDeleteError(caught instanceof ApiError ? caught.message : "Could not remove this family member.");
    } finally {
      setDeleting(false);
    }
  }

  async function install() {
    if (installPrompt) {
      await installPrompt.prompt();
      await installPrompt.userChoice.catch(() => undefined);
      onInstallPromptConsumed();
    }
  }

  async function downloadExport() {
    setError("");
    try {
      const response = await fetch("/api/export", { credentials: "include", headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Export request failed.");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `pennyquill-export-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Could not create the household export. Please try again.");
    }
  }

  return (
    <div className="page">
      <header className="page-title">
        <div><p className="eyebrow">Your household & device</p><h1>Settings</h1><p>Control people, accounts, imports and installation.</p></div>
        <div className="settings-profile"><span>{initials(session.user.displayName)}</span><div><strong>{session.user.displayName}</strong><small>{session.user.email}</small></div></div>
      </header>

      <div className="settings-grid">
        <section className="panel settings-section">
          <div className="section-heading"><div><p className="eyebrow">Household</p><h2>Family members</h2></div>{canManageMembers && <button className="small-add" onClick={() => openForm("member")}><Plus size={16} /> Add</button>}</div>
          <div className="settings-list">
            {references.members.map((member: Member) => (
              <div className="settings-row settings-row--member" key={member.id}>
                <span className="settings-icon"><UserRound size={19} /></span>
                <span className="settings-row__content"><strong>{member.name}</strong><small>{relationshipLabel(member.relationship)}</small></span>
                {canManageMembers ? (
                  <span className="settings-row__actions">
                    <button type="button" className="member-action" onClick={() => editMember(member)} aria-label={`Edit ${member.name}`} title={`Edit ${member.name}`}><Pencil size={17} /></button>
                    <button type="button" className="member-action member-action--danger" onClick={() => { setDeleteError(""); setMemberToDelete(member); }} aria-label={`Delete ${member.name}`} title={`Delete ${member.name}`}><Trash2 size={17} /></button>
                  </span>
                ) : member.active ? <span className="active-dot">Active</span> : null}
              </div>
            ))}
            {!references.members.length && <p className="panel-placeholder">No active family members. Add someone to attribute income and spending.</p>}
          </div>
        </section>

        <section className="panel settings-section">
          <div className="section-heading"><div><p className="eyebrow">Your taxonomy</p><h2>Categories</h2></div><button className="small-add" onClick={() => openForm("category")}><Plus size={16} /> Add</button></div>
          <div className="settings-list settings-list--categories">
            {references.categories.slice(0, 8).map((category: Category) => (
              <div className="settings-row" key={category.id}>
                <span className="settings-icon" style={{ color: category.color }}><NamedIcon name={category.icon} size={19} /></span>
                <span><strong>{category.name}</strong><small>{category.kind} · {category.classification}</small></span>
                {category.isSystem && <span className="active-dot">Default</span>}
              </div>
            ))}
          </div>
        </section>

        <section className="panel settings-section">
          <div className="section-heading"><div><p className="eyebrow">Money locations</p><h2>Accounts</h2></div><button className="small-add" onClick={() => openForm("account")}><Plus size={16} /> Add</button></div>
          <div className="settings-list">
            {references.accounts.map((account: Account) => (
              <div className="settings-row" key={account.id}>
                <span className="settings-icon" style={{ color: account.color }}><NamedIcon name={account.icon} size={19} /></span>
                <span><strong>{account.name}</strong><small>{account.type.replace("_", " ")}</small></span>
                <strong>{formatMoney(account.currentBalanceMinor ?? account.openingBalanceMinor, session.household)}</strong>
              </div>
            ))}
            {!references.accounts.length && <p className="panel-placeholder">Add cash, bank, wallet or card accounts.</p>}
          </div>
        </section>

        <section className="panel settings-section install-section">
          <div className="section-heading"><div><p className="eyebrow">Manual installation</p><h2>Use it like an app</h2></div><MonitorSmartphone size={22} /></div>
          {standalone ? (
            <div className="installed-card"><Check size={22} /><div><strong>Installed on this device</strong><p>PennyQuill is running in standalone app mode.</p></div></div>
          ) : (
            <>
              <div className="install-platform">
                <span><Smartphone size={20} /></span>
                <div><strong>iPhone or iPad</strong><p>Open this site in Safari → Share → Add to Home Screen → turn on “Open as Web App” → Add.</p></div>
              </div>
              <div className="install-platform">
                <span><Download size={20} /></span>
                <div><strong>Android</strong><p>Open in Chrome → menu → Install app. No APK is needed for the PWA.</p></div>
              </div>
              {installPrompt && <Button onClick={install}><Download size={18} /> Install on this device</Button>}
            </>
          )}
        </section>

        <section className="panel settings-section">
          <div className="section-heading"><div><p className="eyebrow">Import safely</p><h2>SMS & bank alerts</h2></div><MessageSquareText size={22} /></div>
          <p className="settings-copy">Paste a message to create a review draft. PennyQuill never requests broad SMS inbox access and never saves the raw message body.</p>
          <Button variant="secondary" onClick={onImport}><MessageSquareText size={17} /> Paste & review message</Button>
        </section>

        <section className="panel settings-section">
          <div className="section-heading"><div><p className="eyebrow">Security</p><h2>Private by design</h2></div><ShieldCheck size={22} /></div>
          <div className="security-points">
            <span><Cloud size={18} /><p><strong>Cloudflare D1</strong>Household-scoped queries and encrypted transport</p></span>
            <span><KeyRound size={18} /><p><strong>Protected access</strong>PBKDF2 password hash and revocable opaque sessions</p></span>
            <span><UsersRound size={18} /><p><strong>Audit trail</strong>Important writes are recorded in an append-only log</p></span>
          </div>
          {(session.user.role === "owner" || session.user.role === "admin") && (
            <Button variant="secondary" onClick={downloadExport}><Download size={17} /> Download household data</Button>
          )}
        </section>

        <section className="panel settings-section about-section">
          <div className="brand-lockup"><BrandMark size={42} /><div><strong>PennyQuill</strong><small>Cloudflare edition · v1.0</small></div></div>
          <p>UI icons are from the open-source Lucide icon set under the ISC license.</p>
          <a href="https://lucide.dev/" target="_blank" rel="noreferrer">Lucide project <ExternalLink size={14} /></a>
          <Button variant="danger" onClick={onLogout}><LogOut size={17} /> Sign out</Button>
        </section>
      </div>

      {error && <InlineError message={error} />}
      <Sheet open={Boolean(form)} onClose={closeForm} title={form === "member" ? editingMember ? "Edit family member" : "Add family member" : form === "account" ? "Add account" : "Add category"} eyebrow={form === "member" ? "Family member" : "Household setup"}>
        <form className="form-stack" onSubmit={save} key={`${form ?? "form"}-${editingMember?.id ?? "new"}`}>
          <label>Name<input name="name" required maxLength={80} defaultValue={form === "member" ? editingMember?.name ?? "" : ""} placeholder={form === "member" ? "Family member name" : form === "account" ? "Primary bank" : "Childcare"} autoFocus /></label>
          {form === "member" ? (
            <label>Relationship<select name="relationship" defaultValue={editingMember?.relationship ?? "spouse"}>
              {editingMember && !RELATIONSHIPS.some(([key]) => key === editingMember.relationship) && <option value={editingMember.relationship}>{editingMember.relationship}</option>}
              {RELATIONSHIPS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select></label>
          ) : form === "account" ? (
            <>
              <label>Type<select name="type" defaultValue="bank"><option value="bank">Bank account</option><option value="cash">Cash</option><option value="credit_card">Credit card</option><option value="wallet">Digital wallet</option><option value="investment">Investment</option><option value="other">Other</option></select></label>
              <label>Opening balance<input name="openingBalance" inputMode="decimal" defaultValue="0" /></label>
            </>
          ) : (
            <>
              <div className="field-row"><label>Money type<select name="kind" defaultValue="expense"><option value="expense">Expense</option><option value="income">Income</option><option value="both">Both</option></select></label><label>Classification<select name="classification" defaultValue="discretionary"><option value="essential">Essential</option><option value="discretionary">Discretionary</option><option value="savings">Savings</option></select></label></div>
              <label>Color<input name="color" type="color" defaultValue="#385B45" /></label>
            </>
          )}
          {formError && <InlineError message={formError} />}
          <Button type="submit" disabled={saving}>{saving ? "Saving…" : <><Check size={17} /> {editingMember ? "Save changes" : "Save"}</>}</Button>
        </form>
      </Sheet>

      <Sheet open={Boolean(memberToDelete)} onClose={() => { if (!deleting) { setMemberToDelete(null); setDeleteError(""); } }} title="Delete family member?" eyebrow="Household">
        {memberToDelete && (
          <div className="delete-confirmation">
            <span className="delete-confirmation__icon"><Trash2 size={24} /></span>
            <div>
              <strong>Remove {memberToDelete.name} from active family members?</strong>
              <p>They will disappear from new entries and filters. Existing transactions, analytics and planning records keep their attribution.</p>
              {memberToDelete.userId && <p>The linked sign-in account will remain active and must be managed separately.</p>}
            </div>
            {deleteError && <InlineError message={deleteError} />}
            <div className="delete-confirmation__actions">
              <Button type="button" variant="ghost" onClick={() => { setMemberToDelete(null); setDeleteError(""); }} disabled={deleting}>Cancel</Button>
              <Button type="button" variant="danger" onClick={deleteMember} disabled={deleting}><Trash2 size={17} /> {deleting ? "Deleting…" : "Delete member"}</Button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}
