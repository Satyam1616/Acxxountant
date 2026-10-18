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
      const date = normalizeDate(row[dateIndex] ?? "");
      let rawAmount = amountIndex >= 0 ? row[amountIndex] : "";
      let flow: BankFlow = "inflow";
      if (amountIndex < 0) {
        const debit = row[debitIndex] ?? "";
        const credit = row[creditIndex] ?? "";
        if (credit.trim()) {
          rawAmount = credit;
          flow = "inflow";
        } else {
          rawAmount = debit;
          flow = "outflow";
        }
      } else if (/^\s*[-(]/.test(rawAmount) || /DR\s*$/i.test(rawAmount)) {
        flow = "outflow";
      }
      const hasCreditMarker = /CR\s*$/i.test(rawAmount);
      const cleaned = rawAmount
        .replace(/[,$\s]/g, "")
        .replace(/^\((.*)\)$/, "-$1")
        .replace(/(?:CR|DR)$/i, "")
        .replace(/^-/, "");
      if (hasCreditMarker) flow = "inflow";
      const amount = parseAmount(cleaned, currency);
      const absolute = { ...amount, minor: amount.minor < 0n ? -amount.minor : amount.minor };
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

function normalizeDate(value: string): string {
  const trimmed = value.trim();
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(trimmed);
  if (iso) {
    const date = `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
    if (!isValidBusinessDate(date)) throw new DomainError("invalid_date", `Invalid date: ${value}`);
    return date;
  }
  const monthFirst = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (monthFirst) {
    const date = `${monthFirst[3]}-${monthFirst[1].padStart(2, "0")}-${monthFirst[2].padStart(2, "0")}`;
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
