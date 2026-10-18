import { money } from "./money";
import type { BankTransaction, Customer, Invoice, Money, PaymentAllocation } from "./types";

export type MatchProposal = {
  status: "proposed" | "ambiguous" | "unmatched";
  confidence: number;
  rationale: string[];
  allocations: PaymentAllocation[];
  invoiceIds: string[];
};

export function normalizeReference(value: string): string {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function containsReference(transaction: BankTransaction, invoice: Invoice): boolean {
  const haystack = normalizeReference(`${transaction.description} ${transaction.reference}`);
  return haystack.includes(normalizeReference(invoice.number));
}

function scoreInvoice(transaction: BankTransaction, invoice: Invoice, customer?: Customer): number {
  let score = 0;
  if (containsReference(transaction, invoice)) score += 70;
  if (
    customer &&
    transaction.counterparty &&
    normalizeReference(transaction.counterparty).includes(normalizeReference(customer.name))
  )
    score += 20;
  if (invoice.total.minor === transaction.amount.minor) score += 40;
  const days = Math.abs(daysBetween(invoice.dueDate, transaction.date));
  if (days <= 7) score += 5;
  return score;
}

function daysBetween(a: string, b: string): number {
  const first = new Date(`${a}T00:00:00Z`).getTime();
  const second = new Date(`${b}T00:00:00Z`).getTime();
  return Math.round((second - first) / 86_400_000);
}

type Candidate = { invoice: Invoice; outstanding: Money; score: number; reference: boolean };

export function proposeMatch(params: {
  transaction: BankTransaction;
  invoices: Invoice[];
  customers: Customer[];
  appliedByInvoice?: Map<string, bigint>;
}): MatchProposal {
  const { transaction } = params;
  if (transaction.flow !== "inflow") {
    return {
      status: "unmatched",
      confidence: 0,
      rationale: ["Outgoing transactions are categorized separately"],
      allocations: [],
      invoiceIds: [],
    };
  }
  const customers = new Map(params.customers.map((customer) => [customer.id, customer]));
  const candidates: Candidate[] = params.invoices
    .filter(
      (invoice) => invoice.status !== "void" && invoice.currency === transaction.amount.currency,
    )
    .filter((invoice) => invoice.issueDate <= transaction.date)
    .map((invoice) => {
      const applied = params.appliedByInvoice?.get(invoice.id) ?? 0n;
      const outstanding = money(invoice.currency, invoice.total.minor - applied);
      return {
        invoice,
        outstanding,
        score: scoreInvoice(transaction, invoice, customers.get(invoice.customerId)),
        reference: containsReference(transaction, invoice),
      };
    })
    .filter((candidate) => candidate.outstanding.minor > 0n)
    .sort((a, b) => b.score - a.score || a.invoice.id.localeCompare(b.invoice.id));

  if (!candidates.length) {
    return {
      status: "unmatched",
      confidence: 0,
      rationale: ["No open invoice in the transaction currency"],
      allocations: [],
      invoiceIds: [],
    };
  }

  const exactReference = candidates.filter((candidate) => candidate.reference);
  if (exactReference.length === 1) {
    const candidate = exactReference[0];
    const amount =
      transaction.amount.minor < candidate.outstanding.minor
        ? transaction.amount
        : candidate.outstanding;
    return {
      status: "proposed",
      confidence: candidate.outstanding.minor === transaction.amount.minor ? 0.99 : 0.93,
      rationale: [
        "Invoice number found in bank reference",
        candidate.outstanding.minor === transaction.amount.minor
          ? "Amount matches exactly"
          : "Payment is a partial settlement",
      ],
      allocations: [{ invoiceId: candidate.invoice.id, amount }],
      invoiceIds: [candidate.invoice.id],
    };
  }
  if (exactReference.length > 1) {
    return {
      status: "ambiguous",
      confidence: 0.45,
      rationale: ["More than one open invoice matched the reference"],
      allocations: [],
      invoiceIds: exactReference.map((item) => item.invoice.id),
    };
  }

  const exactAmount = candidates.filter(
    (candidate) => candidate.outstanding.minor === transaction.amount.minor,
  );
  if (exactAmount.length === 1) {
    return {
      status: "proposed",
      confidence: 0.88,
      rationale: ["One open invoice has the exact outstanding amount"],
      allocations: [{ invoiceId: exactAmount[0].invoice.id, amount: transaction.amount }],
      invoiceIds: [exactAmount[0].invoice.id],
    };
  }
  if (exactAmount.length > 1) {
    return {
      status: "ambiguous",
      confidence: 0.5,
      rationale: ["Several invoices have the same outstanding amount"],
      allocations: [],
      invoiceIds: exactAmount.map((item) => item.invoice.id),
    };
  }

  const subset = findExactSubset(transaction.amount, candidates);
  if (subset.length === 1) {
    const selected = subset[0];
    return {
      status: "proposed",
      confidence: selected.length > 1 ? 0.84 : 0.75,
      rationale: [
        selected.length > 1
          ? `Payment exactly covers ${selected.length} invoices`
          : "Best deterministic amount match",
      ],
      allocations: selected.map((candidate) => ({
        invoiceId: candidate.invoice.id,
        amount: candidate.outstanding,
      })),
      invoiceIds: selected.map((candidate) => candidate.invoice.id),
    };
  }
  if (subset.length > 1) {
    return {
      status: "ambiguous",
      confidence: 0.48,
      rationale: ["Several invoice combinations equal the payment"],
      allocations: [],
      invoiceIds: subset.flat().map((item) => item.invoice.id),
    };
  }

  const top = candidates[0];
  if (top.score >= 70 && transaction.amount.minor < top.outstanding.minor) {
    return {
      status: "proposed",
      confidence: 0.72,
      rationale: ["Reference identifies an invoice", "Payment is smaller than the open balance"],
      allocations: [{ invoiceId: top.invoice.id, amount: transaction.amount }],
      invoiceIds: [top.invoice.id],
    };
  }
  return {
    status: "unmatched",
    confidence: Math.min(top.score / 100, 0.68),
    rationale: ["No unique exact or split match found"],
    allocations: [],
    invoiceIds: [],
  };
}

function findExactSubset(total: Money, candidates: Candidate[]): Candidate[][] {
  const bounded = candidates.slice(0, 18);
  const states = new Map<bigint, Candidate[][]>();
  states.set(0n, [[]]);
  for (const candidate of bounded) {
    const snapshot = [...states.entries()];
    for (const [sum, groups] of snapshot) {
      const next = sum + candidate.outstanding.minor;
      if (next > total.minor) continue;
      const nextGroups = groups.map((group) => [...group, candidate]);
      const existing = states.get(next) ?? [];
      states.set(next, [...existing, ...nextGroups].slice(0, 4));
    }
  }
  return (states.get(total.minor) ?? []).filter((group) => group.length > 0).slice(0, 3);
}
