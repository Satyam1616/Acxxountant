import { add, money, subtract, zero } from "./money";
import type { AgingRow, DomainSnapshot, Invoice, InvoiceStatus, TrialBalanceRow } from "./types";

function dateValue(date: string): number {
  return new Date(`${date}T00:00:00Z`).getTime();
}

function diffDays(later: string, earlier: string): number {
  return Math.floor((dateValue(later) - dateValue(earlier)) / 86_400_000);
}

export function appliedByInvoice(snapshot: DomainSnapshot, asOf?: string): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const match of snapshot.matches) {
    if (match.status !== "approved") continue;
    const transaction = snapshot.transactions.find((item) => item.id === match.bankTransactionId);
    if (asOf && transaction && transaction.date > asOf) continue;
    for (const allocation of match.allocations) {
      result.set(
        allocation.invoiceId,
        (result.get(allocation.invoiceId) ?? 0n) + allocation.amount.minor,
      );
    }
  }
  return result;
}

export function outstanding(invoice: Invoice, applied: Map<string, bigint>): bigint {
  return invoice.total.minor - (applied.get(invoice.id) ?? 0n);
}

export function derivedInvoiceStatus(
  invoice: Invoice,
  applied: Map<string, bigint>,
  asOf: string,
): InvoiceStatus {
  if (invoice.status === "void" || invoice.status === "draft") return invoice.status;
  const remaining = outstanding(invoice, applied);
  if (remaining <= 0n) return "paid";
  if ((applied.get(invoice.id) ?? 0n) > 0n) return "partial";
  return invoice.dueDate < asOf ? "overdue" : "issued";
}

export function trialBalance(snapshot: DomainSnapshot, asOf: string): TrialBalanceRow[] {
  const totals = new Map<string, { debit: bigint; credit: bigint; currency: string }>();
  for (const entry of snapshot.journalEntries) {
    if (entry.date > asOf) continue;
    for (const line of entry.lines) {
      const existing = totals.get(line.accountId) ?? {
        debit: 0n,
        credit: 0n,
        currency: line.amount.currency,
      };
      if (line.side === "debit") existing.debit += line.amount.minor;
      else existing.credit += line.amount.minor;
      totals.set(line.accountId, existing);
    }
  }
  return snapshot.accounts
    .filter((account) => totals.has(account.id))
    .map((account) => {
      const total = totals.get(account.id)!;
      return {
        accountId: account.id,
        accountCode: account.code,
        accountName: account.name,
        accountType: account.type,
        currency: total.currency,
        debit: money(total.currency, total.debit),
        credit: money(total.currency, total.credit),
        balance: money(
          total.currency,
          account.type === "asset" || account.type === "expense"
            ? total.debit - total.credit
            : total.credit - total.debit,
        ),
      };
    })
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

export function agingReport(snapshot: DomainSnapshot, asOf: string): AgingRow[] {
  const applied = appliedByInvoice(snapshot, asOf);
  const customers = new Map(snapshot.customers.map((customer) => [customer.id, customer]));
  const rows = new Map<string, AgingRow>();
  for (const invoice of snapshot.invoices) {
    if (invoice.issueDate > asOf || invoice.status === "void") continue;
    const remaining = outstanding(invoice, applied);
    if (remaining <= 0n) continue;
    const customer = customers.get(invoice.customerId);
    if (!customer) continue;
    const key = `${customer.id}:${invoice.currency}`;
    const current = rows.get(key) ?? {
      customerId: customer.id,
      customerName: customer.name,
      currency: invoice.currency,
      current: zero(invoice.currency),
      overdue1to30: zero(invoice.currency),
      overdue31to60: zero(invoice.currency),
      overdue61to90: zero(invoice.currency),
      overdue90Plus: zero(invoice.currency),
      total: zero(invoice.currency),
    };
    const amount = money(invoice.currency, remaining);
    const age = diffDays(asOf, invoice.dueDate);
    if (age <= 0) current.current = add(current.current, amount);
    else if (age <= 30) current.overdue1to30 = add(current.overdue1to30, amount);
    else if (age <= 60) current.overdue31to60 = add(current.overdue31to60, amount);
    else if (age <= 90) current.overdue61to90 = add(current.overdue61to90, amount);
    else current.overdue90Plus = add(current.overdue90Plus, amount);
    current.total = add(current.total, amount);
    rows.set(key, current);
  }
  return [...rows.values()].sort((a, b) => (b.total.minor > a.total.minor ? 1 : -1));
}

export function profitAndLoss(snapshot: DomainSnapshot, from: string, to: string) {
  const rows = trialBalance(
    {
      ...snapshot,
      journalEntries: snapshot.journalEntries.filter(
        (entry) => entry.date >= from && entry.date <= to,
      ),
    },
    to,
  );
  const income = rows.filter((row) => row.accountType === "income");
  const expenses = rows.filter((row) => row.accountType === "expense");
  const currency = snapshot.entity.currency;
  const incomeTotal = income.reduce((sum, row) => add(sum, row.balance), zero(currency));
  const expenseTotal = expenses.reduce((sum, row) => add(sum, row.balance), zero(currency));
  return { income, expenses, incomeTotal, expenseTotal, net: subtract(incomeTotal, expenseTotal) };
}

export function balanceSheet(snapshot: DomainSnapshot, asOf: string) {
  const rows = trialBalance(snapshot, asOf);
  const currency = snapshot.entity.currency;
  const assets = rows
    .filter((row) => row.accountType === "asset")
    .reduce((sum, row) => add(sum, row.balance), zero(currency));
  const liabilities = rows
    .filter((row) => row.accountType === "liability")
    .reduce((sum, row) => add(sum, row.balance), zero(currency));
  const equity = rows
    .filter((row) => row.accountType === "equity")
    .reduce((sum, row) => add(sum, row.balance), zero(currency));
  const income = rows
    .filter((row) => row.accountType === "income")
    .reduce((sum, row) => add(sum, row.balance), zero(currency));
  const expenses = rows
    .filter((row) => row.accountType === "expense")
    .reduce((sum, row) => add(sum, row.balance), zero(currency));
  const currentEarnings = subtract(income, expenses);
  return {
    assets,
    liabilities,
    equity,
    currentEarnings,
    difference: subtract(assets, add(add(liabilities, equity), currentEarnings)),
  };
}
