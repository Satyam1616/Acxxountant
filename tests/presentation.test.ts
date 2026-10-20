import { describe, expect, it } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import LandingScreen from "@/components/LandingScreen";
import {
  CustomerModal,
  Customers,
  ImportModal,
  InvoiceModal,
  Overview,
  Settings,
} from "@/components/Workspace";
import { supportedCurrencies } from "@/lib/domain/currency";
import { parseBankCsv } from "@/lib/domain/import";
import {
  amountPlaceholder,
  amountPrecisionHint,
  bankCsvExample,
  dateLabel,
  invoiceDueDate,
  moneyLabel,
} from "@/lib/presentation";

type Dashboard = ComponentProps<typeof Overview>["dashboard"];
const noop = () => undefined;

function dashboardFixture(currency = "INR", timezone = "Asia/Kolkata"): Dashboard {
  const zero = { currency, minor: "0" };
  return {
    entity: {
      name: "Example workspace",
      legalName: "Example company",
      currency,
      timezone,
      settings: { autoApplyThreshold: 0.95, feeToleranceMinor: "100", aiProvider: "rules" },
    },
    reportingDate: "2026-10-20",
    currencyChangeAllowed: true,
    storage: { adapter: "memory", durable: false, ephemeral: true },
    metrics: {
      outstanding: zero,
      overdue: zero,
      collectedThisMonth: zero,
      needsReview: 0,
      matchedThisMonth: 0,
    },
    accounts: [],
    transactions: [],
    aging: [],
    recentTransactions: [],
    reviewQueue: [],
    invoices: [],
    customers: [{ id: "customer_example", name: "Example customer", email: "ap@example.test" }],
  };
}

describe("exact money presentation", () => {
  it.each([
    ["INR", "0", "₹0.00"],
    ["INR", "12345678", "₹1,23,456.78"],
    ["INR", "-1234567890", "-₹1,23,45,678.90"],
    ["USD", "1234567890123456789", "USD 12,345,678,901,234,567.89"],
    ["EUR", "-1234567890", "-EUR 12,345,678.90"],
    ["GBP", "125050", "GBP 1,250.50"],
    ["CAD", "125050", "CAD 1,250.50"],
    ["JPY", "123456789", "JPY 123,456,789"],
    ["KRW", "-123456789", "-KRW 123,456,789"],
    ["BHD", "1234567", "BHD 1,234.567"],
    ["KWD", "-1234567", "-KWD 1,234.567"],
  ])("shows the full exact %s amount %s", (currency, minor, expected) => {
    expect(moneyLabel({ currency, minor })).toBe(expected);
  });

  it("uses an empty label only for absent money", () => {
    expect(moneyLabel()).toBe("—");
  });
});

describe("business date presentation", () => {
  it("uses day-first INR labels, including the reporting heading", () => {
    expect(dateLabel("2026-10-20", "INR")).toBe("20 Oct 2026");
    expect(dateLabel("2026-10-20", "INR", "short")).toBe("20 Oct");
    expect(dateLabel("2026-10-20", "INR", "long")).toBe("Tuesday, 20 October 2026");
  });

  it.each(supportedCurrencies.filter((currency) => currency !== "INR"))(
    "preserves the existing US date style for %s",
    (currency) => {
      expect(dateLabel("2026-10-20", currency)).toBe("Oct 20, 2026");
      expect(dateLabel("2026-10-20", currency, "short")).toBe("Oct 20");
    },
  );

  it.each([
    ["2026-10-20", "2026-11-19"],
    ["2026-12-15", "2027-01-14"],
    ["2028-01-31", "2028-03-01"],
    ["2028-02-01", "2028-03-02"],
    ["2026-03-01", "2026-03-31"],
  ])("defaults an invoice due date to 30 calendar days after %s", (reportingDate, dueDate) => {
    expect(invoiceDueDate(reportingDate)).toBe(dueDate);
  });

  it("rejects invalid dates instead of silently displaying a different day", () => {
    expect(() => dateLabel("2026-02-30", "INR")).toThrow();
    expect(() => invoiceDueDate("2026-02-30")).toThrow();
  });
});

