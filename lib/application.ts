import { z } from "zod";
import {
  buildInvoiceJournal,
  buildReconciliationJournal,
  buildReversal,
  validateJournalEntry,
} from "@/lib/domain/ledger";
import { proposeCategory } from "@/lib/domain/categorize";
import { invariant } from "@/lib/domain/errors";
import { parseBankCsv } from "@/lib/domain/import";
import { proposeMatch } from "@/lib/domain/matching";
import {
  agingReport,
  appliedByInvoice,
  balanceSheet,
  profitAndLoss,
  trialBalance,
} from "@/lib/domain/reports";
import { money, parseAmount } from "@/lib/domain/money";
import type { BankTransaction, Invoice, PaymentAllocation } from "@/lib/domain/types";
import { getState, updateState } from "@/lib/store";
import {
  invoiceFromStored,
  invoiceToStored,
  journalFromStored,
  journalToStored,
  matchFromStored,
  matchToStored,
  snapshotFromStored,
  transactionFromStored,
  transactionToStored,
} from "@/lib/store/serialize";
import type { StorageState } from "@/lib/store/schema";

const actor = "Jordan Lee";
const now = () => new Date().toISOString();
const id = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

export async function getDashboard() {
  const state = await getState();
  const snapshot = snapshotFromStored(state);
  const today = new Date().toISOString().slice(0, 10);
  const applied = appliedByInvoice(snapshot, today);
  const currentMonth = today.slice(0, 7);
  const outstanding = snapshot.invoices.reduce((sum, invoice) => {
    const remaining = invoice.total.minor - (applied.get(invoice.id) ?? 0n);
    return sum + (remaining > 0n ? remaining : 0n);
  }, 0n);
  const overdue = snapshot.invoices.reduce((sum, invoice) => {
    const remaining = invoice.total.minor - (applied.get(invoice.id) ?? 0n);
    return sum + (invoice.dueDate < today && remaining > 0n ? remaining : 0n);
  }, 0n);
  const collected = snapshot.matches.reduce((sum, match) => {
    const transaction = snapshot.transactions.find((item) => item.id === match.bankTransactionId);
    return match.status === "approved" && transaction?.date.startsWith(currentMonth)
      ? sum + match.allocations.reduce((total, allocation) => total + allocation.amount.minor, 0n)
      : sum;
  }, 0n);
  const reviewQueue = snapshot.transactions
    .filter(
      (transaction) => transaction.status === "suggested" || transaction.status === "unreviewed",
    )
    .map((transaction) => {
      const match = snapshot.matches.find((item) => item.id === transaction.matchId);
      const allocation = match?.allocations[0];
      const invoice = allocation
        ? snapshot.invoices.find((item) => item.id === allocation.invoiceId)
        : undefined;
      const customer = invoice
        ? snapshot.customers.find((item) => item.id === invoice.customerId)
        : undefined;
      return { transaction, match, invoice, customer };
    });
  return {
    entity: snapshot.entity,
    metrics: {
      outstanding: money(snapshot.entity.currency, outstanding),
      overdue: money(snapshot.entity.currency, overdue),
      collectedThisMonth: money(snapshot.entity.currency, collected),
      needsReview: reviewQueue.length,
      matchedThisMonth: snapshot.matches.filter((match) => match.status === "approved").length,
    },
    aging: agingReport(snapshot, today),
    recentTransactions: [...snapshot.transactions]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 8),
    reviewQueue,
    invoices: [...snapshot.invoices].sort((a, b) => b.issueDate.localeCompare(a.issueDate)),
    customers: snapshot.customers,
  };
}

export async function getReports(
  asOf = new Date().toISOString().slice(0, 10),
  from = `${asOf.slice(0, 7)}-01`,
) {
  const snapshot = snapshotFromStored(await getState());
  return {
    asOf,
    from,
    trialBalance: trialBalance(snapshot, asOf),
    aging: agingReport(snapshot, asOf),
    pnl: profitAndLoss(snapshot, from, asOf),
    balanceSheet: balanceSheet(snapshot, asOf),
  };
}

function getInvoice(state: StorageState, invoiceId: string): Invoice {
  const invoice = state.invoices.find((item) => item.id === invoiceId);
  invariant(invoice, "invoice_not_found");
  return invoiceFromStored(invoice);
}

