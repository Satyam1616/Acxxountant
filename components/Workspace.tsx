"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import LandingScreen from "@/components/LandingScreen";
import AccessRequestScreen from "@/components/AccessRequestScreen";
import ProductTour, { tourSteps } from "@/components/ProductTour";
import { currencyMeta, supportedCurrencies } from "@/lib/domain/currency";
import type { MoneyWire } from "@/lib/domain/types";
import {
  amountPlaceholder,
  amountPrecisionHint,
  bankCsvExample,
  dateLabel,
  invoiceDueDate,
  moneyLabel as formatMoney,
} from "@/lib/presentation";

type View = "overview" | "reconcile" | "invoices" | "customers" | "ledger" | "reports" | "settings";
type Dashboard = {
  entity: {
    name: string;
    legalName: string;
    currency: string;
    timezone: string;
    settings: { autoApplyThreshold: number; feeToleranceMinor: string; aiProvider: string };
  };
  reportingDate: string;
  currencyChangeAllowed: boolean;
  storage: { adapter: string; durable: boolean; ephemeral: boolean };
  metrics: {
    outstanding: MoneyWire;
    overdue: MoneyWire;
    collectedThisMonth: MoneyWire;
    needsReview: number;
    matchedThisMonth: number;
  };
  accounts: Account[];
  transactions: Transaction[];
  aging: Array<{
    customerId: string;
    customerName: string;
    currency: string;
    current: MoneyWire;
    overdue1to30: MoneyWire;
    overdue31to60: MoneyWire;
    overdue61to90: MoneyWire;
    overdue90Plus: MoneyWire;
    total: MoneyWire;
  }>;
  recentTransactions: Transaction[];
  reviewQueue: Array<{
    transaction: Transaction;
    match?: Match;
    invoice?: Invoice;
    customer?: Customer;
  }>;
  invoices: Invoice[];
  customers: Customer[];
};
type Transaction = {
  id: string;
  date: string;
  amount: MoneyWire;
  flow: "inflow" | "outflow";
  description: string;
  reference: string;
  counterparty?: string;
  status: string;
  matchId?: string;
  journalEntryId?: string;
};
type Match = {
  id: string;
  status: string;
  confidence: number;
  rationale: string[];
  allocations: Array<{ invoiceId: string; amount: MoneyWire }>;
  suggestedAccountId?: string;
};
type Account = {
  id: string;
  code: string;
  name: string;
  type: string;
  control: string | null;
  currency: string | null;
  active: boolean;
};
type Invoice = {
  id: string;
  number: string;
  customerId: string;
  issueDate: string;
  dueDate: string;
  total: MoneyWire;
  status: string;
  outstanding?: MoneyWire;
  lines: Array<{ description: string }>;
};
type Customer = { id: string; name: string; email: string; company?: string };
type LedgerEntry = {
  id: string;
  date: string;
  description: string;
  source: string;
  lines: Array<{ accountId: string; side: string; amount: MoneyWire; memo?: string }>;
};
type Reports = {
  trialBalance: Array<{
    accountCode: string;
    accountName: string;
    accountType: string;
    debit: MoneyWire;
    credit: MoneyWire;
    balance: MoneyWire;
  }>;
  aging: Dashboard["aging"];
  pnl: { incomeTotal: MoneyWire; expenseTotal: MoneyWire; net: MoneyWire };
  balanceSheet: {
    assets: MoneyWire;
    liabilities: MoneyWire;
    equity: MoneyWire;
    difference: MoneyWire;
  };
  asOf: string;
  from: string;
};
type SessionInfo = { email: string; role: "admin" | "accountant" | "viewer"; expiresAt: number };

const navItems: Array<{ id: View; label: string; icon: string }> = [
  { id: "overview", label: "Overview", icon: "grid" },
  { id: "reconcile", label: "Reconcile", icon: "spark" },
  { id: "invoices", label: "Invoices", icon: "file" },
  { id: "customers", label: "Customers", icon: "users" },
  { id: "ledger", label: "Ledger", icon: "book" },
  { id: "reports", label: "Reports", icon: "chart" },
  { id: "settings", label: "Settings", icon: "gear" },
];

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" />
        <path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" />
      </>
    ),
    file: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6M8 13h8M8 17h6" />
      </>
    ),
    users: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </>
    ),
    book: (
      <>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
        <path d="M8 6h8M8 10h8" />
      </>
    ),
    chart: (
      <>
        <path d="M4 19V5M4 19h17" />
        <path d="m7 15 4-4 3 2 5-7" />
      </>
    ),
    gear: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.41 1.41-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V20h-2v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-1.41-1.41.06-.06A1.7 1.7 0 0 0 9.4 15a1.7 1.7 0 0 0-1.56-1.03H7v-2h.84A1.7 1.7 0 0 0 9.4 10a1.7 1.7 0 0 0-.34-1.88L9 8.06l1.41-1.41.06.06A1.7 1.7 0 0 0 12.35 7.7 1.7 1.7 0 0 0 13.38 6.14V6h2v.14a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.41 1.41-.06.06A1.7 1.7 0 0 0 19.4 10a1.7 1.7 0 0 0 1.56 1.03H21v2h-.04A1.7 1.7 0 0 0 19.4 15Z" />
      </>
    ),
    plus: (
      <>
        <path d="M12 5v14M5 12h14" />
      </>
    ),
    upload: (
      <>
        <path d="M12 16V4M7 9l5-5 5 5" />
        <path d="M5 20h14" />
      </>
    ),
    search: (
      <>
        <circle cx="10.8" cy="10.8" r="6.8" />
        <path d="m16 16 5 5" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14M13 6l6 6-6 6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    close: (
      <>
        <path d="m6 6 12 12M18 6 6 18" />
      </>
    ),
    logout: (
      <>
        <path d="M10 17 15 12 10 7" />
        <path d="M15 12H3" />
        <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
      </>
    ),
    more: (
      <>
        <circle cx="5" cy="12" r="1" fill="currentColor" />
        <circle cx="12" cy="12" r="1" fill="currentColor" />
        <circle cx="19" cy="12" r="1" fill="currentColor" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
      </>
    ),
    undo: (
      <>
        <path d="M9 7 4 12l5 5" />
        <path d="M4 12h9a6 6 0 0 1 6 6" />
      </>
    ),
    filter: <path d="M4 5h16M7 12h10M10 19h4" />,
    chevron: <path d="m9 18 6-6-6-6" />,
  };
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name] ?? paths.grid}
    </svg>
  );
}

function statusLabel(status: string) {
  return status === "partial" ? "Partially paid" : status.charAt(0).toUpperCase() + status.slice(1);
}
function initials(value: string) {
  return value
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
function overdueMinor(row: Dashboard["aging"][number]) {
  return (
    BigInt(row.overdue1to30.minor) +
    BigInt(row.overdue31to60.minor) +
    BigInt(row.overdue61to90.minor) +
    BigInt(row.overdue90Plus.minor)
  );
}

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error ?? "Request failed") as Error & {
      status?: number;
      code?: string;
    };
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload as T;
}

