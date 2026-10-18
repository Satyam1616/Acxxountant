import { DomainError, invariant } from "./errors";
import { add, money, subtract, zero } from "./money";
import type { Account, JournalEntry, JournalLine, Money, JournalSide } from "./types";

export type RationalRate = {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  numerator: bigint;
  denominator: bigint;
  effectiveFrom: string;
  effectiveTo?: string;
  purpose: "transaction" | "closing";
};

export type TaxRate = {
  id: string;
  code: string;
  ratePpm: bigint;
  effectiveFrom: string;
  effectiveTo?: string;
  outputAccountId: string;
  inputAccountId: string;
  active: boolean;
};

export type FiscalPeriod = {
  id: string;
  startDate: string;
  endDate: string;
  status: "open" | "closed" | "locked";
};

export type TaxCalculation = {
  net: Money;
  tax: Money;
  gross: Money;
  ratePpm: bigint;
  rateId: string;
};

export type PayableDocument = {
  id: string;
  entityId: string;
  date: string;
  currency: string;
  total: Money;
  lines: Array<{ accountId: string; amount: Money; memo?: string }>;
};

export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  invariant(denominator > 0n, "invalid_rounding_denominator");
  if (numerator < 0n) return -roundHalfUp(-numerator, denominator);
  return (numerator + denominator / 2n) / denominator;
}

export function convertMoney(value: Money, rate: RationalRate): Money {
  invariant(value.currency === rate.fromCurrency, "fx_currency_mismatch");
  invariant(rate.numerator > 0n && rate.denominator > 0n, "invalid_fx_rate");
  return money(rate.toCurrency, roundHalfUp(value.minor * rate.numerator, rate.denominator));
}

export function calculateTax(input: {
  amount: Money;
  rate: TaxRate;
  mode: "exclusive" | "inclusive";
}): TaxCalculation {
  invariant(input.rate.ratePpm >= 0n && input.rate.ratePpm <= 1_000_000n, "invalid_tax_rate");
  const scale = 1_000_000n;
  const taxMinor =
    input.mode === "exclusive"
      ? roundHalfUp(input.amount.minor * input.rate.ratePpm, scale)
      : roundHalfUp(input.amount.minor * input.rate.ratePpm, scale + input.rate.ratePpm);
  const tax = money(input.amount.currency, taxMinor);
  const net = input.mode === "exclusive" ? input.amount : subtract(input.amount, tax);
  return { net, tax, gross: add(net, tax), ratePpm: input.rate.ratePpm, rateId: input.rate.id };
}

export function resolveTaxRate(rates: TaxRate[], date: string, code: string): TaxRate {
  const matches = rates.filter(
    (rate) =>
      rate.active &&
      rate.code === code &&
      rate.effectiveFrom <= date &&
      (!rate.effectiveTo || date <= rate.effectiveTo),
  );
  invariant(matches.length === 1, matches.length ? "ambiguous_tax_rate" : "tax_rate_not_found");
  return matches[0];
}

export function resolveFiscalPeriod(periods: FiscalPeriod[], date: string): FiscalPeriod {
  const matches = periods.filter((period) => period.startDate <= date && date < period.endDate);
  invariant(
    matches.length === 1,
    matches.length ? "ambiguous_fiscal_period" : "fiscal_period_not_found",
  );
  invariant(matches[0].status === "open", "fiscal_period_closed");
  return matches[0];
}

export function buildPayableInvoiceJournal(input: {
  document: PayableDocument;
  payableAccountId: string;
  accounts: Account[];
  createdAt: string;
}): JournalEntry {
  const { document } = input;
  invariant(document.total.minor > 0n, "payable_total_must_be_positive");
  const totalLines = document.lines.reduce(
    (sum, line) => add(sum, line.amount),
    zero(document.currency),
  );
  invariant(totalLines.minor === document.total.minor, "payable_lines_do_not_total_document");
  const payable = input.accounts.find((account) => account.id === input.payableAccountId);
  invariant(payable?.active && payable.control === "payable", "payable_account_required");
  const lines: JournalLine[] = document.lines.map((line, index) => ({
    id: `${document.id}:expense:${index}`,
    accountId: line.accountId,
    side: "debit" as JournalSide,
    amount: line.amount,
    memo: line.memo,
  }));
  lines.push({
    id: `${document.id}:payable`,
    accountId: input.payableAccountId,
    side: "credit",
    amount: document.total,
    memo: `Accounts payable for ${document.id}`,
  });
  return {
    id: `je_${document.id}`,
    entityId: document.entityId,
    date: document.date,
    description: `Payable invoice ${document.id}`,
    source: "payable-invoice",
    sourceId: document.id,
    lines,
    createdAt: input.createdAt,
  };
}

export function assertCreditNoteWithinBalance(amount: Money, openBalance: Money): void {
  invariant(amount.currency === openBalance.currency, "credit_note_currency_mismatch");
  invariant(amount.minor > 0n, "credit_note_must_be_positive");
  if (amount.minor > openBalance.minor)
    throw new DomainError(
      "credit_note_exceeds_balance",
      "Credit note exceeds the open document balance",
    );
}

export function buildSalesCreditNoteJournal(input: {
  id: string;
  entityId: string;
  date: string;
  total: Money;
  returnsAccountId: string;
  taxAccountId?: string;
  tax?: Money;
  arAccountId: string;
  createdAt: string;
}): JournalEntry {
  const net = input.tax ? subtract(input.total, input.tax) : input.total;
  const lines: JournalLine[] = [
    {
      id: `${input.id}:returns`,
      accountId: input.returnsAccountId,
      side: "debit",
      amount: net,
      memo: "Sales return",
    },
  ];
  if (input.tax && input.tax.minor > 0n) {
    invariant(input.taxAccountId, "credit_note_tax_account_required");
    lines.push({
      id: `${input.id}:tax`,
      accountId: input.taxAccountId,
      side: "debit",
      amount: input.tax,
      memo: "Reverse output tax",
    });
  }
  lines.push({
    id: `${input.id}:ar`,
    accountId: input.arAccountId,
    side: "credit",
    amount: input.total,
    memo: "Credit customer receivable",
  });
  return {
    id: `je_${input.id}`,
    entityId: input.entityId,
    date: input.date,
    description: `Credit note ${input.id}`,
    source: "credit-note",
    sourceId: input.id,
    lines,
    createdAt: input.createdAt,
  };
}