function recalculateStatuses(state: StorageState): void {
  const snapshot = snapshotFromStored(state);
  const applied = appliedByInvoice(snapshot);
  state.invoices = state.invoices.map((stored) => {
    const invoice = invoiceFromStored(stored);
    if (invoice.status === "void" || invoice.status === "draft") return stored;
    const paid = applied.get(invoice.id) ?? 0n;
    const status = paid >= invoice.total.minor ? "paid" : paid > 0n ? "partial" : "issued";
    return { ...stored, status };
  });
}

function addAudit(
  state: StorageState,
  action: string,
  objectType: string,
  objectId: string,
  detail: string,
): void {
  state.auditEvents.unshift({
    id: id("audit"),
    entityId: state.entity.id,
    actor,
    action,
    objectType,
    objectId,
    detail,
    createdAt: now(),
  });
}

function createMatchForTransaction(state: StorageState, transaction: BankTransaction) {
  const snapshot = snapshotFromStored(state);
  const proposal =
    transaction.flow === "inflow"
      ? proposeMatch({
          transaction,
          invoices: snapshot.invoices,
          customers: snapshot.customers,
          appliedByInvoice: appliedByInvoice(snapshot),
        })
      : proposeCategory(transaction, snapshot.categoryRules);
  const match = {
    id: id("match"),
    entityId: state.entity.id,
    bankTransactionId: transaction.id,
    status: "proposed" as const,
    confidence:
      "confidence" in proposal ? proposal.confidence : proposal.status === "matched" ? 0.96 : 0,
    rationale: proposal.rationale,
    allocations: "allocations" in proposal ? proposal.allocations : [],
    suggestedAccountId: "rule" in proposal ? proposal.rule?.accountId : undefined,
    createdAt: now(),
  };
  state.matches.push(matchToStored(match));
  const stored = state.transactions.find((item) => item.id === transaction.id);
  if (stored) {
    stored.matchId = match.id;
    stored.status =
      match.confidence >= state.entity.settings.autoApplyThreshold ? "suggested" : "unreviewed";
  }
  return match;
}

export const approveSchema = z.object({
  mode: z.enum(["suggestion", "invoice", "category", "unapplied"]).default("suggestion"),
  accountId: z.string().optional(),
  allocations: z.array(z.object({ invoiceId: z.string(), amount: z.string() })).optional(),
});

