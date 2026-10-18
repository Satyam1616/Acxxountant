import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { approveTransaction, getDashboard, getReports, undoTransaction } from "@/lib/application";
import { proposeMatch } from "@/lib/domain/matching";
import { validateJournalEntry, journalBalance } from "@/lib/domain/ledger";
import { parseBankCsv } from "@/lib/domain/import";
import { formatMoney, parseAmount } from "@/lib/domain/money";
import type { Account, BankTransaction, Customer, Invoice } from "@/lib/domain/types";
import { resetState, getState } from "@/lib/store";
import { snapshotFromStored } from "@/lib/store/serialize";

const usd = (minor: bigint) => ({ currency: "USD", minor });
const accounts: Account[] = [
  {
    id: "bank",
    code: "1000",
    name: "Bank",
    type: "asset",
    control: "bank",
    currency: "USD",
    active: true,
  },
  {
    id: "ar",
    code: "1100",
    name: "AR",
    type: "asset",
    control: "receivable",
    currency: "USD",
    active: true,
  },
  {
    id: "revenue",
    code: "4000",
    name: "Revenue",
    type: "income",
    control: null,
    currency: "USD",
    active: true,
  },
];

describe("money", () => {
  it("parses and formats exact minor units without floating point", () => {
    const value = parseAmount("12,500", "USD");
    expect(value.minor).toBe(1250000n);
    expect(formatMoney(value)).toBe("USD 12,500.00");
    expect(() => parseAmount("1.001", "USD")).toThrow("too_many_decimals");
    expect(parseAmount("100", "JPY").minor).toBe(100n);
  });
});

describe("matching", () => {
  const customer: Customer = {
    id: "customer",
    entityId: "entity",
    name: "Acme",
    email: "ap@example.com",
    currency: "USD",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const invoice = (id: string, number: string, total: bigint): Invoice => ({
    id,
    entityId: "entity",
    customerId: customer.id,
    number,
    issueDate: "2026-01-01",
    dueDate: "2026-01-15",
    currency: "USD",
    lines: [],
    total: usd(total),
    status: "issued",
    createdAt: "2026-01-01T00:00:00Z",
  });
  const transaction: BankTransaction = {
    id: "bank_tx",
    entityId: "entity",
    externalId: "wire",
    date: "2026-01-12",
    amount: usd(10000n),
    flow: "inflow",
    description: "Acme remittance",
    reference: "WIRE",
    counterparty: "Acme",
    status: "unreviewed",
    createdAt: "2026-01-12T00:00:00Z",
  };

  it("finds a unique exact split and refuses ambiguous combinations", () => {
    const proposal = proposeMatch({
      transaction,
      invoices: [invoice("one", "INV-1", 4000n), invoice("two", "INV-2", 6000n)],
      customers: [customer],
    });
    expect(proposal.status).toBe("proposed");
    expect(proposal.allocations.map((item) => item.invoiceId)).toEqual(["one", "two"]);
    const ambiguous = proposeMatch({
      transaction,
      invoices: [
        invoice("a", "INV-A", 4000n),
        invoice("b", "INV-B", 6000n),
        invoice("c", "INV-C", 4000n),
        invoice("d", "INV-D", 6000n),
      ],
      customers: [customer],
    });
    expect(ambiguous.status).toBe("ambiguous");
  });
});

describe("ledger and import", () => {
  it("accepts balanced entries and rejects drift", () => {
    const entry = {
      id: "entry",
      entityId: "entity",
      date: "2026-01-01",
      description: "Test",
      source: "manual" as const,
      sourceId: "test",
      createdAt: "2026-01-01T00:00:00Z",
      lines: [
        { id: "d", accountId: "bank", side: "debit" as const, amount: usd(100n) },
        { id: "c", accountId: "revenue", side: "credit" as const, amount: usd(100n) },
      ],
    };
    expect(() => validateJournalEntry(entry, accounts)).not.toThrow();
    expect(journalBalance(entry).minor).toBe(0n);
    expect(() =>
      validateJournalEntry(
        {
          ...entry,
          lines: [
            ...entry.lines,
            { id: "extra", accountId: "revenue", side: "credit" as const, amount: usd(1n) },
          ],
        },
        accounts,
      ),
    ).toThrow("journal_unbalanced");
  });

  it("imports debit/credit CSV variants and keeps duplicate-safe references", () => {
    const result = parseBankCsv(
      "Date,Debit,Credit,Description,Reference\n2026-10-01,,125.50,Acme payment,INV-1\n2026-10-02,20.00,,AWS cloud,AWS-1",
      "USD",
    );
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].amount.minor).toBe(12550n);
    expect(result.rows[0].flow).toBe("inflow");
    expect(result.rows[1].flow).toBe("outflow");
  });
});

describe("application workflow", () => {
  beforeEach(async () => {
    await resetState();
  });
  afterAll(async () => {
    await resetState();
  });

  it("approves a suggested payment, updates the invoice, and preserves balance", async () => {
    await approveTransaction("bank_2", { mode: "suggestion" });
    const state = await getState();
    const snapshot = snapshotFromStored(state);
    const transaction = snapshot.transactions.find((item) => item.id === "bank_2");
    expect(transaction?.status).toBe("posted");
    const invoice = snapshot.invoices.find((item) => item.id === "inv_1043");
    expect(invoice?.status).toBe("paid");
    const entry = snapshot.journalEntries.find((item) => item.id === transaction?.journalEntryId);
    expect(entry && journalBalance(entry).minor).toBe(0n);
    const report = await getReports("2026-10-18");
    expect(report.balanceSheet.difference.minor).toBe(0n);
  });

  it("posts an outgoing category with a balanced journal", async () => {
    await approveTransaction("bank_4", { mode: "category" });
    const state = await getState();
    const snapshot = snapshotFromStored(state);
    const transaction = snapshot.transactions.find((item) => item.id === "bank_4");
    expect(transaction?.status).toBe("posted");
    const entry = transaction?.journalEntryId
      ? snapshot.journalEntries.find((item) => item.id === transaction.journalEntryId)
      : undefined;
    expect(entry && journalBalance(entry).minor).toBe(0n);
  });

  it("reverses a posted payment instead of mutating the original entry", async () => {
    await approveTransaction("bank_2", { mode: "suggestion" });
    const before = snapshotFromStored(await getState());
    const originalId = before.transactions.find((item) => item.id === "bank_2")?.journalEntryId;
    await undoTransaction("bank_2");
    const after = snapshotFromStored(await getState());
    const transaction = after.transactions.find((item) => item.id === "bank_2");
    const original = after.journalEntries.find((item) => item.id === originalId);
    const reversal = after.journalEntries.find((item) => item.reverses === originalId);
    expect(transaction?.status).toBe("suggested");
    expect(original?.reversedBy).toBe(reversal?.id);
    expect(reversal && journalBalance(reversal).minor).toBe(0n);
    expect(after.invoices.find((item) => item.id === "inv_1043")?.status).toBe("issued");
  });

  it("keeps JSON money serializable after the workflow", async () => {
    const dashboard = await getDashboard();
    expect(() =>
      JSON.stringify(dashboard, (_, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toThrow();
  });
});
