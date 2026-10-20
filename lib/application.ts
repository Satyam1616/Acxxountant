import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  buildInvoiceJournal,
  buildReconciliationJournal,
  buildReversal,
  validateJournalEntry,
} from "@/lib/domain/ledger";
import { proposeCategory } from "@/lib/domain/categorize";
import { invariant } from "@/lib/domain/errors";
import { isValidBusinessDate, isValidTimeZone, todayInTimeZone } from "@/lib/domain/date";
import { parseBankCsv } from "@/lib/domain/import";
import { proposeMatch } from "@/lib/domain/matching";
import { isSupportedCurrency } from "@/lib/domain/currency";
import {
  agingReport,
  appliedByInvoice,
  balanceSheet,
  derivedInvoiceStatus,
  profitAndLoss,
  trialBalance,
} from "@/lib/domain/reports";
import { money, parseAmount } from "@/lib/domain/money";
import type { BankTransaction, Invoice, PaymentAllocation } from "@/lib/domain/types";
import { getState, getStorageInfo, updateState } from "@/lib/store";
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

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${randomUUID()}`;

function canChangeCurrency(state: StorageState): boolean {
  return (
    state.invoices.length === 0 &&
    state.transactions.length === 0 &&
    state.journalEntries.length === 0 &&
    state.matches.length === 0
  );
}

export async function getDashboard() {
  const state = await getState();
  const snapshot = snapshotFromStored(state);
  const today = todayInTimeZone(snapshot.entity.timezone);
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
    currencyChangeAllowed: canChangeCurrency(state),
    storage: getStorageInfo(),
    reportingDate: today,
    metrics: {
      outstanding: money(snapshot.entity.currency, outstanding),
      overdue: money(snapshot.entity.currency, overdue),
      collectedThisMonth: money(snapshot.entity.currency, collected),
      needsReview: reviewQueue.length,
      matchedThisMonth: snapshot.matches.filter((match) => {
        const transaction = snapshot.transactions.find(
          (item) => item.id === match.bankTransactionId,
        );
        return match.status === "approved" && transaction?.date.startsWith(currentMonth);
      }).length,
    },
    aging: agingReport(snapshot, today),
    accounts: snapshot.accounts.filter((account) => account.active),
    transactions: snapshot.transactions,
    recentTransactions: [...snapshot.transactions]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 8),
    reviewQueue,
    invoices: [...snapshot.invoices]
      .map((invoice) => ({
        ...invoice,
        status: derivedInvoiceStatus(invoice, applied, today),
        outstanding: money(
          invoice.currency,
          (() => {
            const remaining = invoice.total.minor - (applied.get(invoice.id) ?? 0n);
            return remaining > 0n ? remaining : 0n;
          })(),
        ),
      }))
      .sort((a, b) => b.issueDate.localeCompare(a.issueDate)),
    customers: snapshot.customers,
  };
}

export async function getReports(asOf?: string, from?: string) {
  const snapshot = snapshotFromStored(await getState());
  const resolvedAsOf = asOf ?? todayInTimeZone(snapshot.entity.timezone);
  const resolvedFrom = from ?? `${resolvedAsOf.slice(0, 7)}-01`;
  invariant(isValidBusinessDate(resolvedAsOf), "invalid_report_date");
  invariant(isValidBusinessDate(resolvedFrom), "invalid_report_date");
  invariant(resolvedFrom <= resolvedAsOf, "invalid_report_range");
  return {
    asOf: resolvedAsOf,
    from: resolvedFrom,
    trialBalance: trialBalance(snapshot, resolvedAsOf),
    aging: agingReport(snapshot, resolvedAsOf),
    pnl: profitAndLoss(snapshot, resolvedFrom, resolvedAsOf),
    balanceSheet: balanceSheet(snapshot, resolvedAsOf),
  };
}

function getInvoice(state: StorageState, invoiceId: string): Invoice {
  const invoice = state.invoices.find((item) => item.id === invoiceId);
  invariant(invoice, "invoice_not_found");
  return invoiceFromStored(invoice);
}

function recalculateStatuses(
  state: StorageState,
  asOf = todayInTimeZone(state.entity.timezone),
): void {
  const snapshot = snapshotFromStored(state);
  const applied = appliedByInvoice(snapshot);
  state.invoices = state.invoices.map((stored) => {
    const invoice = invoiceFromStored(stored);
    if (invoice.status === "void" || invoice.status === "draft") return stored;
    const status = derivedInvoiceStatus(invoice, applied, asOf);
    return { ...stored, status };
  });
}

function addAudit(
  state: StorageState,
  action: string,
  objectType: string,
  objectId: string,
  detail: string,
  actorName = "system",
): void {
  state.auditEvents.unshift({
    id: id("audit"),
    entityId: state.entity.id,
    actor: actorName,
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

function postingAccount(state: StorageState, accountId: string, currency: string) {
  const account = state.accounts.find((item) => item.id === accountId);
  invariant(account, "account_not_found");
  invariant(account.active, "account_archived");
  invariant(
    account.currency === null || account.currency === currency,
    "account_currency_mismatch",
  );
  invariant(account.control !== "bank", "bank_account_requires_bank_flow");
  return account;
}

export const approveSchema = z
  .object({
    mode: z.enum(["suggestion", "invoice", "category", "unapplied"]).default("suggestion"),
    accountId: z.string().max(100).optional(),
    allocations: z
      .array(z.object({ invoiceId: z.string().max(100), amount: z.string().max(40) }).strict())
      .max(50)
      .optional(),
  })
  .strict();

export async function approveTransaction(
  transactionId: string,
  input: z.infer<typeof approveSchema>,
  actorName = "system",
) {
  let result: { transactionId: string; journalEntryId: string } | undefined;
  await updateState((state) => {
    const storedTransaction = state.transactions.find((item) => item.id === transactionId);
    invariant(storedTransaction, "transaction_not_found");
    invariant(storedTransaction.status !== "posted", "transaction_already_posted");
    invariant(storedTransaction.entityId === state.entity.id, "entity_mismatch");
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
    const allocationIds = new Set<string>();
    invariant(
      !(input.mode === "invoice" && allocations.length === 0),
      "invoice_allocation_required",
    );
    if (transaction.flow === "inflow" && input.mode !== "category") {
      const applied = appliedByInvoice(snapshotFromStored(state));
      let allocated = 0n;
      for (const allocation of allocations) {
        invariant(!allocationIds.has(allocation.invoiceId), "duplicate_invoice_allocation");
        allocationIds.add(allocation.invoiceId);
        const invoice = getInvoice(state, allocation.invoiceId);
        invariant(invoice.entityId === state.entity.id, "entity_mismatch");
        invariant(!["void", "draft"].includes(invoice.status), "invoice_not_payable");
        invariant(invoice.issueDate <= transaction.date, "invoice_not_issued");
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
      const unappliedAccountId = accountId ?? "acct_unapplied";
      if (transaction.amount.minor > allocated)
        postingAccount(state, unappliedAccountId, transaction.amount.currency);
      const offsets =
        transaction.amount.minor > allocated
          ? [
              {
                accountId: unappliedAccountId,
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
        journalEntryId: id("je"),
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
        actorName,
      );
      result = { transactionId, journalEntryId: entry.id };
    } else {
      invariant(accountId, "category_account_required");
      postingAccount(state, accountId, transaction.amount.currency);
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
        journalEntryId: id("je"),
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
        actorName,
      );
      result = { transactionId, journalEntryId: entry.id };
    }
    recalculateStatuses(state);
  });
  return result!;
}

export async function excludeTransaction(
  transactionId: string,
  reason: string,
  actorName = "system",
) {
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
      actorName,
    );
  });
  return { transactionId };
}

export async function undoTransaction(transactionId: string, actorName = "system") {
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
      todayInTimeZone(state.entity.timezone),
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
      actorName,
    );
    recalculateStatuses(state);
  });
  return { transactionId };
}

export const invoiceSchema = z
  .object({
    customerId: z.string().min(1),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    description: z.string().trim().min(1).max(500),
    amount: z.string().trim().min(1).max(40),
  })
  .refine(
    (value) => {
      const [year, month, day] = value.dueDate.split("-").map(Number);
      const date = new Date(Date.UTC(year, month - 1, day));
      return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      );
    },
    { path: ["dueDate"], message: "Due date must be a real calendar date" },
  );

export async function createInvoice(input: z.infer<typeof invoiceSchema>, actorName = "system") {
  let created: Invoice | undefined;
  await updateState((state) => {
    const customer = state.customers.find((item) => item.id === input.customerId);
    invariant(customer, "customer_not_found");
    invariant(customer.entityId === state.entity.id, "entity_mismatch");
    invariant(customer.currency === state.entity.currency, "customer_currency_mismatch");
    const amount = parseAmount(input.amount, state.entity.currency);
    invariant(amount.minor > 0n, "amount_must_be_positive");
    const number = `INV-${String(1048 + state.invoices.length).padStart(4, "0")}`;
    const issueDate = todayInTimeZone(state.entity.timezone);
    invariant(
      input.dueDate >= issueDate,
      "invalid_due_date",
      "Due date must be on or after the issue date",
    );
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
      actorName,
    );
    created = invoice;
  });
  return created!;
}

export const customerSchema = z
  .object({
    name: z.string().trim().min(2).max(200),
    email: z.string().email().max(254),
    company: z.string().trim().max(200).optional(),
  })
  .strict();
export async function createCustomer(input: z.infer<typeof customerSchema>, actorName = "system") {
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
    addAudit(state, "customer.created", "customer", created!.id, `Added ${input.name}`, actorName);
  });
  return created!;
}

export async function importTransactions(csv: string, actorName = "system") {
  let imported = 0;
  let skipped = 0;
  const errors: Array<{ row: number; message: string }> = [];
  await updateState((state) => {
    const parsed = parseBankCsv(csv, state.entity.currency, state.entity.id);
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
      actorName,
    );
  });
  return { imported, skipped, errors };
}

export const settingsInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    legalName: z.string().trim().min(2).max(200).optional(),
    currency: z.string().refine(isSupportedCurrency, "Unsupported currency").optional(),
    timezone: z.string().refine(isValidTimeZone, "Invalid timezone").optional(),
    autoApplyThreshold: z.number().finite().min(0).max(1).optional(),
    feeToleranceMinor: z.string().regex(/^\d+$/).optional(),
    aiProvider: z.enum(["rules", "groq", "claude"]).optional(),
  })
  .strict();

export async function saveSettings(settings: unknown, actorName = "system") {
  const parsed = settingsInputSchema.parse(settings);
  await updateState((state) => {
    if (parsed.currency && parsed.currency !== state.entity.currency) {
      invariant(
        canChangeCurrency(state),
        "currency_change_forbidden",
        "Base currency cannot change after financial activity exists",
      );
      // Before the first financial activity, keep the unused chart/customer defaults
      // aligned so that the first invoice can actually post in the selected currency.
      for (const account of state.accounts) {
        if (account.currency === state.entity.currency) account.currency = parsed.currency;
      }
      for (const customer of state.customers) {
        if (customer.currency === state.entity.currency) customer.currency = parsed.currency;
      }
    }
    state.entity = {
      ...state.entity,
      name: parsed.name ?? state.entity.name,
      legalName: parsed.legalName ?? state.entity.legalName,
      currency: parsed.currency ?? state.entity.currency,
      timezone: parsed.timezone ?? state.entity.timezone,
      settings: {
        ...state.entity.settings,
        defaultCurrency: parsed.currency ?? state.entity.settings.defaultCurrency,
        autoApplyThreshold: parsed.autoApplyThreshold ?? state.entity.settings.autoApplyThreshold,
        feeToleranceMinor: parsed.feeToleranceMinor ?? state.entity.settings.feeToleranceMinor,
        aiProvider: parsed.aiProvider ?? state.entity.settings.aiProvider,
      },
    };
    addAudit(
      state,
      "settings.updated",
      "entity",
      state.entity.id,
      "Workspace settings updated",
      actorName,
    );
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
