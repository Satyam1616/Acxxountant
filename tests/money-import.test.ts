import { describe, expect, it } from "vitest";
import { parseBankCsv } from "../lib/domain/import";
import { formatMoney, parseAmount } from "../lib/domain/money";

const supportedAmounts = [
  ["INR", "₹", "1,23,456.78", 12345678n, "₹1,23,456.78"],
  ["USD", "$", "1,234.56", 123456n, "USD 1,234.56"],
  ["EUR", "€", "1,234.56", 123456n, "EUR 1,234.56"],
  ["GBP", "£", "1,234.56", 123456n, "GBP 1,234.56"],
  ["CAD", "CA$", "1,234.56", 123456n, "CAD 1,234.56"],
  ["JPY", "¥", "1,234", 1234n, "JPY 1,234"],
  ["KRW", "₩", "1,234", 1234n, "KRW 1,234"],
  ["BHD", "BD", "1,234.567", 1234567n, "BHD 1,234.567"],
  ["KWD", "KD", "1,234.567", 1234567n, "KWD 1,234.567"],
] as const;

describe("money parsing", () => {
  it.each([
    [0, 0n],
    [123456.78, 12345678n],
    [-123456.78, -12345678n],
    ["123456.78", 12345678n],
    ["00123.4", 12340n],
    ["1,23,456.78", 12345678n],
    ["123,456.78", 12345678n],
    ["1,234,567.89", 123456789n],
    ["₹1,23,456.78", 12345678n],
    ["+123456.78", 12345678n],
    ["+₹1,23,456.78", 12345678n],
    ["₹+1,23,456.78", 12345678n],
    ["-₹1,23,456.78", -12345678n],
    ["₹-1,23,456.78", -12345678n],
    ["  - ₹ 1,23,456.78  ", -12345678n],
    ["  ₹ + 1,23,456.78  ", 12345678n],
    ["-₹0.01", -1n],
    ["+₹0.00", 0n],
  ] as const)("parses INR %s as exact paise", (input, minor) => {
    expect(parseAmount(input, "INR")).toEqual({ currency: "INR", minor });
  });

  it("keeps values beyond Number precision exact and round-trips signed INR formatting", () => {
    const value = parseAmount("₹9,00,71,99,25,47,40,993.01", "INR");
    expect(value.minor).toBe(900719925474099301n);
    expect(parseAmount("9007199254740993.01", "INR")).toEqual(value);
    expect(formatMoney(value, { sign: true })).toBe("+₹9,00,71,99,25,47,40,993.01");
    expect(parseAmount(formatMoney(value, { sign: true }), "INR")).toEqual(value);
    const negative = { ...value, minor: -value.minor };
    expect(parseAmount(formatMoney(negative), "INR")).toEqual(negative);
  });

  it("rejects malformed grouping and syntax instead of deleting separators or signs", () => {
    for (const input of [
      "1,2,3.00",
      "12,34.56",
      "123,45,678.90",
      "1,23,456,789.00",
      "1,,234.00",
      ",123.00",
      "123,.00",
      "1,234.5,6",
      "₹1 23 456.78",
      "₹1\t234.00",
      "",
      "₹",
      ".50",
      "1.",
      "1e3",
      "NaN",
      "Infinity",
      "--1",
      "+-₹1",
      "-₹-1",
      "+₹+1",
      "₹₹1",
      "1₹",
      "₹$1",
    ]) {
      expect(() => parseAmount(input, "INR"), input).toThrow("invalid_amount");
    }
  });

  it.each(supportedAmounts)(
    "preserves %s precision, symbols, signs, and formatting",
    (currency, symbol, input, minor, formatted) => {
      expect(parseAmount(input, currency)).toEqual({ currency, minor });
      expect(parseAmount(`${symbol}${input}`, currency).minor).toBe(minor);
      expect(parseAmount(`+${symbol}${input}`, currency).minor).toBe(minor);
      expect(parseAmount(`${symbol}+${input}`, currency).minor).toBe(minor);
      expect(parseAmount(`-${symbol}${input}`, currency).minor).toBe(-minor);
      expect(parseAmount(`${symbol}-${input}`, currency).minor).toBe(-minor);
      expect(formatMoney({ currency, minor })).toBe(formatted);
      expect(() => parseAmount(`${input}${input.includes(".") ? "0" : ".0"}`, currency)).toThrow(
        "too_many_decimals",
      );
      if (currency !== "INR") {
        expect(() => parseAmount("1,23,456", currency)).toThrow("invalid_amount");
      }
    },
  );

  it("rejects every other supported currency's symbol, including signed inputs", () => {
    for (const [currency, ownSymbol] of supportedAmounts) {
      for (const [, symbol] of supportedAmounts) {
        if (symbol === ownSymbol) continue;
        for (const input of [`${symbol}10`, `+${symbol}10`, `-${symbol}10`]) {
          expect(() => parseAmount(input, currency), `${currency}: ${input}`).toThrow(
            "invalid_amount",
          );
        }
      }
    }
  });

  it("retains the unknown-currency numeric fallback without borrowing a dollar symbol", () => {
    expect(parseAmount("1,234.56", "ZZZ")).toEqual({ currency: "ZZZ", minor: 123456n });
    expect(() => parseAmount("1.234", "ZZZ")).toThrow("too_many_decimals");
    expect(() => parseAmount("$1.00", "ZZZ")).toThrow("invalid_amount");
    expect(() => parseAmount("₹1.00", "ZZZ")).toThrow("invalid_amount");
  });
});

