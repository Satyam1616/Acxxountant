import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  approveTransaction,
  createCustomer,
  createInvoice,
  getDashboard,
  getReports,
  importTransactions,
  saveSettings,
  undoTransaction,
} from "@/lib/application";
import { proposeMatch } from "@/lib/domain/matching";
import { validateJournalEntry, journalBalance } from "@/lib/domain/ledger";
import {
  buildPayableInvoiceJournal,
  buildSalesCreditNoteJournal,
  calculateTax,
  convertMoney,
  resolveFiscalPeriod,
  roundHalfUp,
} from "@/lib/domain/accounting-extensions";
import { parseBankCsv } from "@/lib/domain/import";
import { formatMoney, parseAmount } from "@/lib/domain/money";
import type { Account, BankTransaction, Customer, Invoice } from "@/lib/domain/types";
import { resetState, getState, updateState } from "@/lib/store";
import { snapshotFromStored } from "@/lib/store/serialize";
import { validateStorageState } from "@/lib/store/schema";
import { createSeedState } from "@/lib/store/seed";

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

  it("parses rupees and uses Indian lakh/crore grouping", () => {
    const value = parseAmount("₹1,23,456.78", "INR");
    expect(value.minor).toBe(12345678n);
    expect(formatMoney(value)).toBe("₹1,23,456.78");
    expect(formatMoney({ currency: "INR", minor: -12345678n })).toBe("-₹1,23,456.78");
    expect(formatMoney({ currency: "INR", minor: 1234567890n })).toBe("₹1,23,45,678.90");
    expect(parseAmount("-₹1,23,456.78", "INR").minor).toBe(-12345678n);
    expect(() => parseAmount("1.001", "INR")).toThrow("too_many_decimals");
  });

  it("rejects unsupported currencies in persisted state", () => {
    const state = createSeedState();
    expect(() =>
      validateStorageState({
        ...state,
        entity: { ...state.entity, currency: "ZZZ" },
      }),
    ).toThrow();
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
    const falsePrefix = proposeMatch({
      transaction: {
        ...transaction,
        reference: "INV-10420",
        description: "Payment INV-10420",
        amount: usd(10000n),
      },
      invoices: [invoice("short", "INV-1042", 10000n)],
      customers: [customer],
    });
    expect(falsePrefix.status).toBe("proposed");
    expect(falsePrefix.confidence).toBeLessThan(0.99);
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
    const suffixMarkers = parseBankCsv(
      "Date,Amount,Description\n2026-10-03,20DR,Fee\n2026-10-04,20CR,Refund",
      "USD",
    );
    expect(suffixMarkers.errors).toHaveLength(0);
    expect(suffixMarkers.rows.map((row) => row.flow)).toEqual(["outflow", "inflow"]);
    expect(parseBankCsv("Date,Amount\n2026-02-31,1.00", "USD").errors[0]?.message).toContain(
      "invalid_date",
    );
    const rupees = parseBankCsv(
      'Date,Amount,Description\n2026-10-05,"₹1,23,456.78",Indian customer payment',
      "INR",
    );
    expect(rupees.errors).toHaveLength(0);
    expect(rupees.rows[0].amount).toMatchObject({ currency: "INR", minor: 12345678n });
    const duplicates = parseBankCsv(
      "Date,Amount,Description\n2026-10-05,10.00,Same\n2026-10-05,10.00,Same",
      "USD",
    );
    expect(new Set(duplicates.rows.map((row) => row.externalId)).size).toBe(2);
  });
});