function downloadCsv(filename: string, headers: string[], rows: string[][]): void {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const csv = [headers, ...rows].map((row) => row.map(escape).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export default function Workspace() {
  const [view, setView] = useState<View>("overview");
  const [session, setSession] = useState<SessionInfo | null | undefined>(undefined);
  const [showLanding, setShowLanding] = useState(true);
  const [showAccessRequest, setShowAccessRequest] = useState(false);
  const [tourStep, setTourStep] = useState<number | null>(null);
  const tourInitialized = useRef(false);
  const [authConfigured, setAuthConfigured] = useState(true);
  const [authError, setAuthError] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [reports, setReports] = useState<Reports | null>(null);
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [ledgerError, setLedgerError] = useState("");
  const [reportsError, setReportsError] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [modal, setModal] = useState<"invoice" | "customer" | "import" | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setDashboard(await requestJson<Dashboard>("/api/dashboard"));
    } catch (reason) {
      if ((reason as { status?: number })?.status === 401) setSession(null);
      setError(reason instanceof Error ? reason.message : "Unable to load workspace");
    } finally {
      setLoading(false);
    }
  }, []);
  const loadLedger = useCallback(async () => {
    setLedgerLoading(true);
    setLedgerError("");
    try {
      setLedger(await requestJson<LedgerEntry[]>("/api/ledger"));
    } catch (reason) {
      setLedgerError(reason instanceof Error ? reason.message : "Unable to load ledger");
    } finally {
      setLedgerLoading(false);
    }
  }, []);
  const loadReports = useCallback(async () => {
    setReportsLoading(true);
    setReportsError("");
    try {
      setReports(await requestJson<Reports>("/api/reports"));
    } catch (reason) {
      setReportsError(reason instanceof Error ? reason.message : "Unable to load reports");
    } finally {
      setReportsLoading(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    void fetch("/api/auth/session", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as {
          configured?: boolean;
          session?: SessionInfo | null;
        };
        if (!active) return;
        setAuthConfigured(payload.configured !== false);
        if (payload.session) {
          setShowLanding(false);
          setSession(payload.session);
          await reload();
        } else {
          setSession(null);
        }
      })
      .catch((reason) => {
        if (!active) return;
        setSession(null);
        setAuthError(
          reason instanceof Error ? reason.message : "Authentication service unavailable",
        );
      });
    return () => {
      active = false;
    };
  }, [reload]);
  useEffect(() => {
    if (toast) {
      const timer = window.setTimeout(() => setToast(""), 3500);
      return () => window.clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    if (view === "ledger") void loadLedger();
    if (view === "reports") void loadReports();
  }, [view, loadLedger, loadReports]);
  useEffect(() => {
    if (!session || !dashboard || tourInitialized.current) return;
    tourInitialized.current = true;
    try {
      if (window.localStorage.getItem("ledgerflow-tour-v1") !== "done") setTourStep(0);
    } catch {
      setTourStep(0);
    }
  }, [session, dashboard]);
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  const action = async (label: string, fn: () => Promise<unknown>) => {
    setWorking(label);
    setError("");
    try {
      await fn();
      setToast(label);
      await reload();
    } catch (reason) {
      if ((reason as { status?: number })?.status === 401) setSession(null);
      setError(reason instanceof Error ? reason.message : "Action failed");
    } finally {
      setWorking(null);
    }
  };
  const logout = async () => {
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) setError("Sign out could not be confirmed, but this screen was closed.");
    } catch {
      setError(
        "Network error while signing out. Please close this tab if you are on a shared device.",
      );
    }
    setSession(null);
    setDashboard(null);
    setTourStep(null);
    tourInitialized.current = false;
    setShowLanding(true);
    setShowAccessRequest(false);
  };
  const skipTour = () => {
    try {
      window.localStorage.setItem("ledgerflow-tour-v1", "done");
    } catch {
      // The guide can still be dismissed when browser storage is unavailable.
    }
    setTourStep(null);
  };
  const nextTourStep = () => {
    if (tourStep === null) return;
    let nextIndex = tourStep + 1;
    while (!isAdmin && nextIndex < tourSteps.length && tourSteps[nextIndex].view === "settings")
      nextIndex += 1;
    if (nextIndex >= tourSteps.length) {
      skipTour();
      return;
    }
    const next = tourSteps[nextIndex];
    setView(next.view);
    setTourStep(nextIndex);
  };
  const startTour = () => {
    tourInitialized.current = true;
    setView("overview");
    setTourStep(0);
  };
  const activeTransaction = dashboard?.reviewQueue.find(
    (item) => item.transaction.id === selectedId,
  );
  const role = session?.role;
  const canMutate = role === "admin" || role === "accountant";
  const isAdmin = role === "admin";
  const visibleNavItems = navItems.filter((item) => item.id !== "settings" || isAdmin);

  if (session === undefined || (session && loading && !dashboard))
    return (
      <div className="loading-screen">
        <div className="loader-mark">LF</div>
        <p>Preparing your books…</p>
      </div>
    );
  if (!session && showLanding)
    return (
      <LandingScreen
        onLogin={() => {
          setShowLanding(false);
          setShowAccessRequest(false);
        }}
        onSignup={() => {
          setShowLanding(false);
          setShowAccessRequest(true);
        }}
      />
    );
  if (!session && showAccessRequest)
    return (
      <AccessRequestScreen
        onBack={() => {
          setShowAccessRequest(false);
          setShowLanding(true);
        }}
        onSignIn={() => {
          setShowAccessRequest(false);
          setShowLanding(false);
        }}
      />
    );
  if (!session)
    return (
      <LoginScreen
        configured={authConfigured}
        initialError={authError}
        onSignup={() => setShowAccessRequest(true)}
        onLogin={(value) => {
          setShowLanding(false);
          setShowAccessRequest(false);
          setSession(value);
          void reload();
        }}
      />
    );
  if (!dashboard)
    return (
      <div className="fatal-screen">
        <div className="empty-icon">
          <Icon name="book" size={28} />
        </div>
        <h1>We couldn’t open this workspace</h1>
        <p>{error || "Try again to load your local accounting data."}</p>
        <button className="button primary" onClick={() => void reload()}>
          Try again
        </button>
      </div>
    );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">LF</div>
          <div>
            <strong>ledgerflow</strong>
            <span>finance workspace</span>
          </div>
        </div>
        <div className="entity-switcher">
          <div className="entity-avatar">NF</div>
          <div className="entity-copy">
            <strong>{dashboard.entity.name}</strong>
            <span>Workspace · {dashboard.entity.currency}</span>
          </div>
          <span className="switcher-chevron">⌄</span>
        </div>
        <nav className="main-nav" aria-label="Main navigation">
          {visibleNavItems.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "active" : ""} ${tourStep !== null && tourSteps[tourStep]?.view === item.id ? "tour-focus" : ""}`}
              onClick={() => setView(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.id === "reconcile" && dashboard.metrics.needsReview > 0 && (
                <b className="nav-badge">{dashboard.metrics.needsReview}</b>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card">
            <div className="help-icon">
              <Icon name="spark" size={16} />
            </div>
            <strong>Need a hand?</strong>
            <span>Ask LedgerFlow AI about your books.</span>
            <button onClick={startTour}>
              Show workspace guide <Icon name="arrow" size={13} />
            </button>
          </div>
          <div className="user-row">
            <div className="user-avatar">{initials(session.email.split("@")[0])}</div>
            <div>
              <strong>{session.email}</strong>
              <span className="role-badge">{session.role}</span>
            </div>
            <button
              className="icon-button"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => void logout()}
            >
              <Icon name="logout" />
            </button>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Northstar Finance</span>
            <Icon name="chevron" size={13} />
            <strong>{visibleNavItems.find((item) => item.id === view)?.label ?? "Overview"}</strong>
          </div>
          <div className="topbar-actions">
            <label className="search-box">
              <Icon name="search" size={16} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search anything…"
              />
              <kbd>⌘ K</kbd>
            </label>
            <span
              className={`sync-status ${dashboard.storage.ephemeral ? "storage-warning" : ""}`}
              title={
                dashboard.storage.ephemeral
                  ? "This demo uses ephemeral storage"
                  : "Connected to durable storage"
              }
            >
              <i /> {dashboard.storage.ephemeral ? "Demo storage" : "Synced just now"}
            </span>
            <button className="icon-button notification" aria-label="Notifications">
              <span className="notification-dot" />
              <span>♧</span>
            </button>
            <div className="top-avatar">{initials(session.email.split("@")[0])}</div>
            <button className="mobile-sign-out" onClick={() => void logout()}>
              <Icon name="logout" size={16} />
              <span>Sign out</span>
            </button>
          </div>
        </header>
        {!canMutate && (
          <div className="role-banner" role="status">
            <span className="role-banner-dot" /> You are viewing this workspace as a{" "}
            <strong>{role}</strong>. Editing and posting controls are hidden.
          </div>
        )}
        {error && (
          <div className="error-banner">
            <span>
              <strong>Something needs your attention.</strong> {error}
            </span>
            <button onClick={() => setError("")}>
              <Icon name="close" size={15} />
            </button>
          </div>
        )}
        <div className="page-wrap">
          {view === "overview" && (
            <Overview
              dashboard={dashboard}
              onNavigate={setView}
              onCreate={canMutate ? () => setModal("invoice") : undefined}
              onImport={canMutate ? () => setModal("import") : undefined}
              canMutate={canMutate}
            />
          )}
          {view === "reconcile" && (
            <Reconcile
              dashboard={dashboard}
              query={query}
              working={working}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onAction={action}
              onImport={canMutate ? () => setModal("import") : undefined}
              canMutate={canMutate}
            />
          )}
          {view === "invoices" && (
            <Invoices
              dashboard={dashboard}
              query={query}
              onCreate={canMutate ? () => setModal("invoice") : undefined}
              canMutate={canMutate}
            />
          )}
          {view === "customers" && (
            <Customers
              dashboard={dashboard}
              query={query}
              onCreate={canMutate ? () => setModal("customer") : undefined}
              canMutate={canMutate}
            />
          )}
          {view === "ledger" && (
            <Ledger
              entries={ledger}
              currency={dashboard.entity.currency}
              loading={ledgerLoading}
              error={ledgerError}
              onRetry={() => void loadLedger()}
            />
          )}
          {view === "reports" && (
            <ReportsView
              reports={reports}
              currency={dashboard.entity.currency}
              loading={reportsLoading}
              error={reportsError}
              onRetry={() => void loadReports()}
            />
          )}
          {view === "settings" && (
            <Settings
              dashboard={dashboard}
              onSaved={() => void reload()}
              onError={setError}
              canEdit={isAdmin}
            />
          )}
        </div>
      </main>
      {activeTransaction && (
        <ReviewDrawer
          item={activeTransaction}
          accounts={dashboard.accounts}
          currency={dashboard.entity.currency}
          onClose={() => setSelectedId(null)}
          onAction={action}
          working={working}
          canMutate={canMutate}
        />
      )}
      {modal === "invoice" && (
        <InvoiceModal
          dashboard={dashboard}
          onClose={() => {
            setModal(null);
            void reload();
          }}
          onCreated={() => {
            setModal(null);
            setToast("Invoice issued");
            void reload();
          }}
        />
      )}
      {modal === "customer" && (
        <CustomerModal
          currency={dashboard.entity.currency}
          onClose={() => setModal(null)}
          onCreated={() => {
            setModal(null);
            setToast("Customer added");
            void reload();
          }}
        />
      )}
      {modal === "import" && (
        <ImportModal
          currency={dashboard.entity.currency}
          onClose={() => {
            setModal(null);
            void reload();
          }}
          onImported={(message) => {
            setModal(null);
            setToast(message);
            void reload();
          }}
        />
      )}
      {toast && (
        <div className="toast">
          <span className="toast-check">
            <Icon name="check" size={14} />
          </span>
          {toast}
        </div>
      )}
      {tourStep !== null && <ProductTour step={tourStep} onNext={nextTourStep} onSkip={skipTour} />}
    </div>
  );
}

export function LoginScreen({
  configured,
  initialError,
  onSignup,
  onLogin,
}: {
  configured: boolean;
  initialError: string;
  onSignup: () => void;
  onLogin: (session: SessionInfo) => void;
}) {
  const [email, setEmail] = useState("admin@ledgerflow.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(initialError);
  const [working, setWorking] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to sign in");
      onLogin(payload.session as SessionInfo);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to sign in");
    } finally {
      setWorking(false);
    }
  };
  return (
    <main className="auth-screen">
      <div className="auth-card">
        <div className="brand auth-brand">
          <div className="brand-mark">LF</div>
          <div>
            <strong>ledgerflow</strong>
            <span>finance workspace</span>
          </div>
        </div>
        <div className="auth-heading">
          <span className="eyebrow">Secure workspace access</span>
          <h1>Welcome back</h1>
          <p>Sign in to review transactions and manage your books.</p>
        </div>
        {!configured ? (
          <div className="form-error">
            Production authentication is not configured. Set <code>AUTH_SECRET</code>,{" "}
            <code>APP_AUTH_EMAIL</code>, and <code>APP_AUTH_PASSWORD</code> in the deployment
            environment.
          </div>
        ) : (
          <form className="modal-form" onSubmit={submit}>
            {error && <div className="form-error">{error}</div>}
            <label>
              Email address
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
              <small>Use the credentials assigned to your workspace role.</small>
            </label>
            <button className="button primary full" disabled={working}>
              {working ? "Signing in…" : "Sign in"} <Icon name="arrow" size={15} />
            </button>
          </form>
        )}
        <div className="auth-switch">
          New to LedgerFlow? <button onClick={onSignup}>Sign up / request access</button>
        </div>
        <div className="auth-foot">
          <Icon name="check" size={14} /> Your financial data is protected by an encrypted session.
        </div>
      </div>
    </main>
  );
}

export function Overview({
  dashboard,
  onNavigate,
  onCreate,
  onImport,
  canMutate,
}: {
  dashboard: Dashboard;
  onNavigate: (view: View) => void;
  onCreate?: () => void;
  onImport?: () => void;
  canMutate: boolean;
}) {
  const maxAging = Math.max(...dashboard.aging.map((row) => Number(row.total.minor)), 1);
  const overdueCount = dashboard.invoices.filter((invoice) => invoice.status === "overdue").length;
  const openCount = dashboard.invoices.filter(
    (invoice) => BigInt(invoice.outstanding?.minor ?? invoice.total.minor) > 0n,
  ).length;
  const highConfidenceCount = dashboard.reviewQueue.filter(
    (item) => (item.match?.confidence ?? 0) >= dashboard.entity.settings.autoApplyThreshold,
  ).length;
  const reportingDate = dateLabel(dashboard.reportingDate, dashboard.entity.currency, "long");
  return (
    <>
      <div className="page-heading hero-heading">
        <div>
          <div className="eyebrow">
            <span className="eyebrow-dot" /> {reportingDate}
          </div>
          <h1>
            Good morning, Jordan <span className="wave">✦</span>
          </h1>
          <p>Here’s what’s happening across {dashboard.entity.name} today.</p>
        </div>
        {canMutate && (
          <div className="heading-actions">
            <button className="button secondary" onClick={onImport}>
              <Icon name="upload" size={16} /> Import transactions
            </button>
            <button className="button primary" onClick={onCreate}>
              <Icon name="plus" size={16} /> New invoice
            </button>
          </div>
        )}
      </div>
      <div className="metric-grid">
        <MetricCard
          label="Outstanding receivables"
          value={formatMoney(dashboard.metrics.outstanding)}
          sub={`Across ${openCount} open invoices`}
          tone="blue"
          icon="↗"
        />
        <MetricCard
          label="Overdue"
          value={formatMoney(dashboard.metrics.overdue)}
          sub={`${overdueCount} invoice${overdueCount === 1 ? "" : "s"} need attention`}
          tone="coral"
          icon="!"
        />
        <MetricCard
          label="Collected this month"
          value={formatMoney(dashboard.metrics.collectedThisMonth)}
          sub="↑ 18.4% vs last month"
          tone="mint"
          icon="✓"
        />
        <MetricCard
          label="Needs your review"
          value={String(dashboard.metrics.needsReview).padStart(2, "0")}
          sub={`${highConfidenceCount} high-confidence suggestion${highConfidenceCount === 1 ? "" : "s"}`}
          tone="amber"
          icon="✦"
          action={() => onNavigate("reconcile")}
        />
      </div>
      <div className="overview-grid">
        <section className="card aging-card">
          <div className="section-heading">
            <div>
              <h2>Receivables aging</h2>
              <p>Outstanding balance by customer</p>
            </div>
            <button className="link-button" onClick={() => onNavigate("reports")}>
              View report <Icon name="arrow" size={14} />
            </button>
          </div>
          <div className="aging-summary">
            <div className="aging-total">
              <span>Total outstanding</span>
              <strong>{formatMoney(dashboard.metrics.outstanding)}</strong>
              <small>as of {dateLabel(dashboard.reportingDate, dashboard.entity.currency)}</small>
            </div>
            <div className="aging-legend">
              <span>
                <i className="dot current" /> Current
              </span>
              <span>
                <i className="dot warning" /> 1–30 days
              </span>
              <span>
                <i className="dot danger" /> 31+ days
              </span>
            </div>
          </div>
          <div className="aging-bars">
            {dashboard.aging.length ? (
              dashboard.aging.slice(0, 5).map((row) => (
                <div className="aging-row" key={`${row.customerId}-${row.currency}`}>
                  <div className="aging-customer">
                    <span className="customer-avatar">{initials(row.customerName)}</span>
                    <span>{row.customerName}</span>
                  </div>
                  <div className="stacked-bar">
                    <span
                      className="bar-current"
                      style={{
                        width: `${Math.max(5, (Number(row.current.minor) / maxAging) * 100)}%`,
                      }}
                    />
                    <span
                      className="bar-warning"
                      style={{ width: `${(Number(row.overdue1to30.minor) / maxAging) * 100}%` }}
                    />
                    <span
                      className="bar-danger"
                      style={{ width: `${(Number(overdueMinor(row)) / maxAging) * 100}%` }}
                    />
                  </div>
                  <strong>{formatMoney(row.total)}</strong>
                </div>
              ))
            ) : (
              <EmptyState
                title="No outstanding receivables"
                description="Create an invoice to start tracking collections."
                action={canMutate ? "New invoice" : undefined}
                onAction={onCreate}
              />
            )}
          </div>
        </section>
        <section className="card attention-card">
          <div className="section-heading">
            <div>
              <h2>Needs attention</h2>
              <p>Review before posting to your books</p>
            </div>
            <button
              className="round-arrow"
              onClick={() => onNavigate("reconcile")}
              aria-label="Review queue"
            >
              <Icon name="arrow" size={15} />
            </button>
          </div>
          <div className="attention-list">
            <AttentionItem
              icon="spark"
              tone="purple"
              title={`${dashboard.metrics.needsReview} bank transactions`}
              detail="Waiting in your review queue"
              action="Review"
              onClick={() => onNavigate("reconcile")}
            />
            <AttentionItem
              icon="!"
              tone="coral"
              title={`${overdueCount} overdue invoice${overdueCount === 1 ? "" : "s"}`}
              detail={`${formatMoney(dashboard.metrics.overdue)} outstanding`}
              action="View"
              onClick={() => onNavigate("invoices")}
            />
            <AttentionItem
              icon="users"
              tone="amber"
              title="Customer follow-up"
              detail={
                dashboard.aging.find((row) => overdueMinor(row) > 0n)?.customerName ??
                "No overdue customer"
              }
              action="Open"
              onClick={() => onNavigate("customers")}
            />
          </div>
          <button className="full-link" onClick={() => onNavigate("reconcile")}>
            See all activity <Icon name="arrow" size={14} />
          </button>
        </section>
      </div>
      <div className="bottom-grid">
        <section className="card activity-card">
          <div className="section-heading">
            <div>
              <h2>Recent activity</h2>
              <p>A live view of changes in your books</p>
            </div>
            <button className="link-button" onClick={() => onNavigate("ledger")}>
              Open ledger <Icon name="arrow" size={14} />
            </button>
          </div>
          <div className="activity-list">
            {dashboard.recentTransactions.slice(0, 5).map((transaction) => (
              <div className="activity-row" key={transaction.id}>
                <span
                  className={`activity-icon ${transaction.flow === "inflow" ? "inflow" : "outflow"}`}
                >
                  {transaction.flow === "inflow" ? "↓" : "↑"}
                </span>
                <div className="activity-copy">
                  <strong>{transaction.description}</strong>
                  <span>
                    {transaction.status === "posted" ? "Posted to ledger" : "Awaiting review"} ·{" "}
                    {dateLabel(transaction.date, dashboard.entity.currency, "short")}
                  </span>
                </div>
                <b className={transaction.flow === "inflow" ? "positive" : "negative"}>
                  {transaction.flow === "inflow" ? "+" : "−"}
                  {formatMoney(transaction.amount)}
                </b>
                <span className={`status-pill ${transaction.status}`}>
                  {transaction.status === "posted" ? "Posted" : "Review"}
                </span>
              </div>
            ))}
          </div>
        </section>
        <section className="card quick-card">
          <div className="quick-gradient">
            <span className="quick-badge">
              <Icon name="spark" size={14} /> LedgerFlow intelligence
            </span>
            <h2>
              Reconcile faster
              <br />
              <em>with confidence.</em>
            </h2>
            <p>
              Our rules engine found{" "}
              {dashboard.metrics.needsReview > 0 ? "high-confidence matches" : "no exceptions"} in
              your latest bank activity.
            </p>
            <button className="button dark" onClick={() => onNavigate("reconcile")}>
              Open review queue <Icon name="arrow" size={14} />
            </button>
          </div>
        </section>
      </div>
    </>
  );
}

function MetricCard({
  label,
  value,
  sub,
  tone,
  icon,
  action,
}: {
  label: string;
  value: string;
  sub: string;
  tone: string;
  icon: string;
  action?: () => void;
}) {
  return (
    <button className={`metric-card ${tone}`} onClick={action} disabled={!action}>
      <div className="metric-top">
        <span>{label}</span>
        <i>{icon}</i>
      </div>
      <strong>{value}</strong>
      <small>{sub}</small>
    </button>
  );
}
function AttentionItem({
  icon,
  tone,
  title,
  detail,
  action,
  onClick,
}: {
  icon: string;
  tone: string;
  title: string;
  detail: string;
  action: string;
  onClick: () => void;
}) {
  return (
    <div className="attention-item">
      <span className={`attention-icon ${tone}`}>
        {icon === "users" ? <Icon name="users" size={15} /> : icon}
      </span>
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      <button onClick={onClick}>
        {action} <Icon name="arrow" size={13} />
      </button>
    </div>
  );
}
function EmptyState({
  title,
  description,
  action,
  onAction,
}: {
  title: string;
  description: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name="file" size={22} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action && onAction && (
        <button className="button secondary small" onClick={onAction}>
          <Icon name="plus" size={14} />
          {action}
        </button>
      )}
    </div>
  );
}

function Reconcile({
  dashboard,
  query,
  working,
  selectedId,
  onSelect,
  onAction,
  onImport,
  canMutate,
}: {
  dashboard: Dashboard;
  query: string;
  working: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAction: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  onImport?: () => void;
  canMutate: boolean;
}) {
  const [tab, setTab] = useState<"review" | "posted" | "excluded">("review");
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const rows = dashboard.transactions
    .filter((transaction) =>
      tab === "review"
        ? transaction.status === "suggested" || transaction.status === "unreviewed"
        : tab === "posted"
          ? transaction.status === "posted"
          : transaction.status === "excluded",
    )
    .filter((transaction) =>
      `${transaction.description} ${transaction.reference} ${transaction.counterparty ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .map((transaction) => ({
      transaction,
      ...dashboard.reviewQueue.find((item) => item.transaction.id === transaction.id),
    }));
  const visibleIds = rows.map((row) => row.transaction.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedRows.has(id));
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">Cash application</div>
          <h1>Reconcile transactions</h1>
          <p>Turn bank activity into accurate, approved ledger entries.</p>
        </div>
        {canMutate && (
          <div className="heading-actions">
            <button className="button secondary" onClick={onImport}>
              <Icon name="upload" size={16} /> Import CSV
            </button>
            <button
              className="button primary"
              onClick={() =>
                onAction("Auto-applied confident matches", async () => {
                  for (const item of dashboard.reviewQueue.filter(
                    (entry) =>
                      (entry.match?.confidence ?? 0) >=
                      dashboard.entity.settings.autoApplyThreshold,
                  ))
                    await requestJson(`/api/reconcile/${item.transaction.id}/approve`, {
                      method: "POST",
                      body: JSON.stringify({ mode: "suggestion" }),
                    });
                })
              }
              disabled={working !== null}
            >
              <Icon name="spark" size={16} /> Approve confident
            </button>
          </div>
        )}
      </div>
      <div className="reconcile-summary">
        <div>
          <span className="summary-dot purple" />
          <strong>{dashboard.metrics.needsReview}</strong>
          <span>Need review</span>
        </div>
        <div>
          <span className="summary-dot green" />
          <strong>
            {dashboard.transactions.filter((item) => item.status === "posted").length}
          </strong>
          <span>Posted this period</span>
        </div>
        <div>
          <span className="summary-dot gray" />
          <strong>
            {dashboard.transactions.filter((item) => item.status === "unreviewed").length}
          </strong>
          <span>Unidentified</span>
        </div>
        <div className="reconcile-note">
          <Icon name="check" size={15} /> Every posted entry is balanced automatically
        </div>
      </div>
      <section className="card table-card">
        <div className="table-toolbar">
          <div className="tabs">
            <button className={tab === "review" ? "selected" : ""} onClick={() => setTab("review")}>
              Needs review <b>{dashboard.metrics.needsReview}</b>
            </button>
            <button className={tab === "posted" ? "selected" : ""} onClick={() => setTab("posted")}>
              Posted
            </button>
            <button
              className={tab === "excluded" ? "selected" : ""}
              onClick={() => setTab("excluded")}
            >
              Excluded
            </button>
          </div>
          <div className="toolbar-right">
            <button className="filter-button">
              <Icon name="filter" size={15} /> Filters
            </button>
            <button className="icon-button">
              <Icon name="more" />
            </button>
          </div>
        </div>
        {rows.length ? (
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={allSelected}
                      onChange={(event) =>
                        setSelectedRows((current) => {
                          const next = new Set(current);
                          visibleIds.forEach((id) =>
                            event.target.checked ? next.add(id) : next.delete(id),
                          );
                          return next;
                        })
                      }
                    />
                  </th>
                  <th>Date</th>
                  <th>Counterparty / memo</th>
                  <th>Amount</th>
                  <th>Suggested match</th>
                  <th>Confidence</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <TransactionRow
                    key={row.transaction.id}
                    row={row}
                    currency={dashboard.entity.currency}
                    selected={selectedId === row.transaction.id}
                    checked={selectedRows.has(row.transaction.id)}
                    onToggle={(checked) =>
                      setSelectedRows((current) => {
                        const next = new Set(current);
                        if (checked) next.add(row.transaction.id);
                        else next.delete(row.transaction.id);
                        return next;
                      })
                    }
                    onSelect={onSelect}
                    onAction={onAction}
                    canMutate={canMutate}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={tab === "review" ? "You’re all caught up" : "No transactions here"}
            description={
              tab === "review"
                ? "Import a statement or connect a bank feed to keep going."
                : "Transactions will appear here as they are resolved."
            }
            action={canMutate ? "Import CSV" : undefined}
            onAction={onImport}
          />
        )}
      </section>
    </>
  );
}

