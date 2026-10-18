import type {
  Account,
  AuditEvent,
  CategoryRule,
  Customer,
  Entity,
  Organization,
} from "@/lib/domain/types";

export type StoredMoney = { currency: string; minor: string };
export type StoredJournalLine = {
  id: string;
  accountId: string;
  side: "debit" | "credit";
  amount: StoredMoney;
  memo?: string;
};
export type StoredJournalEntry = {
  id: string;
  entityId: string;
  date: string;
  description: string;
  source: "invoice" | "bank-reconciliation" | "manual" | "reversal" | "opening";
  sourceId: string;
  lines: StoredJournalLine[];
  createdAt: string;
  reversedBy?: string;
  reverses?: string;
};
export type StoredInvoiceLine = {
  id: string;
  description: string;
  quantity: number;
  unitMinor: string;
  accountId: string;
};
export type StoredInvoice = Omit<import("@/lib/domain/types").Invoice, "lines" | "total"> & {
  lines: StoredInvoiceLine[];
  total: StoredMoney;
};
export type StoredTransaction = Omit<import("@/lib/domain/types").BankTransaction, "amount"> & {
  amount: StoredMoney;
};
export type StoredMatch = Omit<import("@/lib/domain/types").PaymentMatch, "allocations"> & {
  allocations: Array<{ invoiceId: string; amount: StoredMoney }>;
};

export type StorageState = {
  version: 1;
  organization: Organization;
  entity: Entity;
  accounts: Account[];
  customers: Customer[];
  invoices: StoredInvoice[];
  transactions: StoredTransaction[];
  matches: StoredMatch[];
  journalEntries: StoredJournalEntry[];
  categoryRules: CategoryRule[];
  auditEvents: AuditEvent[];
};
