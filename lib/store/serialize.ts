import type {
  DomainSnapshot,
  Invoice,
  JournalEntry,
  Money,
  PaymentMatch,
  BankTransaction,
} from "@/lib/domain/types";
import type {
  StoredInvoice,
  StoredJournalEntry,
  StoredMatch,
  StoredMoney,
  StoredTransaction,
} from "./schema";

export const moneyToStored = (value: Money): StoredMoney => ({
  currency: value.currency,
  minor: value.minor.toString(),
});
export const moneyFromStored = (value: StoredMoney): Money => ({
  currency: value.currency,
  minor: BigInt(value.minor),
});

export function invoiceToStored(invoice: Invoice): StoredInvoice {
  return {
    ...invoice,
    total: moneyToStored(invoice.total),
    lines: invoice.lines.map((line) => ({ ...line, unitMinor: line.unitMinor.toString() })),
  };
}
export function invoiceFromStored(invoice: StoredInvoice): Invoice {
  return {
    ...invoice,
    total: moneyFromStored(invoice.total),
    lines: invoice.lines.map((line) => ({ ...line, unitMinor: BigInt(line.unitMinor) })),
  };
}
export function transactionToStored(transaction: BankTransaction): StoredTransaction {
  return { ...transaction, amount: moneyToStored(transaction.amount) };
}
export function transactionFromStored(transaction: StoredTransaction): BankTransaction {
  return { ...transaction, amount: moneyFromStored(transaction.amount) };
}
export function matchToStored(match: PaymentMatch): StoredMatch {
  return {
    ...match,
    allocations: match.allocations.map((allocation) => ({
      ...allocation,
      amount: moneyToStored(allocation.amount),
    })),
  };
}
export function matchFromStored(match: StoredMatch): PaymentMatch {
  return {
    ...match,
    allocations: match.allocations.map((allocation) => ({
      ...allocation,
      amount: moneyFromStored(allocation.amount),
    })),
  };
}
export function journalToStored(entry: JournalEntry): StoredJournalEntry {
  return {
    ...entry,
    lines: entry.lines.map((line) => ({ ...line, amount: moneyToStored(line.amount) })),
  };
}
export function journalFromStored(entry: StoredJournalEntry): JournalEntry {
  return {
    ...entry,
    lines: entry.lines.map((line) => ({ ...line, amount: moneyFromStored(line.amount) })),
  };
}

export function snapshotFromStored(state: import("./schema").StorageState): DomainSnapshot {
  return {
    entity: state.entity,
    accounts: state.accounts,
    customers: state.customers,
    invoices: state.invoices.map(invoiceFromStored),
    transactions: state.transactions.map(transactionFromStored),
    matches: state.matches.map(matchFromStored),
    journalEntries: state.journalEntries.map(journalFromStored),
    categoryRules: state.categoryRules,
  };
}
