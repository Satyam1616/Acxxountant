import { DomainError } from "./errors";
import { isValidBusinessDate } from "./date";
import { parseAmount } from "./money";
import type { BankFlow, CurrencyCode } from "./types";

export type ImportedTransaction = {
  externalId: string;
  date: string;
  amount: ReturnType<typeof parseAmount>;
  flow: BankFlow;
  description: string;
  reference: string;
  counterparty?: string;
};

export type CsvImportResult = {
  rows: ImportedTransaction[];
  errors: Array<{ row: number; message: string }>;
};

const MAX_CSV_BYTES = 2_000_000;
const MAX_CSV_ROWS = 10_000;

export function parseBankCsv(csv: string, currency: CurrencyCode, source = "csv"): CsvImportResult {
  if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) {
    throw new DomainError("csv_too_large", "CSV imports are limited to 2 MB");
  }
  const rows = parseCsv(csv.replace(/^\uFEFF/, ""));
  if (rows.length > MAX_CSV_ROWS + 1) {
    throw new DomainError(
      "csv_too_many_rows",
      `CSV imports are limited to ${MAX_CSV_ROWS} data rows`,
    );
  }
  if (rows.length < 2)
    throw new DomainError("csv_has_no_rows", "Add a header and at least one transaction");
  const headers = rows[0].map((header) => normalizeHeader(header));
  const index = (aliases: string[]) =>
    aliases.map((alias) => headers.indexOf(alias)).find((item) => item >= 0) ?? -1;
  const dateIndex = index(["date", "transaction date", "posted date", "value date"]);
  const amountIndex = index(["amount", "transaction amount", "value"]);
  const debitIndex = index(["debit", "withdrawal", "money out"]);
  const creditIndex = index(["credit", "deposit", "money in"]);
  const currencyIndex = index(["currency"]);
  const descriptionIndex = index(["description", "memo", "narrative", "details"]);
  const referenceIndex = index(["reference", "ref", "check number", "transaction id"]);
  const counterpartyIndex = index(["counterparty", "payer", "payee", "name"]);
  if (dateIndex < 0 || (amountIndex < 0 && debitIndex < 0 && creditIndex < 0))
    throw new DomainError(
      "csv_columns_missing",
      "A date and amount (or debit/credit) column are required",
    );
  const output: ImportedTransaction[] = [];
  const errors: CsvImportResult["errors"] = [];
  const occurrences = new Map<string, number>();
  rows.slice(1).forEach((row, offset) => {
    const rowNumber = offset + 2;
    if (row.every((cell) => !cell.trim())) return;
    try {
      if (currencyIndex >= 0) {
        const declaredCurrency = (row[currencyIndex] ?? "").trim().toUpperCase();
        if (declaredCurrency !== currency.toUpperCase()) {
          throw new DomainError(
            "currency_mismatch",
            `Expected ${currency}, received ${declaredCurrency || "blank currency"}`,
          );
        }
      }
      const date = normalizeDate(row[dateIndex] ?? "", currency);
      let parsedAmount =
        amountIndex >= 0 ? parseCsvAmount(row[amountIndex] ?? "", currency) : undefined;
      if (amountIndex < 0) {
        const rawDebit = (row[debitIndex] ?? "").trim();
        const rawCredit = (row[creditIndex] ?? "").trim();
        const debit = rawDebit ? parseCsvAmount(rawDebit, currency, "outflow") : undefined;
        const credit = rawCredit ? parseCsvAmount(rawCredit, currency, "inflow") : undefined;
        if (debit && credit && debit.amount.minor !== 0n && credit.amount.minor !== 0n) {
          throw new DomainError(
            "ambiguous_amount",
            "Both debit and credit contain nonzero amounts",
          );
        }
        parsedAmount = debit && debit.amount.minor !== 0n ? debit : (credit ?? debit);
      }
      if (!parsedAmount)
        throw new DomainError("invalid_amount", "A debit or credit amount is required");
      const { amount: absolute, flow } = parsedAmount;
      const reference = row[referenceIndex] ?? "";
      const description = (row[descriptionIndex] ?? reference) || "Imported transaction";
      const canonical = `${source}|${date}|${absolute.minor}|${flow}|${normalizeIdentity(description)}|${normalizeIdentity(reference)}|${normalizeIdentity(row[counterpartyIndex] ?? "")}`;
      const occurrence = (occurrences.get(canonical) ?? 0) + 1;
      occurrences.set(canonical, occurrence);
      output.push({
        externalId: stableFingerprint(`${canonical}|${occurrence}`),
        date,
        amount: absolute,
        flow,
        description,
        reference,
        counterparty: row[counterpartyIndex] || undefined,
      });
    } catch (error) {
      errors.push({
        row: rowNumber,
        message: error instanceof Error ? error.message : "Invalid row",
      });
    }
  });
  return { rows: output, errors };
}

function normalizeHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseCsvAmount(
  value: string,
  currency: CurrencyCode,
  columnFlow?: BankFlow,
): Pick<ImportedTransaction, "amount" | "flow"> {
  let raw = value.trim();
  let marker = /(CR|DR)$/i.exec(raw);
  if (marker) raw = raw.slice(0, marker.index).trim();
  const parenthesized = raw.startsWith("(") && raw.endsWith(")");
  if (parenthesized) {
    raw = raw.slice(1, -1).trim();
    // Banks put the direction suffix either inside or outside the parentheses.
    if (!marker) {
      marker = /(CR|DR)$/i.exec(raw);
      if (marker) raw = raw.slice(0, marker.index).trim();
    }
  }
  // Validate symbols, grouping, and signs before taking an absolute magnitude.
  const amount = parseAmount(raw, currency);
  const sign = /[+-]/.exec(raw)?.[0];
  if (parenthesized && sign) {
    throw new DomainError("invalid_amount", "Use parentheses or a sign, not both");
  }
  // In a debit/credit column, a positive value is a magnitude in that column's direction.
  const signFlow =
    parenthesized || sign === "-" ? "outflow" : sign === "+" ? (columnFlow ?? "inflow") : undefined;
  const markerFlow = marker ? (marker[1].toUpperCase() === "DR" ? "outflow" : "inflow") : undefined;
  const flow = markerFlow ?? signFlow ?? columnFlow ?? "inflow";
  if ((signFlow && signFlow !== flow) || (columnFlow && columnFlow !== flow)) {
    throw new DomainError("conflicting_flow", "Amount sign, DR/CR marker, and column must agree");
  }
  return {
    amount: { ...amount, minor: amount.minor < 0n ? -amount.minor : amount.minor },
    flow,
  };
}

function normalizeDate(value: string, currency: CurrencyCode): string {
  const trimmed = value.trim();
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(trimmed);
  if (iso) {
    const date = `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
    if (!isValidBusinessDate(date)) throw new DomainError("invalid_date", `Invalid date: ${value}`);
    return date;
  }
  const local = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (local) {
    const [month, day] = currency === "INR" ? [local[2], local[1]] : [local[1], local[2]];
    const date = `${local[3]}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    if (!isValidBusinessDate(date)) throw new DomainError("invalid_date", `Invalid date: ${value}`);
    return date;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime()))
    throw new DomainError("invalid_date", `Invalid date: ${value}`);
  const date = `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(parsed.getUTCDate()).padStart(2, "0")}`;
  if (!isValidBusinessDate(date)) throw new DomainError("invalid_date", `Invalid date: ${value}`);
  return date;
}

function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
}

function stableFingerprint(value: string): string {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `csv_${(hash >>> 0).toString(16)}`;
}

function parseCsv(value: string): string[][] {
  const result: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '"') {
      if (quoted && value[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && value[i + 1] === "\n") i += 1;
      row.push(cell);
      result.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    result.push(row);
  }
  return result;
}