export async function approveTransaction(
  transactionId: string,
  input: z.infer<typeof approveSchema>,
) {
  let result: { transactionId: string; journalEntryId: string } | undefined;
  await updateState((state) => {
    const storedTransaction = state.transactions.find((item) => item.id === transactionId);
    invariant(storedTransaction, "transaction_not_found");
    invariant(storedTransaction.status !== "posted", "transaction_already_posted");
    const transaction = transactionFromStored(storedTransaction);
    const existingMatch = storedTransaction.matchId
      ? state.matches.find((item) => item.id === storedTransaction.matchId)
      : undefined;
    const existing = existingMatch ? matchFromStored(existingMatch) : undefined;
    const allocations: PaymentAllocation[] = input.allocations
      ? input.allocations.map((allocation) => ({
          invoiceId: allocation.invoiceId,
          amount: parseAmount(allocation.amount, transaction.amount.currency),
        }))
      : (existing?.allocations ?? []);
    const accountId = input.accountId ?? existing?.suggestedAccountId;
    if (transaction.flow === "inflow" && input.mode !== "category") {
      const applied = appliedByInvoice(snapshotFromStored(state));
      let allocated = 0n;
      for (const allocation of allocations) {
        const invoice = getInvoice(state, allocation.invoiceId);
        invariant(invoice.currency === transaction.amount.currency, "currency_mismatch");
        const available = invoice.total.minor - (applied.get(invoice.id) ?? 0n);
        invariant(
          allocation.amount.minor > 0n && allocation.amount.minor <= available,
          "allocation_exceeds_balance",
          `Invoice ${invoice.number} has ${available} minor units open`,
        );
        allocated += allocation.amount.minor;
      }
      invariant(allocated <= transaction.amount.minor, "allocation_exceeds_payment");
      const offsets =
        transaction.amount.minor > allocated
          ? [
              {
                accountId: accountId ?? "acct_unapplied",
                amount: money(transaction.amount.currency, transaction.amount.minor - allocated),
                side: "credit" as const,
                memo: "Unapplied customer cash",
              },
            ]
          : [];
      const entry = buildReconciliationJournal({
        entityId: state.entity.id,
        transactionId,
        date: transaction.date,
        createdAt: now(),
        description: transaction.description,
        bankAccountId: "acct_bank",
        amount: transaction.amount,
        flow: transaction.flow,
        allocations: allocations.map((allocation) => ({
          invoiceId: allocation.invoiceId,
          amount: allocation.amount,
          arAccountId: "acct_ar",
        })),
        offsets,
      });
      validateJournalEntry(entry, state.accounts);
      state.journalEntries.push(journalToStored(entry));
      const match = existing ?? {
        id: id("match"),
        entityId: state.entity.id,
        bankTransactionId: transactionId,
        status: "approved" as const,
        confidence: 1,
        rationale: ["Approved by user"],
        allocations: [],
        createdAt: now(),
      };
      match.status = "approved";
      match.allocations = allocations;
      match.resolvedAt = now();
      if (!existing) state.matches.push(matchToStored(match));
      else Object.assign(existingMatch!, matchToStored(match));
      storedTransaction.status = "posted";
      storedTransaction.journalEntryId = entry.id;
      storedTransaction.matchId = match.id;
      addAudit(
        state,
        "payment.approved",
        "bank_transaction",
        transactionId,
        `Posted ${entry.id} with ${allocations.length} invoice allocation(s)`,
      );
      result = { transactionId, journalEntryId: entry.id };
    } else {
      invariant(accountId, "category_account_required");
      const side = transaction.flow === "inflow" ? "credit" : "debit";
      const entry = buildReconciliationJournal({
        entityId: state.entity.id,
        transactionId,
        date: transaction.date,
        createdAt: now(),
        description: transaction.description,
        bankAccountId: "acct_bank",
        amount: transaction.amount,
        flow: transaction.flow,
        allocations: [],
        offsets: [{ accountId, amount: transaction.amount, side, memo: "Approved category" }],
      });
      validateJournalEntry(entry, state.accounts);
      state.journalEntries.push(journalToStored(entry));
      const match = existing ?? {
        id: id("match"),
        entityId: state.entity.id,
        bankTransactionId: transactionId,
        status: "approved" as const,
        confidence: 1,
        rationale: ["Categorized by user"],
        allocations: [],
        createdAt: now(),
      };
      match.status = "approved";
      match.suggestedAccountId = accountId;
      match.resolvedAt = now();
      if (!existing) state.matches.push(matchToStored(match));
      else Object.assign(existingMatch!, matchToStored(match));
      storedTransaction.status = "posted";
      storedTransaction.journalEntryId = entry.id;
      storedTransaction.matchId = match.id;
      addAudit(
        state,
        "transaction.categorized",
        "bank_transaction",
        transactionId,
        `Posted to account ${accountId}`,
      );
      result = { transactionId, journalEntryId: entry.id };
    }
    recalculateStatuses(state);
  });
  return result!;
}

export async function excludeTransaction(transactionId: string, reason: string) {
  await updateState((state) => {
    const transaction = state.transactions.find((item) => item.id === transactionId);
    invariant(transaction, "transaction_not_found");
    invariant(transaction.status !== "posted", "transaction_already_posted");
    transaction.status = "excluded";
    if (transaction.matchId) {
      const match = state.matches.find((item) => item.id === transaction.matchId);
      if (match) match.status = "rejected";
    }
    addAudit(
      state,
      "transaction.excluded",
      "bank_transaction",
      transactionId,
      reason || "Excluded from reconciliation",
    );
  });
  return { transactionId };
}

export async function undoTransaction(transactionId: string) {
  await updateState((state) => {
    const transaction = state.transactions.find((item) => item.id === transactionId);
    invariant(transaction?.journalEntryId, "posted_transaction_required");
    const originalStored = state.journalEntries.find(
      (item) => item.id === transaction.journalEntryId,
    );
    invariant(originalStored, "journal_entry_not_found");
    const original = journalFromStored(originalStored);
    const reversal = buildReversal(
      original,
      new Date().toISOString().slice(0, 10),
      now(),
      `Undo ${transaction.description}`,
    );
    validateJournalEntry(reversal, state.accounts);
    state.journalEntries.push(journalToStored(reversal));
    originalStored.reversedBy = reversal.id;
    transaction.status = "suggested";
    transaction.journalEntryId = undefined;
    if (transaction.matchId) {
      const match = state.matches.find((item) => item.id === transaction.matchId);
      if (match) match.status = "rejected";
    }
    addAudit(
      state,
      "transaction.reversed",
      "bank_transaction",
      transactionId,
      `Created reversing entry ${reversal.id}`,
    );
    recalculateStatuses(state);
  });
  return { transactionId };
}