describe("currency-aware input examples", () => {
  it.each([
    ["INR", "₹1,25,000.00", "Use up to 2 decimal places for INR."],
    ["USD", "1,250.00", "Use up to 2 decimal places for USD."],
    ["JPY", "1,250", "JPY uses whole amounts (no decimal places)."],
    ["KRW", "1,250", "KRW uses whole amounts (no decimal places)."],
    ["BHD", "1,250.000", "Use up to 3 decimal places for BHD."],
    ["KWD", "1,250.000", "Use up to 3 decimal places for KWD."],
  ])("shows a valid amount and precision hint for %s", (currency, placeholder, hint) => {
    expect(amountPlaceholder(currency)).toBe(placeholder);
    expect(amountPrecisionHint(currency)).toBe(hint);
  });

  it.each(supportedCurrencies)("provides a usable, clearly named %s CSV example", (currency) => {
    const result = parseBankCsv(bankCsvExample(currency), currency);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      date: "2026-10-20",
      amount: { currency },
      reference: "EXAMPLE-001",
      description: "Example customer payment",
    });
  });
});

describe("workspace overview presentation", () => {
  it.each(["Asia/Kolkata", "Pacific/Kiritimati", "Etc/GMT+12", "America/Los_Angeles"])(
    "keeps the recorded day for an INR workspace in %s",
    (timezone) => {
      const dashboard = dashboardFixture("INR", timezone);
      dashboard.reportingDate = "2026-12-31";
      dashboard.recentTransactions = [
        {
          id: "transaction_example",
          date: "2026-12-31",
          amount: { currency: "INR", minor: "12500000" },
          flow: "inflow",
          description: "Example NEFT payment",
          reference: "EXAMPLE-001",
          status: "unreviewed",
        },
      ];
      const html = renderToStaticMarkup(
        createElement(Overview, { dashboard, onNavigate: noop, canMutate: false }),
      );
      expect(html).toContain("Thursday, 31 December 2026");
      expect(html).toContain("as of 31 Dec 2026");
      expect(html).toContain("Awaiting review · 31 Dec");
      expect(html).toContain("+₹1,25,000.00");
      expect(html).not.toContain("New invoice");
      expect(html).not.toContain("Import transactions");
    },
  );

  it("keeps US labels in a non-INR workspace even with a UTC+14 timezone", () => {
    const dashboard = dashboardFixture("USD", "Pacific/Kiritimati");
    dashboard.reportingDate = "2026-12-31";
    const html = renderToStaticMarkup(
      createElement(Overview, { dashboard, onNavigate: noop, canMutate: false }),
    );
    expect(html).toContain("Thursday, December 31, 2026");
    expect(html).toContain("as of Dec 31, 2026");
  });

  it("shows the full aging balance beyond safe integer precision without compact slicing", () => {
    const dashboard = dashboardFixture("USD");
    const total = { currency: "USD", minor: "1234567890123456789" };
    const zero = { currency: "USD", minor: "0" };
    dashboard.aging = [
      {
        customerId: "customer_example",
        customerName: "Example customer",
        currency: "USD",
        current: total,
        overdue1to30: zero,
        overdue31to60: zero,
        overdue61to90: zero,
        overdue90Plus: zero,
        total,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(Overview, { dashboard, onNavigate: noop, canMutate: true }),
    );
    const agingRow = html.match(/class="aging-row"[\s\S]*?<\/strong>/)?.[0];
    expect(agingRow).toContain("<strong>USD 12,345,678,901,234,567.89</strong>");
  });
});

describe("workspace currency settings", () => {
  it("honors the server lock for ledger-only or match-only activity", () => {
    const dashboard = dashboardFixture();
    dashboard.currencyChangeAllowed = false;
    const html = renderToStaticMarkup(
      createElement(Settings, { dashboard, onSaved: noop, onError: noop, canEdit: true }),
    );
    expect(dashboard.invoices).toEqual([]);
    expect(dashboard.transactions).toEqual([]);
    expect(html.match(/Base currency\s*<select([^>]*)>/)?.[1]).toContain('disabled=""');
    expect(html).toContain('aria-describedby="currency-lock-hint"');
    expect(html).toContain("journal entries, or matches exist.");
    expect(html).not.toContain("Create a new workspace");
  });

  it("offers all supported currencies when the server allows an admin to change currency", () => {
    const html = renderToStaticMarkup(
      createElement(Settings, {
        dashboard: dashboardFixture(),
        onSaved: noop,
        onError: noop,
        canEdit: true,
      }),
    );
    const select = html.match(/Base currency\s*<select([^>]*)>/)?.[1];
    expect(select).toBeDefined();
    expect(select).not.toContain("disabled");
    for (const currency of supportedCurrencies) {
      expect(html).toContain(`<option value="${currency}"`);
    }
    expect(html).toContain("Save changes");
  });

  it("preserves read-only permissions even when currency changes are allowed", () => {
    const html = renderToStaticMarkup(
      createElement(Settings, {
        dashboard: dashboardFixture(),
        onSaved: noop,
        onError: noop,
        canEdit: false,
      }),
    );
    expect(html.match(/Base currency\s*<select([^>]*)>/)?.[1]).toContain('disabled=""');
    expect(html).not.toContain("Save changes");
  });
});

describe("currency-aware dialogs", () => {
  it("shows the remaining INR customer balance after a partial payment", () => {
    const dashboard = dashboardFixture();
    dashboard.invoices = [
      {
        id: "partial-invoice",
        number: "INV-PARTIAL",
        customerId: "customer_example",
        issueDate: "2026-10-20",
        dueDate: "2026-11-20",
        status: "partial",
        lines: [],
        total: { currency: "INR", minor: "12500050" },
        outstanding: { currency: "INR", minor: "2500050" },
      },
    ];
    const html = renderToStaticMarkup(
      createElement(Customers, { dashboard, query: "", canMutate: false }),
    );
    expect(html).toContain("₹25,000.50");
    expect(html).not.toContain("₹1,25,000.50");
  });

  it.each([
    ["INR", "₹1,25,000.00", "decimal", "Use up to 2 decimal places for INR."],
    ["USD", "1,250.00", "decimal", "Use up to 2 decimal places for USD."],
    ["JPY", "1,250", "numeric", "JPY uses whole amounts (no decimal places)."],
    ["KRW", "1,250", "numeric", "KRW uses whole amounts (no decimal places)."],
    ["BHD", "1,250.000", "decimal", "Use up to 3 decimal places for BHD."],
    ["KWD", "1,250.000", "decimal", "Use up to 3 decimal places for KWD."],
  ])("shows %s invoice amounts with the correct precision", (currency, placeholder, mode, hint) => {
    const dashboard = dashboardFixture(currency, "Pacific/Kiritimati");
    dashboard.reportingDate = "2028-01-31";
    const html = renderToStaticMarkup(
      createElement(InvoiceModal, { dashboard, onClose: noop, onCreated: noop }),
    );
    expect(html).toContain(`Amount (${currency}${currency === "INR" ? " · ₹" : ""})`);
    expect(html).toContain(`placeholder="${placeholder}"`);
    expect(html).toContain(`inputMode="${mode}"`);
    expect(html).toContain(hint);
    expect(html).toMatch(/<input[^>]*type="date"[^>]*value="2028-03-01"/);
  });

  it.each(supportedCurrencies)("shows the customer's workspace currency (%s)", (currency) => {
    const html = renderToStaticMarkup(
      createElement(CustomerModal, { currency, onClose: noop, onCreated: noop }),
    );
    expect(html).toContain("Billing currency");
    expect(html).toContain(`<strong>${currency} — `);
    expect(html).toContain("Invoices for this customer use the workspace currency.");
  });

  it.each(supportedCurrencies)(
    "keeps the %s import example separate from selected records",
    (currency) => {
      const html = renderToStaticMarkup(
        createElement(ImportModal, { currency, onClose: noop, onImported: noop }),
      );
      expect(html).toContain(`Cash application · ${currency}`);
      expect(html).toContain(`Values are read as ${currency} — `);
      expect(html).toContain("Example only · not selected");
      expect(html).toContain("EXAMPLE-001");
      expect(html).toContain("Choose your own CSV to import");
      expect(html).not.toContain("File preview");
      expect(html).toMatch(/<input[^>]*type="file"[^>]*required=""/);
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Import transactions/);
    },
  );
});

describe("landing preview", () => {
  it("labels an illustrative INR demo with NEFT payment activity", () => {
    const html = renderToStaticMarkup(createElement(LandingScreen, { onLogin: noop }));
    expect(html).toContain("Illustrative demo");
    expect(html).toContain("NEFT · INV-1048");
    expect(html).toContain("₹42,860.00");
    expect(html).toContain("+₹12,450.00");
    expect(html).toContain("-₹842.00");
    expect(html).not.toContain("ACH");
    expect(html).not.toContain("synced");
    expect(html).toContain("Sign in");
  });
});