describe("tax, FX, periods, and payable extensions", () => {
  it("calculates exact tax and rational FX without floats", () => {
    const rate = {
      id: "vat",
      code: "VAT",
      ratePpm: 200_000n,
      effectiveFrom: "2026-01-01",
      outputAccountId: "tax",
      inputAccountId: "tax",
      active: true,
    };
    const tax = calculateTax({ amount: usd(1000n), rate, mode: "exclusive" });
    expect(tax.tax.minor).toBe(200n);
    expect(calculateTax({ amount: usd(1200n), rate, mode: "inclusive" }).net.minor).toBe(1000n);
    expect(
      convertMoney(
        { currency: "EUR", minor: 10_000n },
        {
          id: "fx",
          fromCurrency: "EUR",
          toCurrency: "USD",
          numerator: 11n,
          denominator: 10n,
          effectiveFrom: "2026-01-01",
          purpose: "transaction",
        },
      ).minor,
    ).toBe(11_000n);
    expect(roundHalfUp(5n, 2n)).toBe(3n);
  });

  it("rejects closed periods and balances payable/credit-note postings", () => {
    expect(() =>
      resolveFiscalPeriod(
        [{ id: "closed", startDate: "2026-01-01", endDate: "2027-01-01", status: "closed" }],
        "2026-10-18",
      ),
    ).toThrow("fiscal_period_closed");
    const extensionAccounts: Account[] = [
      {
        id: "expense",
        code: "6000",
        name: "Expense",
        type: "expense",
        control: null,
        currency: "USD",
        active: true,
      },
      {
        id: "ap",
        code: "2000",
        name: "AP",
        type: "liability",
        control: "payable",
        currency: "USD",
        active: true,
      },
      {
        id: "returns",
        code: "4100",
        name: "Returns",
        type: "income",
        control: null,
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
    ];
    const payable = buildPayableInvoiceJournal({
      document: {
        id: "bill-1",
        entityId: "entity",
        date: "2026-10-18",
        currency: "USD",
        total: usd(1000n),
        lines: [{ accountId: "expense", amount: usd(1000n) }],
      },
      payableAccountId: "ap",
      accounts: extensionAccounts,
      createdAt: "2026-10-18T00:00:00Z",
    });
    expect(journalBalance(payable).minor).toBe(0n);
    const credit = buildSalesCreditNoteJournal({
      id: "cn-1",
      entityId: "entity",
      date: "2026-10-18",
      total: usd(120n),
      returnsAccountId: "returns",
      taxAccountId: "expense",
      tax: usd(20n),
      arAccountId: "ar",
      createdAt: "2026-10-18T00:00:00Z",
    });
    expect(journalBalance(credit).minor).toBe(0n);
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

  it("uses INR and India defaults for a fresh workspace", async () => {
    const dashboard = await getDashboard();
    expect(dashboard.entity.currency).toBe("INR");
    expect(dashboard.entity.timezone).toBe("Asia/Kolkata");
    expect(dashboard.metrics.outstanding.currency).toBe("INR");
    expect(dashboard.invoices.every((invoice) => invoice.currency === "INR")).toBe(true);
    expect(dashboard.invoices.find((invoice) => invoice.id === "inv_1042")?.total.minor).toBe(
      12500000n,
    );
    const invoice = await createInvoice({
      customerId: "cust_acme",
      description: "INR implementation test",
      amount: "₹1,25,000.50",
      dueDate: "2099-01-01",
    });
    expect(invoice.currency).toBe("INR");
    expect(invoice.total.minor).toBe(12500050n);
    expect(invoice.lines[0]?.unitMinor).toBe(12500050n);
  });

  it("creates a customer, issues an INR invoice, imports paise and posts a balanced payment", async () => {
    const customer = await createCustomer({ name: "India Test", email: "inr@example.com" });
    expect(customer.currency).toBe("INR");
    const invoice = await createInvoice({
      customerId: customer.id,
      description: "Exact INR services",
      amount: "₹1,25,000.50",
      dueDate: "2099-01-01",
    });
    const date = invoice.issueDate.split("-").reverse().join("/");
    const csv = `Date,Amount,Description,Reference,Counterparty,Currency\n${date},"₹1,25,000.50",NEFT payment,${invoice.number},India Test,INR`;
    expect(await importTransactions(csv)).toMatchObject({ imported: 1, errors: [] });
    expect(await importTransactions(csv)).toMatchObject({ imported: 0, skipped: 1 });
    const transaction = (await getState()).transactions.find(
      (item) => item.reference === invoice.number,
    )!;
    expect(transaction.date).toBe(invoice.issueDate);
    expect(transaction.amount).toEqual({ currency: "INR", minor: "12500050" });
    await approveTransaction(transaction.id, { mode: "suggestion" });
    const snapshot = snapshotFromStored(await getState());
    expect(snapshot.invoices.find((item) => item.id === invoice.id)?.status).toBe("paid");
    for (const entry of snapshot.journalEntries) {
      expect(() => validateJournalEntry(entry, snapshot.accounts)).not.toThrow();
      expect(entry.lines.every((line) => line.amount.currency === "INR")).toBe(true);
    }
    const reports = await getReports(invoice.issueDate);
    expect(reports.balanceSheet.difference.minor).toBe(0n);
    expect(reports.pnl.net.currency).toBe("INR");
  });

  it("keeps currency locked after any activity and leaves all records unchanged on rejection", async () => {
    const before = structuredClone(await getState());
    expect((await getDashboard()).currencyChangeAllowed).toBe(false);
    await expect(saveSettings({ currency: "USD" })).rejects.toMatchObject({
      code: "currency_change_forbidden",
    });
    expect(await getState()).toEqual(before);
    await saveSettings({ currency: "INR", timezone: "Asia/Kolkata", feeToleranceMinor: "2500" });
    expect((await getState()).entity.settings.feeToleranceMinor).toBe("2500");
  });

  it("can change an unused currency and still post the first invoice", async () => {
    await updateState((state) => {
      state.invoices = [];
      state.transactions = [];
      state.journalEntries = [];
      state.matches = [];
    });
    expect((await getDashboard()).currencyChangeAllowed).toBe(true);
    await saveSettings({ currency: "USD" });
    expect((await getState()).accounts.every((account) => account.currency === "USD")).toBe(true);
    await saveSettings({ currency: "INR" });
    const invoice = await createInvoice({
      customerId: "cust_acme",
      description: "First invoice",
      amount: "₹100.25",
      dueDate: "2099-01-01",
    });
    expect(invoice.total).toEqual({ currency: "INR", minor: 10025n });
    expect((await getDashboard()).currencyChangeAllowed).toBe(false);
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

  it("derives overdue status and preserves writes after a failed mutation", async () => {
    const dashboard = await getDashboard();
    expect(dashboard.invoices.find((invoice) => invoice.id === "inv_1044")?.status).toBe("overdue");
    await expect(
      updateState(() => {
        throw new Error("expected validation failure");
      }),
    ).rejects.toThrow("expected validation failure");
    const customer = await createCustomer({ name: "After Failure", email: "after@example.com" });
    expect(customer.name).toBe("After Failure");
  });

  it("rejects invalid settings before mutating state", async () => {
    await expect(saveSettings({ autoApplyThreshold: 4 })).rejects.toThrow();
    await expect(saveSettings({ currency: "ZZZ" })).rejects.toThrow();
    const state = await getState();
    expect(state.entity.settings.autoApplyThreshold).toBe(0.9);
  });

  it("generates unique postings across approve, undo, reapprove, and undo", async () => {
    await approveTransaction("bank_2", { mode: "suggestion" });
    await undoTransaction("bank_2");
    await approveTransaction("bank_2", { mode: "suggestion" });
    const beforeSecondUndo = snapshotFromStored(await getState());
    const currentJournalId = beforeSecondUndo.transactions.find(
      (item) => item.id === "bank_2",
    )?.journalEntryId;
    await undoTransaction("bank_2");
    const afterSecondUndo = snapshotFromStored(await getState());
    const matchingEntries = afterSecondUndo.journalEntries.filter(
      (entry) => entry.sourceId === "bank_2",
    );
    expect(new Set(matchingEntries.map((entry) => entry.id)).size).toBe(matchingEntries.length);
    expect(
      afterSecondUndo.journalEntries.find((entry) => entry.id === currentJournalId)?.reversedBy,
    ).toBeTruthy();
  });
});