export const invoiceSchema = z.object({
  customerId: z.string().min(1),
  dueDate: z.string().min(8),
  description: z.string().min(1),
  amount: z.string().min(1),
});

export async function createInvoice(input: z.infer<typeof invoiceSchema>) {
  let created: Invoice | undefined;
  await updateState((state) => {
    const customer = state.customers.find((item) => item.id === input.customerId);
    invariant(customer, "customer_not_found");
    const amount = parseAmount(input.amount, state.entity.currency);
    invariant(amount.minor > 0n, "amount_must_be_positive");
    const number = `INV-${String(1048 + state.invoices.length).padStart(4, "0")}`;
    const issueDate = new Date().toISOString().slice(0, 10);
    const invoice: Invoice = {
      id: id("inv"),
      entityId: state.entity.id,
      customerId: customer.id,
      number,
      issueDate,
      dueDate: input.dueDate,
      currency: state.entity.currency,
      lines: [
        {
          id: id("line"),
          description: input.description,
          quantity: 1,
          unitMinor: amount.minor,
          accountId: "acct_revenue",
        },
      ],
      total: amount,
      status: "issued",
      createdAt: now(),
    };
    const entry = buildInvoiceJournal({
      invoice,
      arAccountId: "acct_ar",
      revenueAccountId: "acct_revenue",
      createdAt: now(),
    });
    validateJournalEntry(entry, state.accounts);
    invoice.journalEntryId = entry.id;
    state.invoices.unshift(invoiceToStored(invoice));
    state.journalEntries.push(journalToStored(entry));
    addAudit(
      state,
      "invoice.issued",
      "invoice",
      invoice.id,
      `Issued ${invoice.number} for ${input.amount}`,
    );
    created = invoice;
  });
  return created!;
}

export const customerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  company: z.string().optional(),
});
export async function createCustomer(input: z.infer<typeof customerSchema>) {
  let created;
  await updateState((state) => {
    created = {
      id: id("cust"),
      entityId: state.entity.id,
      name: input.name,
      email: input.email,
      company: input.company,
      currency: state.entity.currency,
      createdAt: now(),
    };
    state.customers.unshift(created!);
    addAudit(state, "customer.created", "customer", created!.id, `Added ${input.name}`);
  });
  return created!;
}

export async function importTransactions(csv: string) {
  let imported = 0;
  let skipped = 0;
  const errors: Array<{ row: number; message: string }> = [];
  await updateState((state) => {
    const parsed = parseBankCsv(csv, state.entity.currency);
    errors.push(...parsed.errors);
    for (const row of parsed.rows) {
      if (state.transactions.some((transaction) => transaction.externalId === row.externalId)) {
        skipped += 1;
        continue;
      }
      const transaction: BankTransaction = {
        id: id("bank"),
        entityId: state.entity.id,
        externalId: row.externalId,
        date: row.date,
        amount: row.amount,
        flow: row.flow,
        description: row.description,
        reference: row.reference,
        counterparty: row.counterparty,
        status: "unreviewed",
        createdAt: now(),
      };
      state.transactions.unshift(transactionToStored(transaction));
      createMatchForTransaction(state, transaction);
      imported += 1;
    }
    addAudit(
      state,
      "transactions.imported",
      "bank_transaction",
      "batch",
      `${imported} imported, ${skipped} duplicates skipped`,
    );
  });
  return { imported, skipped, errors };
}

export async function saveSettings(settings: Partial<StorageState["entity"]["settings"]>) {
  await updateState((state) => {
    state.entity.settings = { ...state.entity.settings, ...settings };
    addAudit(state, "settings.updated", "entity", state.entity.id, "Workspace settings updated");
  });
  return (await getState()).entity.settings;
}

export async function getLedger() {
  const state = await getState();
  return snapshotFromStored(state).journalEntries.sort(
    (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
  );
}

export async function getAuditEvents() {
  return (await getState()).auditEvents;
}
