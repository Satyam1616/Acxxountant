import { invariant } from "./errors";
import { add, money, multiply, subtract, zero } from "./money";
import type {
  Account,
  Invoice,
  InvoiceLine,
  JournalEntry,
  JournalLine,
  JournalSide,
  Money,
} from "./types";

export function validateJournalEntry(entry: JournalEntry, accounts: Account[]): void {
  invariant(entry.lines.length >= 2, "journal_needs_two_lines");
  const accountMap = new Map(accounts.map((account) => [account.id, account]));
  let debits = 0n;
  let credits = 0n;
  const lineIds = new Set<string>();

  for (const line of entry.lines) {
    invariant(!lineIds.has(line.id), "duplicate_line_id");
    lineIds.add(line.id);
    invariant(
      line.amount.currency === entry.lines[0]?.amount.currency,
      "journal_currency_mismatch",
    );
    invariant(line.amount.minor > 0n, "posting_must_be_positive");
    const account = accountMap.get(line.accountId);
    invariant(account, "account_not_found");
    invariant(account.active, "account_archived");
    invariant(
      !account.currency || account.currency === line.amount.currency,
      "account_currency_mismatch",
    );
    if (line.side === "debit") debits += line.amount.minor;
    else credits += line.amount.minor;
  }

  invariant(
    debits === credits,
    "journal_unbalanced",
    `Debits ${debits} do not equal credits ${credits}`,
  );
}

export function invoiceTotal(lines: InvoiceLine[], currency: string): Money {
  return lines.reduce(
    (total, line) => add(total, multiply(money(currency, line.unitMinor), line.quantity)),
    zero(currency),
  );
}

export function buildInvoiceJournal(params: {
  invoice: Invoice;
  arAccountId: string;
  revenueAccountId: string;
  createdAt: string;
}): JournalEntry {
  const { invoice } = params;
  const lines: JournalLine[] = [
    {
      id: `${invoice.id}:ar`,
      accountId: params.arAccountId,
      side: "debit",
      amount: invoice.total,
      memo: `Accounts receivable for ${invoice.number}`,
    },
    {
      id: `${invoice.id}:revenue`,
      accountId: params.revenueAccountId,
      side: "credit",
      amount: invoice.total,
      memo: `Revenue for ${invoice.number}`,
    },
  ];
  return {
    id: `je_${invoice.id}`,
    entityId: invoice.entityId,
    date: invoice.issueDate,
    description: `Invoice ${invoice.number}`,
    source: "invoice",
    sourceId: invoice.id,
    lines,
    createdAt: params.createdAt,
  };
}

export function buildReconciliationJournal(params: {
  entityId: string;
  transactionId: string;
  date: string;
  createdAt: string;
  description: string;
  bankAccountId: string;
  amount: Money;
  flow: "inflow" | "outflow";
  allocations: Array<{
    invoiceId: string;
    amount: Money;
    arAccountId?: string;
    apAccountId?: string;
  }>;
  offsets: Array<{ accountId: string; amount: Money; side: JournalSide; memo?: string }>;
  journalEntryId?: string;
}): JournalEntry {
  const lines: JournalLine[] = [
    {
      id: `${params.transactionId}:bank`,
      accountId: params.bankAccountId,
      side: params.flow === "inflow" ? "debit" : "credit",
      amount: params.amount,
      memo: params.description,
    },
  ];

  for (const allocation of params.allocations) {
    invariant(
      allocation.amount.currency === params.amount.currency,
      "allocation_currency_mismatch",
    );
    lines.push({
      id: `${params.transactionId}:invoice:${allocation.invoiceId}`,
      accountId: allocation.arAccountId ?? allocation.apAccountId ?? "",
      side: params.flow === "inflow" ? "credit" : "debit",
      amount: allocation.amount,
      memo: `Apply to invoice ${allocation.invoiceId}`,
    });
  }

  for (const [index, offset] of params.offsets.entries()) {
    lines.push({
      id: `${params.transactionId}:offset:${index}`,
      accountId: offset.accountId,
      side: offset.side,
      amount: offset.amount,
      memo: offset.memo,
    });
  }

  return {
    id: params.journalEntryId ?? `je_${params.transactionId}`,
    entityId: params.entityId,
    date: params.date,
    description: params.description,
    source: "bank-reconciliation",
    sourceId: params.transactionId,
    lines,
    createdAt: params.createdAt,
  };
}

export function buildReversal(
  original: JournalEntry,
  date: string,
  createdAt: string,
  reason: string,
): JournalEntry {
  invariant(!original.reverses, "cannot_reverse_reversal");
  invariant(!original.reversedBy, "already_reversed");
  return {
    id: `je_reversal_${original.id}`,
    entityId: original.entityId,
    date,
    description: `Reversal: ${reason}`,
    source: "reversal",
    sourceId: original.id,
    reverses: original.id,
    createdAt,
    lines: original.lines.map((line, index) => ({
      ...line,
      id: `je_reversal_${original.id}:${index}`,
      side: oppositeSide(line.side),
    })),
  };
}

export function oppositeSide(side: JournalSide): JournalSide {
  return side === "debit" ? "credit" : "debit";
}

export function journalBalance(entry: JournalEntry): Money {
  const currency = entry.lines[0]?.amount.currency ?? "USD";
  const debit = entry.lines
    .filter((line) => line.side === "debit")
    .reduce((sum, line) => add(sum, line.amount), zero(currency));
  const credit = entry.lines
    .filter((line) => line.side === "credit")
    .reduce((sum, line) => add(sum, line.amount), zero(currency));
  return subtract(debit, credit);
}
