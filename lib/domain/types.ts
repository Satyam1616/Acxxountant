export type CurrencyCode = "USD" | "EUR" | "GBP" | "CAD" | "JPY" | string;

export type Money = {
  currency: CurrencyCode;
  minor: bigint;
};

export type MoneyWire = {
  currency: CurrencyCode;
  minor: string;
};

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export type AccountControl = "bank" | "receivable" | "payable" | "unapplied" | null;
export type JournalSide = "debit" | "credit";
export type JournalSource = "invoice" | "bank-reconciliation" | "manual" | "reversal" | "opening";

export type Account = {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  control: AccountControl;
  currency: CurrencyCode | null;
  active: boolean;
};

export type JournalLine = {
  id: string;
  accountId: string;
  side: JournalSide;
  amount: Money;
  memo?: string;
};

export type JournalEntry = {
  id: string;
  entityId: string;
  date: string;
  description: string;
  source: JournalSource;
  sourceId: string;
  lines: JournalLine[];
  createdAt: string;
  reversedBy?: string;
  reverses?: string;
};

export type Customer = {
  id: string;
  entityId: string;
  name: string;
  email: string;
  company?: string;
  currency: CurrencyCode;
  createdAt: string;
};

export type InvoiceStatus = "draft" | "issued" | "partial" | "paid" | "overdue" | "void";

export type InvoiceLine = {
  id: string;
  description: string;
  quantity: number;
  unitMinor: bigint;
  accountId: string;
};

export type Invoice = {
  id: string;
  entityId: string;
  customerId: string;
  number: string;
  issueDate: string;
  dueDate: string;
  currency: CurrencyCode;
  lines: InvoiceLine[];
  total: Money;
  status: InvoiceStatus;
  journalEntryId?: string;
  createdAt: string;
};

export type BankFlow = "inflow" | "outflow";
export type BankTransactionStatus = "unreviewed" | "suggested" | "posted" | "excluded";

export type BankTransaction = {
  id: string;
  entityId: string;
  externalId: string;
  date: string;
  amount: Money;
  flow: BankFlow;
  description: string;
  reference: string;
  counterparty?: string;
  status: BankTransactionStatus;
  matchId?: string;
  journalEntryId?: string;
  createdAt: string;
};

export type MatchStatus = "proposed" | "approved" | "rejected" | "unmatched";

export type PaymentAllocation = {
  invoiceId: string;
  amount: Money;
};

export type PaymentMatch = {
  id: string;
  entityId: string;
  bankTransactionId: string;
  status: MatchStatus;
  confidence: number;
  rationale: string[];
  allocations: PaymentAllocation[];
  suggestedAccountId?: string;
  createdAt: string;
  resolvedAt?: string;
};

export type CategoryRule = {
  id: string;
  entityId: string;
  name: string;
  keywords: string[];
  accountId: string;
  flow?: BankFlow;
  priority: number;
  active: boolean;
};

export type AuditEvent = {
  id: string;
  entityId: string;
  actor: string;
  action: string;
  objectType: string;
  objectId: string;
  detail: string;
  createdAt: string;
};

export type EntitySettings = {
  autoApplyThreshold: number;
  feeToleranceMinor: string;
  defaultCurrency: CurrencyCode;
  aiProvider: "rules" | "groq" | "claude";
};

export type Entity = {
  id: string;
  organizationId: string;
  name: string;
  legalName: string;
  currency: CurrencyCode;
  timezone: string;
  settings: EntitySettings;
};

export type Organization = {
  id: string;
  name: string;
  createdAt: string;
};

export type DomainSnapshot = {
  entity: Entity;
  accounts: Account[];
  customers: Customer[];
  invoices: Invoice[];
  transactions: BankTransaction[];
  matches: PaymentMatch[];
  journalEntries: JournalEntry[];
  categoryRules: CategoryRule[];
};

export type TrialBalanceRow = {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  currency: CurrencyCode;
  debit: Money;
  credit: Money;
  balance: Money;
};

export type AgingBucket = "current" | "1-30" | "31-60" | "61-90" | "90+";

export type AgingRow = {
  customerId: string;
  customerName: string;
  currency: CurrencyCode;
  current: Money;
  overdue1to30: Money;
  overdue31to60: Money;
  overdue61to90: Money;
  overdue90Plus: Money;
  total: Money;
};

export type DashboardSnapshot = {
  entity: Entity;
  metrics: {
    outstanding: Money;
    overdue: Money;
    collectedThisMonth: Money;
    needsReview: number;
    matchedThisMonth: number;
  };
  aging: AgingRow[];
  recentTransactions: BankTransaction[];
  reviewQueue: Array<{
    transaction: BankTransaction;
    match?: PaymentMatch;
    invoice?: Invoice;
    customer?: Customer;
  }>;
  invoices: Invoice[];
  customers: Customer[];
};