function TransactionRow({
  row,
  currency,
  selected,
  checked,
  onToggle,
  onSelect,
  onAction,
  canMutate,
}: {
  row: { transaction: Transaction; match?: Match; invoice?: Invoice; customer?: Customer };
  currency: string;
  selected: boolean;
  checked: boolean;
  onToggle: (checked: boolean) => void;
  onSelect: (id: string) => void;
  onAction: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  canMutate: boolean;
}) {
  const transaction = row.transaction;
  const suggested = row.invoice
    ? `${row.invoice.number} · ${row.customer?.name ?? "Customer"}`
    : row.match?.suggestedAccountId
      ? "Suggested category"
      : "No confident match";
  return (
    <tr
      className={selected ? "selected-row" : ""}
      tabIndex={0}
      aria-selected={selected}
      onClick={() => onSelect(transaction.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(transaction.id);
        }
      }}
    >
      <td>
        <input
          type="checkbox"
          checked={checked}
          aria-label={`Select ${transaction.description}`}
          onChange={(event) => onToggle(event.target.checked)}
          onClick={(event) => event.stopPropagation()}
        />
      </td>
      <td className="muted-cell">{dateLabel(transaction.date, currency, "short")}</td>
      <td>
        <div className="table-party">
          <span className={`mini-party ${transaction.flow}`}>
            {transaction.flow === "inflow" ? "↓" : "↑"}
          </span>
          <div>
            <strong>{transaction.counterparty || transaction.description}</strong>
            <span>{transaction.reference || transaction.description}</span>
          </div>
        </div>
      </td>
      <td>
        <strong className={transaction.flow === "inflow" ? "positive" : "negative"}>
          {transaction.flow === "inflow" ? "+" : "−"}
          {formatMoney(transaction.amount)}
        </strong>
      </td>
      <td>
        <div className="suggested-cell">
          <strong>{suggested}</strong>
          <span>{row.match?.rationale?.[0] ?? "Needs a decision"}</span>
        </div>
      </td>
      <td>
        <Confidence value={row.match?.confidence ?? 0} />
      </td>
      <td>
        <span className={`status-pill ${transaction.status}`}>
          {transaction.status === "suggested" ? "Suggested" : statusLabel(transaction.status)}
        </span>
      </td>
      <td>
        {canMutate && (
          <button
            className="row-action"
            onClick={(event) => {
              event.stopPropagation();
              if (transaction.status !== "posted" && (row.invoice || row.match?.suggestedAccountId))
                void onAction("Transaction approved", () =>
                  requestJson(`/api/reconcile/${transaction.id}/approve`, {
                    method: "POST",
                    body: JSON.stringify({ mode: "suggestion" }),
                  }),
                );
              else if (transaction.status !== "posted") onSelect(transaction.id);
            }}
            aria-label="Approve transaction"
          >
            <Icon
              name={
                transaction.status === "posted"
                  ? "check"
                  : row.invoice || row.match?.suggestedAccountId
                    ? "arrow"
                    : "search"
              }
              size={16}
            />
          </button>
        )}
      </td>
    </tr>
  );
}
function Confidence({ value }: { value: number }) {
  const percent = Math.round(value * 100);
  return (
    <span className={`confidence ${percent >= 90 ? "high" : percent >= 70 ? "medium" : "low"}`}>
      <i style={{ width: `${percent}%` }} />
      <b>{percent ? `${percent}%` : "—"}</b>
    </span>
  );
}