describe("bank CSV money and dates", () => {
  it("imports large signed INR amounts as exact paise through quoted CSV fields", () => {
    const result = parseBankCsv(
      [
        "Date,Amount,Currency,Description",
        '31-01-2026,"+₹9,00,71,99,25,47,40,993.01",INR,"Payment, exact"',
        '01/02/2026,"(₹9,00,71,99,25,47,40,993.01) DR",INR,"Fee, exact"',
        '02/02/2026,"₹1,23,456.789",INR,Too many decimals',
      ].join("\n"),
      "INR",
    );
    expect(result.rows).toMatchObject([
      {
        amount: { currency: "INR", minor: 900719925474099301n },
        date: "2026-01-31",
        flow: "inflow",
        description: "Payment, exact",
      },
      {
        amount: { currency: "INR", minor: 900719925474099301n },
        date: "2026-02-01",
        flow: "outflow",
        description: "Fee, exact",
      },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      row: 4,
      message: expect.stringContaining("too_many_decimals"),
    });
  });

  it.each([
    ["03/04/2026", "2026-04-03"],
    ["03-04-2026", "2026-04-03"],
    ["31/01/2026", "2026-01-31"],
    ["31-01-2026", "2026-01-31"],
    ["29/02/2024", "2024-02-29"],
    ["3/4/2026", "2026-04-03"],
    ["2026-03-04", "2026-03-04"],
    ["2026/03/04", "2026-03-04"],
  ])("reads INR date %s as %s", (input, date) => {
    const result = parseBankCsv(`Date,Amount\n${input},10.00`, "INR");
    expect(result.errors).toEqual([]);
    expect(result.rows[0]?.date).toBe(date);
  });

  it("validates INR calendar dates without falling back to month-first", () => {
    const dates = ["04/13/2026", "02-29-2024", "31/04/2026", "29/02/2026", "2026-02-31"];
    const result = parseBankCsv(
      ["Date,Amount", ...dates.map((date) => `${date},10.00`)].join("\n"),
      "INR",
    );
    expect(result.rows).toEqual([]);
    expect(result.errors.map((error) => error.row)).toEqual([2, 3, 4, 5, 6]);
    expect(result.errors.every((error) => error.message.includes("invalid_date"))).toBe(true);
  });

  it.each(supportedAmounts)(
    "imports %s symbols and precision with the appropriate date order",
    (currency, symbol, input, minor) => {
      const date = currency === "INR" ? "03/04/2026" : "04/03/2026";
      const result = parseBankCsv(
        [
          "Date,Amount,Currency",
          `${date},"${symbol}${input}",${currency}`,
          `${date.replaceAll("/", "-")},"-${symbol}${input}",${currency}`,
          `2026-04-03,"+${symbol}${input}",${currency}`,
          `2026/04/03,"(${symbol}${input})",${currency}`,
        ].join("\n"),
        currency,
      );
      expect(result.errors).toEqual([]);
      expect(result.rows.map((row) => row.date)).toEqual(Array(4).fill("2026-04-03"));
      expect(result.rows.map((row) => row.amount)).toEqual(Array(4).fill({ currency, minor }));
      expect(result.rows.map((row) => row.flow)).toEqual([
        "inflow",
        "outflow",
        "inflow",
        "outflow",
      ]);
    },
  );

  it.each([
    ["10", "inflow"],
    ["+10", "inflow"],
    ["-10", "outflow"],
    ["+₹10", "inflow"],
    ["₹+10", "inflow"],
    ["-₹10", "outflow"],
    ["₹-10", "outflow"],
    ["(₹10)", "outflow"],
    ["( ₹ 10 ) DR", "outflow"],
    ["(₹10 DR)", "outflow"],
    ["₹10DR", "outflow"],
    ["₹10 dr", "outflow"],
    ["-₹10 DR", "outflow"],
    ["₹-10 DR", "outflow"],
    ["₹10CR", "inflow"],
    ["₹10 cr", "inflow"],
    ["+₹10 CR", "inflow"],
  ])("imports %s with a positive magnitude and %s flow", (input, flow) => {
    const result = parseBankCsv(`Date,Amount\n2026-04-03,${input}`, "INR");
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ amount: { currency: "INR", minor: 1000n }, flow });
  });

  it("rejects conflicting directions, duplicate signs, and malformed parentheses", () => {
    const inputs = [
      "-10 CR",
      "+10 DR",
      "(₹10) CR",
      "(₹10 CR)",
      "--10",
      "-+10",
      "₹-+10",
      "(+₹10)",
      "(-₹10)",
      "(₹10",
      "₹10)",
      "((₹10))",
      "₹10 DR CR",
      "(₹10 DR) DR",
    ];
    const result = parseBankCsv(
      ["Date,Amount", ...inputs.map((input) => `2026-04-03,${input}`)].join("\n"),
      "INR",
    );
    expect(result.rows).toEqual([]);
    expect(result.errors).toHaveLength(inputs.length);
  });

  it("keeps signed zero directions without turning magnitudes negative", () => {
    const result = parseBankCsv(
      "Date,Amount\n2026-04-03,-0.00\n2026-04-03,₹-0\n2026-04-03,+₹0\n2026-04-03,(₹0) DR",
      "INR",
    );
    expect(result.errors).toEqual([]);
    expect(result.rows.map((row) => row.flow)).toEqual(["outflow", "outflow", "inflow", "outflow"]);
    expect(result.rows.map((row) => row.amount.minor)).toEqual([0n, 0n, 0n, 0n]);
  });

  it("selects nonzero debit/credit magnitudes and honors each column's direction", () => {
    const result = parseBankCsv(
      [
        "Date,Debit,Credit",
        '2026-04-03,"₹1,23,456.78",0.00',
        '2026-04-03,0.00,"₹1,23,456.78"',
        '2026-04-03,"-₹1,23,456.78",',
        '2026-04-03,"+₹1,23,456.78",',
        '2026-04-03,"(₹1,23,456.78) DR",0',
        '2026-04-03,,"₹1,23,456.78 CR"',
        '2026-04-03,0,"+₹1,23,456.78"',
        "2026-04-03,0,0",
        "2026-04-03,0,",
      ].join("\n"),
      "INR",
    );
    expect(result.errors).toEqual([]);
    expect(result.rows.map((row) => row.amount.minor)).toEqual([
      ...Array(7).fill(12345678n),
      0n,
      0n,
    ]);
    expect(result.rows.map((row) => row.flow)).toEqual([
      "outflow",
      "inflow",
      "outflow",
      "outflow",
      "outflow",
      "inflow",
      "inflow",
      "inflow",
      "outflow",
    ]);
  });

  it("rejects ambiguous, contradictory, empty, or malformed debit/credit rows", () => {
    const result = parseBankCsv(
      [
        "Date,Debit,Credit",
        "2026-04-03,10,20",
        "2026-04-03,10 CR,",
        "2026-04-03,,10 DR",
        "2026-04-03,,-10",
        "2026-04-03,,(10)",
        "2026-04-03,,",
        "2026-04-03,invalid,10",
        "2026-04-03,$0,10",
        '2026-04-03,"1,2,3",0',
      ].join("\n"),
      "INR",
    );
    expect(result.rows).toEqual([]);
    expect(result.errors.map((error) => error.row)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it.each([
    ["Withdrawal", "outflow"],
    ["Deposit", "inflow"],
  ])("supports a lone %s column", (header, flow) => {
    const result = parseBankCsv(`Date,${header}\n03/04/2026,₹10`, "INR");
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ date: "2026-04-03", flow, amount: { minor: 1000n } });
  });

  it("validates symbols and grouping before CSV normalization", () => {
    for (const [currency, ownSymbol] of supportedAmounts) {
      const inputs = supportedAmounts
        .filter(([, symbol]) => symbol !== ownSymbol)
        .map(([, symbol]) => `-${symbol}10`);
      inputs.push("1,2,3", "1 000", "1$0", "₹$10");
      const result = parseBankCsv(
        ["Date,Amount", ...inputs.map((input) => `2026-04-03,"${input}"`)].join("\n"),
        currency,
      );
      expect(result.rows, currency).toEqual([]);
      expect(result.errors, currency).toHaveLength(inputs.length);
    }
  });

  it("requires every explicit Currency cell to match, including in debit/credit CSVs", () => {
    for (const amounts of ["Amount", "Debit,Credit"]) {
      const amount = amounts === "Amount" ? "10" : ",10";
      const result = parseBankCsv(
        [
          `Date,${amounts},Currency`,
          `2026-04-03,${amount}, INR `,
          `2026-04-03,${amount},USD`,
          `2026-04-03,${amount},inr`,
          `2026-04-03,${amount},`,
          `2026-04-03,${amount}`,
          `2026-04-03,${amount},ZZZ`,
        ].join("\n"),
        "INR",
      );
      expect(result.rows).toHaveLength(2);
      expect(result.errors.map((error) => error.row)).toEqual([3, 5, 6, 7]);
      expect(result.errors.every((error) => error.message.includes("currency_mismatch"))).toBe(
        true,
      );
    }
    expect(parseBankCsv("Date,Amount,Currency\n2026-04-03,10,INR", "USD").rows).toEqual([]);
  });

  it("retains unknown-currency numeric imports and month-first dates", () => {
    const result = parseBankCsv(
      "Date,Amount,Currency\n03/04/2026,10.00,ZZZ\n2026-03-04,$10,ZZZ",
      "ZZZ",
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      date: "2026-03-04",
      amount: { currency: "ZZZ", minor: 1000n },
    });
    expect(result.errors[0]?.row).toBe(3);
  });

  it("preserves ordinary duplicate fingerprints and identity normalization", () => {
    const csv = [
      "Date,Amount,Description,Reference,Counterparty",
      "2026-10-05,10.00,Same,REF-1,Acme",
      "2026-10-05,10.00,Same,REF-1,Acme",
      "10/06/2026,-20.50,Fee,FEE-1,Bank",
    ].join("\n");
    const result = parseBankCsv(csv, "USD");
    expect(result.errors).toEqual([]);
    expect(result.rows.map((row) => row.externalId)).toEqual([
      "csv_de56e5df",
      "csv_df56e772",
      "csv_510f4cb2",
    ]);
    const normalized = parseBankCsv(
      csv.replaceAll(",Same,REF-1,Acme", ", same , ref-1 , acme "),
      "USD",
    );
    expect(normalized.rows.map((row) => row.externalId)).toEqual(
      result.rows.map((row) => row.externalId),
    );
    expect(parseBankCsv(csv, "USD", "another-bank").rows[0].externalId).not.toBe(
      result.rows[0].externalId,
    );
    const rupees = parseBankCsv(
      'Date,Amount,Description\n2026-10-05,"₹1,23,456.78",Indian customer payment',
      "INR",
    );
    expect(rupees.rows[0]?.externalId).toBe("csv_c30d98a2");
    const debitCredit = parseBankCsv(
      "Date,Debit,Credit,Description,Reference\n2026-10-01,,125.50,Acme payment,INV-1\n2026-10-02,20.00,,AWS cloud,AWS-1",
      "USD",
    );
    expect(debitCredit.rows.map((row) => row.externalId)).toEqual(["csv_31a0e615", "csv_72e31434"]);
  });

  it("reports row-local failures without consuming duplicate occurrences", () => {
    const result = parseBankCsv(
      [
        "\uFEFFDate,Amount,Description,Reference,Counterparty,Currency",
        "2026-10-05,10.00,Same,REF-1,Acme,USD",
        "2026-10-05,10.00,Same,REF-1,Acme,INR",
        "2026-10-05,10.00,Same,REF-1,Acme,USD",
      ].join("\r\n"),
      "USD",
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.row).toBe(3);
    expect(result.rows.map((row) => row.externalId)).toEqual(["csv_de56e5df", "csv_df56e772"]);
  });
});
