import { lazy, Suspense, useEffect, useState } from "react";
import {
  BarChart3,
  CirclePlus,
  Home,
  ListOrdered,
  LogOut,
  Menu,
  MessageSquareText,
  PanelLeftClose,
  Plus,
  Settings,
  Target,
  WalletCards,
} from "lucide-react";
import { api, ApiError } from "./api";
import AuthGate, { PasswordChangeGate } from "./AuthGate";
import AddTransactionSheet from "./components/AddTransactionSheet";
import SmsImportSheet from "./components/SmsImportSheet";
import { Button, InlineError, Skeleton } from "./components/Primitives";
import { BrandMark } from "./icons";
import DashboardPage from "./pages/DashboardPage";
import type { AuthSession, BeforeInstallPromptEvent, ReferenceData, TransactionDirection } from "./types";

const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage"));
const PlannerPage = lazy(() => import("./pages/PlannerPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const TransactionsPage = lazy(() => import("./pages/TransactionsPage"));

type Page = "home" | "activity" | "analytics" | "plan" | "settings";

const navItems: Array<{ page: Page; label: string; icon: typeof Home }> = [
  { page: "home", label: "Home", icon: Home },
  { page: "activity", label: "Activity", icon: ListOrdered },
  { page: "analytics", label: "Analytics", icon: BarChart3 },
  { page: "plan", label: "Plan", icon: Target },
];

export default function App() {
  const [booting, setBooting] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [references, setReferences] = useState<ReferenceData>({ members: [], categories: [], accounts: [] });
  const [referenceError, setReferenceError] = useState("");
  const [page, setPage] = useState<Page>("home");
  const [addOpen, setAddOpen] = useState(false);
  const [addDirection, setAddDirection] = useState<TransactionDirection>("expense");
  const [smsOpen, setSmsOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sidebarCompact, setSidebarCompact] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    const displayMode = window.matchMedia("(display-mode: standalone)");
    const updateStandalone = () => setStandalone(displayMode.matches || ("standalone" in navigator && Boolean((navigator as Navigator & { standalone?: boolean }).standalone)));
    const captureInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const installed = () => {
      setInstallPrompt(null);
      setStandalone(true);
    };
    updateStandalone();
    window.addEventListener("beforeinstallprompt", captureInstallPrompt);
    window.addEventListener("appinstalled", installed);
    displayMode.addEventListener?.("change", updateStandalone);
    return () => {
      window.removeEventListener("beforeinstallprompt", captureInstallPrompt);
      window.removeEventListener("appinstalled", installed);
      displayMode.removeEventListener?.("change", updateStandalone);
    };
  }, []);

  useEffect(() => {
    let active = true;
    async function boot() {
      try {
        const status = await api.setupStatus();
        if (!active) return;
        setConfigured(status.configured);
        if (status.configured) {
          try {
            const current = await api.me();
            if (active) setSession(current);
          } catch (caught) {
            if (!(caught instanceof ApiError) || caught.status !== 401) throw caught;
          }
        }
      } catch {
        setReferenceError("The API is unavailable. Start the Cloudflare Worker and apply the D1 migration.");
      } finally {
        if (active) setBooting(false);
      }
    }
    void boot();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!session || session.user.mustChangePassword) return;
    api.referenceData()
      .then(setReferences)
      .catch((caught) => setReferenceError(caught instanceof ApiError ? caught.message : "Household data could not be loaded."));
  }, [session]);

  useEffect(() => {
    const quick = new URLSearchParams(window.location.search).get("quick");
    if (session && !session.user.mustChangePassword && (quick === "expense" || quick === "income")) {
      setAddDirection(quick);
      setAddOpen(true);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [session]);

  function openAdd(direction: TransactionDirection = "expense") {
    setAddDirection(direction);
    setAddOpen(true);
  }

  function changed() {
    setRefreshKey((value) => value + 1);
  }

  async function logout() {
    try {
      await api.logout();
    } finally {
      setSession(null);
      setReferences({ members: [], categories: [], accounts: [] });
      setPage("home");
    }
  }

  if (booting) {
    return (
      <main className="splash-screen">
        <BrandMark size={58} />
        <h1>PennyQuill</h1>
        <p>Opening your private ledger…</p>
        <div className="splash-loader" />
      </main>
    );
  }

  if (!session) {
    return (
      <>
        {referenceError && <div className="boot-error"><InlineError message={referenceError} /></div>}
        <AuthGate configured={configured} onAuthenticated={(value) => { setSession(value); setConfigured(true); setReferenceError(""); }} />
      </>
    );
  }

  if (session.user.mustChangePassword) {
    return (
      <PasswordChangeGate
        session={session}
        onChanged={setSession}
        onLogout={logout}
      />
    );
  }

  return (
    <div className={`app-shell ${sidebarCompact ? "app-shell--compact" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar__brand"><BrandMark size={40} /><span><strong>PennyQuill</strong><small>{session.household.name}</small></span></div>
        <nav aria-label="Primary navigation">
          {navItems.map(({ page: itemPage, label, icon: Icon }) => (
            <button className={page === itemPage ? "is-active" : ""} onClick={() => setPage(itemPage)} key={itemPage}>
              <Icon size={20} /><span>{label}</span>
            </button>
          ))}
          <button className={page === "settings" ? "is-active" : ""} onClick={() => setPage("settings")}><Settings size={20} /><span>Settings</span></button>
        </nav>
        <div className="sidebar__quick">
          <p>Quick entry</p>
          <button onClick={() => openAdd("expense")}><Plus size={18} /><span>Add expense</span></button>
          <button onClick={() => setSmsOpen(true)}><MessageSquareText size={18} /><span>Import message</span></button>
        </div>
        <button className="sidebar__profile" onClick={() => setPage("settings")}>
          <span>{session.user.displayName.charAt(0).toUpperCase()}</span>
          <span><strong>{session.user.displayName}</strong><small>{session.user.role}</small></span>
          <Settings size={17} />
        </button>
        <button className="sidebar__collapse" onClick={() => setSidebarCompact((value) => !value)} aria-label="Toggle compact navigation">
          {sidebarCompact ? <Menu size={18} /> : <PanelLeftClose size={18} />}
        </button>
      </aside>

      <main className="app-content">
        {referenceError && <div className="content-alert"><InlineError message={referenceError} /></div>}
        <Suspense fallback={<div className="page"><Skeleton rows={5} /></div>}>
          {page === "home" && <DashboardPage session={session} refreshKey={refreshKey} onAdd={openAdd} onImport={() => setSmsOpen(true)} onAnalytics={() => setPage("analytics")} onSettings={() => setPage("settings")} />}
          {page === "activity" && <TransactionsPage session={session} references={references} refreshKey={refreshKey} onAdd={openAdd} onImport={() => setSmsOpen(true)} />}
          {page === "analytics" && <AnalyticsPage session={session} references={references} refreshKey={refreshKey} />}
          {page === "plan" && <PlannerPage session={session} references={references} refreshKey={refreshKey} onChanged={changed} />}
          {page === "settings" && (
            <SettingsPage
              session={session}
              references={references}
              onReferencesChanged={(partial) => setReferences((current) => ({ ...current, ...partial }))}
              onImport={() => setSmsOpen(true)}
              onLogout={logout}
              installPrompt={installPrompt}
              standalone={standalone}
              onInstallPromptConsumed={() => setInstallPrompt(null)}
            />
          )}
        </Suspense>
      </main>

      <nav className="bottom-nav" aria-label="Mobile navigation">
        <button className={page === "home" ? "is-active" : ""} onClick={() => setPage("home")}><Home size={20} /><span>Home</span></button>
        <button className={page === "activity" ? "is-active" : ""} onClick={() => setPage("activity")}><ListOrdered size={20} /><span>Activity</span></button>
        <button className="bottom-nav__add" onClick={() => openAdd("expense")} aria-label="Add transaction"><CirclePlus size={29} /></button>
        <button className={page === "analytics" ? "is-active" : ""} onClick={() => setPage("analytics")}><BarChart3 size={20} /><span>Analytics</span></button>
        <button className={page === "plan" || page === "settings" ? "is-active" : ""} onClick={() => setPage("plan")}><Target size={20} /><span>Plan</span></button>
      </nav>

      <AddTransactionSheet
        open={addOpen}
        initialDirection={addDirection}
        onClose={() => setAddOpen(false)}
        onSaved={changed}
        references={references}
        household={session.household}
      />
      <SmsImportSheet
        open={smsOpen}
        onClose={() => setSmsOpen(false)}
        onImported={changed}
        references={references}
        household={session.household}
      />
    </div>
  );
}