function ReviewDrawer({
  item,
  accounts,
  currency,
  onClose,
  onAction,
  working,
  canMutate,
}: {
  item: { transaction: Transaction; match?: Match; invoice?: Invoice; customer?: Customer };
  accounts: Account[];
  currency: string;
  onClose: () => void;
  onAction: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  working: string | null;
  canMutate: boolean;
}) {
  const { transaction, match, invoice, customer } = item;
  const [accountId, setAccountId] = useState(
    match?.suggestedAccountId ?? (transaction.flow === "inflow" ? "acct_unapplied" : ""),
  );
  const selectedAccount = accounts.find((account) => account.id === accountId);
  const needsCategory = !invoice || transaction.flow === "outflow";
  const canPost = !needsCategory || Boolean(accountId);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="review-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="transaction-review-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="drawer-header">
          <div>
            <span className="eyebrow">Transaction review</span>
            <h2 id="transaction-review-title">
              {transaction.counterparty || transaction.description}
            </h2>
            <span className="drawer-reference">
              {transaction.reference || "No reference"} · {dateLabel(transaction.date, currency)}
            </span>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="drawer-amount">
          <span>{transaction.flow === "inflow" ? "Money received" : "Money spent"}</span>
          <strong className={transaction.flow === "inflow" ? "positive" : "negative"}>
            {transaction.flow === "inflow" ? "+" : "−"}
            {formatMoney(transaction.amount)}
          </strong>
        </div>
        <div className="drawer-section">
          <span className="drawer-label">LedgerFlow suggestion</span>
          {invoice ? (
            <div className="match-card">
              <div className="match-card-top">
                <span className="invoice-symbol">
                  <Icon name="file" size={16} />
                </span>
                <div>
                  <strong>{invoice.number}</strong>
                  <span>{customer?.name}</span>
                </div>
                <Confidence value={match?.confidence ?? 0} />
              </div>
              <div className="match-reason">
                <Icon name="spark" size={14} />
                <span>{match?.rationale?.join(" · ")}</span>
              </div>
              <div className="match-amount">
                <span>Applied amount</span>
                <strong>{formatMoney(match?.allocations[0]?.amount ?? invoice.total)}</strong>
              </div>
            </div>
          ) : (
            <div className="unmatched-card">
              <span className="attention-icon amber">!</span>
              <div>
                <strong>
                  {match?.suggestedAccountId ? "Suggested category" : "No confident match"}
                </strong>
                <span>
                  {match?.rationale?.[0] ?? "Search for an invoice or categorize this transaction."}
                </span>
              </div>
            </div>
          )}
        </div>
        {canMutate && needsCategory && transaction.status !== "posted" && (
          <div className="drawer-section">
            <label className="drawer-label" htmlFor="posting-account">
              Post to account
            </label>
            <select
              id="posting-account"
              className="drawer-select"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              <option value="">Choose an account…</option>
              {accounts
                .filter((account) => account.control !== "bank")
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.code} · {account.name}
                  </option>
                ))}
            </select>
            <small className="drawer-help">
              Choose the offset account. The bank side is created automatically.
            </small>
          </div>
        )}
        {match?.allocations && match.allocations.length > 1 && (
          <div className="drawer-section">
            <span className="drawer-label">Split allocation</span>
            {match.allocations.map((allocation) => (
              <div className="allocation-row" key={allocation.invoiceId}>
                <span>{allocation.invoiceId}</span>
                <strong>{formatMoney(allocation.amount)}</strong>
              </div>
            ))}
          </div>
        )}
        <div className="drawer-section">
          <span className="drawer-label">Posting preview</span>
          <div className="posting-preview">
            <div>
              <span>
                {transaction.flow === "inflow"
                  ? "Operating Bank"
                  : (selectedAccount?.name ?? "Expense account")}
              </span>
              <strong>{formatMoney(transaction.amount)}</strong>
            </div>
            <div>
              <span>
                {transaction.flow === "inflow"
                  ? invoice
                    ? "Accounts Receivable"
                    : (selectedAccount?.name ?? "Unapplied customer cash")
                  : "Operating Bank"}
              </span>
              <strong>{formatMoney(transaction.amount)}</strong>
            </div>
            <small>
              <Icon name="check" size={13} /> Debits and credits will balance
            </small>
          </div>
        </div>
        <div className="drawer-footer">
          {!canMutate ? (
            <div className="read-only-note">
              <Icon name="book" size={15} /> Viewer access is read-only.
            </div>
          ) : transaction.status === "posted" ? (
            <button
              className="button secondary full"
              onClick={() =>
                onAction("Payment reversed", () =>
                  requestJson(`/api/reconcile/${transaction.id}/undo`, { method: "POST" }),
                )
              }
              disabled={working !== null}
            >
              <Icon name="undo" size={15} /> Undo posting
            </button>
          ) : (
            <>
              <button
                className="button quiet"
                onClick={() =>
                  onAction("Transaction excluded", () =>
                    requestJson(`/api/reconcile/${transaction.id}/exclude`, {
                      method: "POST",
                      body: JSON.stringify({ reason: "Excluded during review" }),
                    }),
                  )
                }
                disabled={working !== null || !canPost}
              >
                Exclude
              </button>
              <button
                className="button primary full"
                onClick={() =>
                  onAction(invoice ? "Transaction approved" : "Transaction categorized", () =>
                    requestJson(`/api/reconcile/${transaction.id}/approve`, {
                      method: "POST",
                      body: JSON.stringify(
                        needsCategory ? { mode: "category", accountId } : { mode: "suggestion" },
                      ),
                    }),
                  )
                }
                disabled={working !== null}
              >
                <Icon name="check" size={15} /> {invoice ? "Approve & post" : "Categorize & post"}
              </button>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

function Invoices({
  dashboard,
  query,
  onCreate,
  canMutate,
}: {
  dashboard: Dashboard;
  query: string;
  onCreate?: () => void;
  canMutate: boolean;
}) {
  const [filter, setFilter] = useState("all");
  const invoices = dashboard.invoices.filter(
    (invoice) =>
      (filter === "all" || invoice.status === filter) &&
      `${invoice.number} ${dashboard.customers.find((customer) => customer.id === invoice.customerId)?.name ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">Accounts receivable</div>
          <h1>Invoices</h1>
          <p>Track what’s been billed, collected, and what’s next.</p>
        </div>
        <div className="heading-actions">
          <button
            className="button secondary"
            onClick={() =>
              downloadCsv(
                "ledgerflow-invoices.csv",
                ["Invoice", "Customer", "Issue date", "Due date", "Amount", "Status"],
                invoices.map((invoice) => [
                  invoice.number,
                  dashboard.customers.find((customer) => customer.id === invoice.customerId)
                    ?.name ?? "",
                  invoice.issueDate,
                  invoice.dueDate,
                  formatMoney(invoice.total),
                  statusLabel(invoice.status),
                ]),
              )
            }
          >
            <Icon name="download" size={16} /> Export
          </button>
          {canMutate && (
            <button className="button primary" onClick={onCreate}>
              <Icon name="plus" size={16} /> New invoice
            </button>
          )}
        </div>
      </div>
      <div className="mini-metric-row">
        <MiniMetric
          label="Total invoiced"
          value={formatMoney(
            dashboard.invoices
              .reduce((sum, invoice) => sum + BigInt(invoice.total.minor), 0n)
              .toString()
              ? {
                  currency: dashboard.entity.currency,
                  minor: dashboard.invoices
                    .reduce((sum, invoice) => sum + BigInt(invoice.total.minor), 0n)
                    .toString(),
                }
              : undefined,
          )}
        />
        <MiniMetric
          label="Open invoices"
          value={String(dashboard.invoices.filter((invoice) => invoice.status !== "paid").length)}
        />
        <MiniMetric label="Paid on time" value="92%" />
        <MiniMetric label="Avg. days to pay" value="18 days" />
      </div>
      <section className="card table-card">
        <div className="table-toolbar">
          <div className="tabs invoice-tabs">
            {["all", "issued", "partial", "paid", "overdue"].map((item) => (
              <button
                key={item}
                className={filter === item ? "selected" : ""}
                onClick={() => setFilter(item)}
              >
                {item === "all" ? "All invoices" : statusLabel(item)}
              </button>
            ))}
          </div>
          <div className="toolbar-right">
            <button className="filter-button">
              <Icon name="filter" size={15} /> Filters
            </button>
          </div>
        </div>
        {invoices.length ? (
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Customer</th>
                  <th>Issue date</th>
                  <th>Due date</th>
                  <th>Amount</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => {
                  const customer = dashboard.customers.find(
                    (item) => item.id === invoice.customerId,
                  );
                  return (
                    <tr key={invoice.id}>
                      <td>
                        <div className="invoice-number">
                          <span className="invoice-symbol">
                            <Icon name="file" size={15} />
                          </span>
                          <strong>{invoice.number}</strong>
                        </div>
                      </td>
                      <td>
                        <div className="table-party">
                          <span className="mini-party neutral">
                            {initials(customer?.name ?? "?")}
                          </span>
                          <div>
                            <strong>{customer?.name ?? "Unknown customer"}</strong>
                            <span>{customer?.email}</span>
                          </div>
                        </div>
                      </td>
                      <td className="muted-cell">
                        {dateLabel(invoice.issueDate, dashboard.entity.currency)}
                      </td>
                      <td className={invoice.status === "overdue" ? "danger-cell" : "muted-cell"}>
                        {dateLabel(invoice.dueDate, dashboard.entity.currency)}
                      </td>
                      <td>
                        <strong>{formatMoney(invoice.total)}</strong>
                      </td>
                      <td>
                        <span className={`status-pill ${invoice.status}`}>
                          {statusLabel(invoice.status)}
                        </span>
                      </td>
                      <td>
                        <button className="row-action">
                          <Icon name="chevron" size={16} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No invoices match"
            description="Try clearing your filters or create a new invoice."
            action={canMutate ? "New invoice" : undefined}
            onAction={onCreate}
          />
        )}
      </section>
    </>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="mini-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function Customers({
  dashboard,
  query,
  onCreate,
  canMutate,
}: {
  dashboard: Dashboard;
  query: string;
  onCreate?: () => void;
  canMutate: boolean;
}) {
  const visible = dashboard.customers.filter((customer) =>
    `${customer.name} ${customer.email} ${customer.company ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">Relationships</div>
          <h1>Customers</h1>
          <p>See who owes you, what’s overdue, and what happened last.</p>
        </div>
        {canMutate && (
          <button className="button primary" onClick={onCreate}>
            <Icon name="plus" size={16} /> Add customer
          </button>
        )}
      </div>
      <div className="customer-grid">
        {visible.map((customer) => {
          const invoices = dashboard.invoices.filter(
            (invoice) => invoice.customerId === customer.id,
          );
          const openInvoices = invoices.filter((invoice) =>
            ["issued", "partial", "overdue"].includes(invoice.status),
          );
          const outstanding = openInvoices.reduce(
            (sum, invoice) => sum + BigInt(invoice.outstanding?.minor ?? invoice.total.minor),
            0n,
          );
          return (
            <div className="customer-card card" key={customer.id}>
              <div className="customer-card-head">
                <span className="large-avatar">{initials(customer.name)}</span>
                <button className="icon-button">
                  <Icon name="more" />
                </button>
              </div>
              <h3>{customer.name}</h3>
              <p>{customer.email}</p>
              <div className="customer-stat">
                <div>
                  <span>Outstanding</span>
                  <strong>
                    {formatMoney({
                      currency: dashboard.entity.currency,
                      minor: outstanding.toString(),
                    })}
                  </strong>
                </div>
                <div>
                  <span>Open invoices</span>
                  <strong>{openInvoices.length}</strong>
                </div>
              </div>
              <div className="customer-card-foot">
                <span>
                  Last activity{" "}
                  {invoices[0]
                    ? dateLabel(invoices[0].issueDate, dashboard.entity.currency, "short")
                    : "—"}
                </span>
                <button>
                  View profile <Icon name="arrow" size={13} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {!visible.length && (
        <section className="card">
          <EmptyState
            title="No customers match"
            description="Try another search or add a new customer."
            action={canMutate ? "Add customer" : undefined}
            onAction={onCreate}
          />
        </section>
      )}
    </>
  );
}

function Ledger({
  entries,
  currency,
  loading,
  error,
  onRetry,
}: {
  entries: LedgerEntry[];
  currency: string;
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  if (loading)
    return (
      <div className="card report-loading">
        <div className="loader-mark small">LF</div>
        <p>Loading your journal…</p>
      </div>
    );
  if (error)
    return (
      <div className="card error-state">
        <div className="empty-icon">
          <Icon name="close" size={22} />
        </div>
        <h3>Unable to load the ledger</h3>
        <p>{error}</p>
        <button className="button secondary small" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  const balanced = entries.every((entry) => {
    const debit = entry.lines
      .filter((line) => line.side === "debit")
      .reduce((sum, line) => sum + BigInt(line.amount.minor), 0n);
    const credit = entry.lines
      .filter((line) => line.side === "credit")
      .reduce((sum, line) => sum + BigInt(line.amount.minor), 0n);
    return debit === credit;
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">Double-entry journal</div>
          <h1>Ledger</h1>
          <p>Immutable, balanced entries for every business event.</p>
        </div>
        <div className="heading-actions">
          <button
            className="button secondary"
            onClick={() =>
              downloadCsv(
                "ledgerflow-ledger.csv",
                ["Date", "Entry", "Description", "Account", "Side", "Amount"],
                entries.flatMap((entry) =>
                  entry.lines.map((line) => [
                    entry.date,
                    entry.id,
                    entry.description,
                    line.accountId,
                    line.side,
                    formatMoney(line.amount),
                  ]),
                ),
              )
            }
          >
            <Icon name="download" size={16} /> Export CSV
          </button>
        </div>
      </div>
      <div className={`ledger-integrity ${balanced ? "" : "ledger-warning"}`}>
        <div className="integrity-icon">
          <Icon name={balanced ? "check" : "close"} size={17} />
        </div>
        <div>
          <strong>{balanced ? "Your ledger is balanced" : "Ledger requires attention"}</strong>
          <span>
            {balanced
              ? "Every posted journal entry satisfies the debit = credit invariant."
              : "One or more journal entries do not balance."}
          </span>
        </div>
        <span className="integrity-date">Last checked just now</span>
      </div>
      <section className="card table-card">
        <div className="table-toolbar">
          <div>
            <h2 className="toolbar-title">Journal entries</h2>
            <span className="toolbar-subtitle">
              {entries.length} entries · {currency} · All time
            </span>
          </div>
          <div className="toolbar-right">
            <button className="filter-button">
              <Icon name="filter" size={15} /> This month
            </button>
          </div>
        </div>
        {entries.length ? (
          <div className="ledger-list">
            {entries.map((entry) => (
              <div className="ledger-entry" key={entry.id}>
                <div className="ledger-date">
                  <strong>{dateLabel(entry.date, currency, "short")}</strong>
                  <span>{entry.source.replace("bank-reconciliation", "reconciliation")}</span>
                </div>
                <div className="ledger-description">
                  <strong>{entry.description}</strong>
                  <span>
                    {entry.id} · {entry.lines.length} lines
                  </span>
                </div>
                <div className="ledger-lines">
                  {entry.lines.map((line) => (
                    <div key={line.accountId + line.side}>
                      <span>
                        {line.side === "debit" ? "Dr" : "Cr"} · {line.accountId}
                      </span>
                      <strong>{formatMoney(line.amount)}</strong>
                    </div>
                  ))}
                </div>
                <button className="row-action">
                  <Icon name="chevron" size={16} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No ledger activity"
            description="Posted invoices, payments, and adjustments will appear here."
            action="Create invoice"
            onAction={() => undefined}
          />
        )}
      </section>
    </>
  );
}

function ReportsView({
  reports,
  currency,
  loading,
  error,
  onRetry,
}: {
  reports: Reports | null;
  currency: string;
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  const [tab, setTab] = useState<"aging" | "trial" | "pnl">("aging");
  if (loading)
    return (
      <div className="card report-loading">
        <div className="loader-mark small">LF</div>
        <p>Building reports from your journal…</p>
      </div>
    );
  if (error || !reports)
    return (
      <div className="card error-state">
        <div className="empty-icon">
          <Icon name="close" size={22} />
        </div>
        <h3>Unable to build reports</h3>
        <p>{error || "No report data is available yet."}</p>
        <button className="button secondary small" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">Financial intelligence</div>
          <h1>Reports</h1>
          <p>Everything is calculated directly from posted journal lines.</p>
        </div>
        <button
          className="button secondary"
          onClick={() =>
            downloadCsv(
              `ledgerflow-${tab}.csv`,
              tab === "aging"
                ? ["Customer", "Current", "1-30", "31-60", "61-90", "90+", "Total"]
                : tab === "trial"
                  ? ["Account", "Type", "Debits", "Credits", "Balance"]
                  : ["Metric", "Amount"],
              tab === "aging"
                ? reports.aging.map((row) => [
                    row.customerName,
                    formatMoney(row.current),
                    formatMoney(row.overdue1to30),
                    formatMoney(row.overdue31to60),
                    formatMoney(row.overdue61to90),
                    formatMoney(row.overdue90Plus),
                    formatMoney(row.total),
                  ])
                : tab === "trial"
                  ? reports.trialBalance.map((row) => [
                      `${row.accountCode} · ${row.accountName}`,
                      row.accountType,
                      formatMoney(row.debit),
                      formatMoney(row.credit),
                      formatMoney(row.balance),
                    ])
                  : [
                      ["Income", formatMoney(reports.pnl.incomeTotal)],
                      ["Expenses", formatMoney(reports.pnl.expenseTotal)],
                      ["Net profit", formatMoney(reports.pnl.net)],
                    ],
            )
          }
        >
          <Icon name="download" size={16} /> Export report
        </button>
      </div>
      <div className="report-kpis">
        <div className="report-kpi">
          <span>Net receivables</span>
          <strong>
            {formatMoney(
              reports.aging.reduce((sum, row) => sum + BigInt(row.total.minor), 0n).toString()
                ? {
                    currency,
                    minor: reports.aging
                      .reduce((sum, row) => sum + BigInt(row.total.minor), 0n)
                      .toString(),
                  }
                : undefined,
            )}
          </strong>
          <small>Accounts receivable aging</small>
        </div>
        <div className="report-kpi">
          <span>Revenue this period</span>
          <strong>{formatMoney(reports.pnl.incomeTotal)}</strong>
          <small>Recognized income</small>
        </div>
        <div className="report-kpi">
          <span>Net profit</span>
          <strong className="positive">{formatMoney(reports.pnl.net)}</strong>
          <small>Income less expenses</small>
        </div>
        <div className="report-kpi">
          <span>Balance sheet check</span>
          {reports.balanceSheet.difference.minor === "0" ? (
            <strong className="positive">
              <Icon name="check" size={18} /> Balanced
            </strong>
          ) : (
            <strong className="negative">
              <Icon name="close" size={18} /> Out of balance
            </strong>
          )}
          <small>As of {dateLabel(reports.asOf, currency)}</small>
        </div>
      </div>
      <section className="card table-card">
        <div className="report-tabs">
          <button className={tab === "aging" ? "active" : ""} onClick={() => setTab("aging")}>
            A/R aging
          </button>
          <button className={tab === "trial" ? "active" : ""} onClick={() => setTab("trial")}>
            Trial balance
          </button>
          <button className={tab === "pnl" ? "active" : ""} onClick={() => setTab("pnl")}>
            Profit & loss
          </button>
        </div>
        {tab === "aging" && (
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Current</th>
                  <th>1–30 days</th>
                  <th>31–60 days</th>
                  <th>61–90 days</th>
                  <th>90+ days</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {reports.aging.map((row) => (
                  <tr key={row.customerId}>
                    <td>
                      <strong>{row.customerName}</strong>
                    </td>
                    <td>{formatMoney(row.current)}</td>
                    <td
                      className={
                        BigInt(row.overdue1to30.minor) > 0n ? "warning-cell" : "muted-cell"
                      }
                    >
                      {formatMoney(row.overdue1to30)}
                    </td>
                    <td
                      className={
                        BigInt(row.overdue31to60.minor) > 0n ? "danger-cell" : "muted-cell"
                      }
                    >
                      {formatMoney(row.overdue31to60)}
                    </td>
                    <td className="muted-cell">{formatMoney(row.overdue61to90)}</td>
                    <td className="muted-cell">{formatMoney(row.overdue90Plus)}</td>
                    <td>
                      <strong>{formatMoney(row.total)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tab === "trial" && (
          <div className="responsive-table">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Type</th>
                  <th>Debits</th>
                  <th>Credits</th>
                  <th>Balance</th>
                </tr>
              </thead>
              <tbody>
                {reports.trialBalance.map((row) => (
                  <tr key={row.accountCode}>
                    <td>
                      <strong>
                        {row.accountCode} · {row.accountName}
                      </strong>
                    </td>
                    <td>
                      <span className="type-label">{row.accountType}</span>
                    </td>
                    <td>{formatMoney(row.debit)}</td>
                    <td>{formatMoney(row.credit)}</td>
                    <td>
                      <strong>{formatMoney(row.balance)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {tab === "pnl" && (
          <div className="pnl-report">
            <div>
              <span>Income</span>
              <strong>{formatMoney(reports.pnl.incomeTotal)}</strong>
            </div>
            <div>
              <span>Expenses</span>
              <strong>{formatMoney(reports.pnl.expenseTotal)}</strong>
            </div>
            <div className="pnl-total">
              <span>Net profit</span>
              <strong>{formatMoney(reports.pnl.net)}</strong>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

export function Settings({
  dashboard,
  onSaved,
  onError,
  canEdit,
}: {
  dashboard: Dashboard;
  onSaved: () => void;
  onError: (message: string) => void;
  canEdit: boolean;
}) {
  const [threshold, setThreshold] = useState(
    String(Math.round(dashboard.entity.settings.autoApplyThreshold * 100)),
  );
  const [provider, setProvider] = useState(dashboard.entity.settings.aiProvider);
  const [name, setName] = useState(dashboard.entity.name);
  const [legalName, setLegalName] = useState(dashboard.entity.legalName);
  const [currency, setCurrency] = useState(dashboard.entity.currency);
  const [timezone, setTimezone] = useState(dashboard.entity.timezone);
  const [feeToleranceMinor, setFeeToleranceMinor] = useState(
    dashboard.entity.settings.feeToleranceMinor,
  );
  const [saving, setSaving] = useState(false);
  const currencyLocked = !dashboard.currencyChangeAllowed;
  const selectedCurrency = currencyLocked ? dashboard.entity.currency : currency;
  const save = async () => {
    setSaving(true);
    onError("");
    try {
      await requestJson("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          name,
          legalName,
          currency: selectedCurrency,
          timezone,
          autoApplyThreshold: Number(threshold) / 100,
          feeToleranceMinor,
          aiProvider: provider,
        }),
      });
      onSaved();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">Workspace administration</div>
          <h1>Settings</h1>
          <p>Make LedgerFlow fit the way your team closes the books.</p>
        </div>
        {canEdit && (
          <button className="button primary" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        )}
      </div>
      <div className="settings-layout">
        <nav className="settings-nav">
          <button className="selected">Workspace</button>
          <button>Reconciliation</button>
          <button>AI & automation</button>
          <button>Team & permissions</button>
          <button>Integrations</button>
          <button>Audit log</button>
        </nav>
        <div className="settings-content">
          <section className="settings-section">
            <div className="settings-title">
              <h2>Workspace profile</h2>
              <p>Basic information used across your financial reports.</p>
            </div>
            <div className="settings-form">
              <label>
                Workspace name
                <input
                  disabled={!canEdit}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Legal name
                <input
                  disabled={!canEdit}
                  value={legalName}
                  onChange={(event) => setLegalName(event.target.value)}
                />
              </label>
              <div className="form-row">
                <label>
                  Base currency
                  <select
                    disabled={!canEdit || currencyLocked}
                    value={selectedCurrency}
                    aria-describedby={currencyLocked ? "currency-lock-hint" : undefined}
                    onChange={(event) => setCurrency(event.target.value)}
                  >
                    {supportedCurrencies.map((code) => (
                      <option key={code} value={code}>
                        {code} — {currencyMeta(code).name}
                      </option>
                    ))}
                  </select>
                  {currencyLocked && (
                    <small id="currency-lock-hint">
                      Base currency is locked once invoices, bank transactions, journal entries, or
                      matches exist.
                    </small>
                  )}
                </label>
                <label>
                  Timezone
                  <select
                    disabled={!canEdit}
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                  >
                    <option value="Asia/Kolkata">Asia/Kolkata</option>
                    <option value="America/New_York">America/New_York</option>
                    <option value="America/Los_Angeles">America/Los_Angeles</option>
                    <option value="UTC">UTC</option>
                  </select>
                  <small>
                    Sets the reporting day. Invoice, transaction, and journal dates keep their
                    recorded calendar day.
                  </small>
                </label>
              </div>
            </div>
          </section>
          <section className="settings-section">
            <div className="settings-title">
              <h2>Reconciliation behavior</h2>
              <p>Control when suggested matches can be approved in bulk.</p>
            </div>
            <div className="settings-form">
              <label>
                Auto-apply confidence threshold
                <div className="range-line">
                  <input
                    type="range"
                    min="70"
                    max="100"
                    value={threshold}
                    disabled={!canEdit}
                    onChange={(event) => setThreshold(event.target.value)}
                  />
                  <output>{threshold}%</output>
                </div>
              </label>
              <label>
                Fee tolerance
                <input
                  value={feeToleranceMinor}
                  disabled={!canEdit}
                  onChange={(event) => setFeeToleranceMinor(event.target.value.replace(/\D/g, ""))}
                  inputMode="numeric"
                />
                <small>
                  Minor units. For {selectedCurrency}, 100 means{" "}
                  {formatMoney({ currency: selectedCurrency, minor: "100" })}. Payments within this
                  tolerance can be written off to Bank Fees after approval.
                </small>
              </label>
            </div>
          </section>
          <section className="settings-section">
            <div className="settings-title">
              <h2>AI provider</h2>
              <p>AI proposes; deterministic accounting rules and human approval always decide.</p>
            </div>
            <div className="provider-options">
              {[
                ["rules", "Rules engine", "Free · always available", "✦"],
                ["groq", "Groq", "Fast free-tier suggestions", "⌁"],
                ["claude", "Claude", "Best for complex memos", "◌"],
              ].map(([value, label, detail, icon]) => (
                <button
                  key={value}
                  className={`provider-option ${provider === value ? "selected" : ""}`}
                  onClick={() => setProvider(value)}
                  disabled={!canEdit}
                >
                  <span className="provider-icon">{icon}</span>
                  <span>
                    <strong>{label}</strong>
                    <small>{detail}</small>
                  </span>
                  <span className="radio-dot" />
                </button>
              ))}
            </div>
          </section>
          <div className="security-note">
            <span>
              <Icon name="check" size={17} />
            </span>
            <div>
              <strong>Financial data stays under your control</strong>
              <p>
                LedgerFlow never lets an AI provider write journal lines. Posted entries are
                immutable and every correction is a reversal.
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function ModalFrame({
  title,
  eyebrow,
  children,
  onClose,
}: {
  title: string;
  eyebrow: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2 id="modal-title">{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function InvoiceModal({
  dashboard,
  onClose,
  onCreated,
}: {
  dashboard: Dashboard;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [customerId, setCustomerId] = useState(dashboard.customers[0]?.id ?? "");
  const [description, setDescription] = useState("Professional services");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(() => invoiceDueDate(dashboard.reportingDate));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, description, amount, dueDate }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to issue invoice");
      onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to issue invoice");
    } finally {
      setSaving(false);
    }
  };
  return (
    <ModalFrame title="Create an invoice" eyebrow="Accounts receivable" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        <label>
          Customer
          <select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
            {dashboard.customers.map((customer) => (
              <option value={customer.id} key={customer.id}>
                {customer.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Line item description
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What are you billing for?"
            required
          />
        </label>
        <div className="form-row">
          <label>
            Amount ({dashboard.entity.currency}
            {dashboard.entity.currency === "INR" ? " · ₹" : ""})
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder={amountPlaceholder(dashboard.entity.currency)}
              inputMode={
                currencyMeta(dashboard.entity.currency).minorDigits ? "decimal" : "numeric"
              }
              aria-describedby="invoice-amount-hint"
              required
            />
            <small id="invoice-amount-hint">{amountPrecisionHint(dashboard.entity.currency)}</small>
          </label>
          <label>
            Due date
            <input
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
              required
            />
          </label>
        </div>
        <div className="modal-summary">
          <span>Posting preview</span>
          <strong>
            Dr Accounts Receivable
            <br />
            Cr Consulting Revenue
          </strong>
          <small>Journal entry will be created and balanced automatically.</small>
          <small>
            {dashboard.entity.currency === "INR"
              ? "INR amounts are stored as paise; 100 paise = ₹1.00."
              : `Amounts are stored in ${dashboard.entity.currency} minor units.`}
          </small>
        </div>
        <div className="modal-actions">
          <button type="button" className="button quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={saving}>
            {saving ? "Issuing…" : "Issue invoice"} <Icon name="arrow" size={15} />
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}

export function CustomerModal({
  currency,
  onClose,
  onCreated,
}: {
  currency: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, company }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Unable to add customer");
      onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to add customer");
    } finally {
      setSaving(false);
    }
  };
  return (
    <ModalFrame title="Add a customer" eyebrow="Customer directory" onClose={onClose}>
      <form className="modal-form" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-summary">
          <span>Billing currency</span>
          <strong>
            {currency} — {currencyMeta(currency).name}
          </strong>
          <small>Invoices for this customer use the workspace currency.</small>
        </div>
        <label>
          Customer name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Acme Industries"
            required
          />
        </label>
        <label>
          Company (optional)
          <input
            value={company}
            onChange={(event) => setCompany(event.target.value)}
            placeholder="Legal or trading name"
          />
        </label>
        <label>
          Accounts payable email
          <input
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            placeholder="finance@company.com"
            required
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="button quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={saving}>
            {saving ? "Adding…" : "Add customer"} <Icon name="arrow" size={15} />
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}

export function ImportModal({
  currency,
  onClose,
  onImported,
}: {
  currency: string;
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [rowErrors, setRowErrors] = useState<Array<{ row: number; message: string }>>([]);
  const [result, setResult] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving || reading) return;
    if (!file?.csv.trim()) {
      setError("Choose a CSV file with transactions before importing.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/transactions/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: file.csv }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Import failed");
      setRowErrors(data.errors ?? []);
      const message = `${data.imported} transactions imported${data.skipped ? ` · ${data.skipped} duplicates skipped` : ""}`;
      if (data.errors?.length)
        setResult(`${message} · ${data.errors.length} row(s) need attention`);
      else onImported(message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Import failed");
    } finally {
      setSaving(false);
    }
  };
  return (
    <ModalFrame
      title="Import bank transactions"
      eyebrow={`Cash application · ${currency}`}
      onClose={onClose}
    >
      <form className="modal-form" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        {result && <div className="import-result">{result}</div>}
        <label className="upload-zone">
          <input
            type="file"
            accept=".csv,text/csv"
            required
            disabled={saving || reading}
            onChange={async (event) => {
              const selected = event.target.files?.[0];
              setFile(null);
              setError("");
              setResult("");
              setRowErrors([]);
              if (!selected) return;
              setReading(true);
              try {
                const csv = await selected.text();
                if (!csv.trim())
                  throw new Error("This CSV file is empty. Choose a file with transactions.");
                setFile({ name: selected.name, csv });
              } catch (reason) {
                setError(
                  reason instanceof Error ? reason.message : "Unable to read this CSV file.",
                );
              } finally {
                setReading(false);
              }
            }}
          />
          <span className="upload-cloud">
            <Icon name="upload" size={22} />
          </span>
          <strong>{reading ? "Reading CSV…" : (file?.name ?? "Choose a CSV file")}</strong>
          <small>
            We detect date, amount, memo, and reference columns automatically. Values are read as{" "}
            {currency} — {currencyMeta(currency).name}. {amountPrecisionHint(currency)}
          </small>
        </label>
        <div className="csv-preview">
          <div>
            <span>{file ? "File preview" : "Example only · not selected"}</span>
            <small>{file ? "First lines of your CSV" : "Choose your own CSV to import"}</small>
          </div>
          <pre>
            {(file?.csv ?? bankCsvExample(currency))
              .trim()
              .split(/\r\n|\n|\r/)
              .slice(0, 4)
              .join("\n")}
          </pre>
        </div>
        {rowErrors.length > 0 && (
          <div className="import-errors">
            <strong>Rows that could not be imported</strong>
            {rowErrors.map((item) => (
              <div key={`${item.row}-${item.message}`}>
                <b>Row {item.row}</b>
                <span>{item.message}</span>
              </div>
            ))}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button quiet" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={saving || reading || !file?.csv.trim()}>
            {saving ? "Importing…" : "Import transactions"} <Icon name="arrow" size={15} />
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}
