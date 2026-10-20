import { currencyMeta } from "./domain/currency";
import { assertBusinessDate } from "./domain/date";
import { formatMoney, fromWire } from "./domain/money";
import type { MoneyWire } from "./domain/types";

export function moneyLabel(value?: MoneyWire): string {
  return value ? formatMoney(fromWire(value)) : "—";
}

export function dateLabel(
  value: string,
  currency: string,
  style: "standard" | "short" | "long" = "standard",
): string {
  assertBusinessDate(value);
  // A business date is a calendar day, not an instant in the workspace timezone.
  // The server has already applied that timezone when choosing the reporting date.
  return new Intl.DateTimeFormat(currency === "INR" ? "en-IN" : "en-US", {
    weekday: style === "long" ? "long" : undefined,
    month: style === "long" ? "long" : "short",
    day: "numeric",
    year: style === "short" ? undefined : "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

export function invoiceDueDate(reportingDate: string): string {
  assertBusinessDate(reportingDate);
  const date = new Date(`${reportingDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 30);
  return date.toISOString().slice(0, 10);
}

export function amountPlaceholder(currency: string): string {
  const whole = currency === "INR" ? 125000n : 1250n;
  const example = formatMoney({
    currency,
    minor: whole * 10n ** BigInt(currencyMeta(currency).minorDigits),
  });
  // Other currencies are identified by the field label; keep input examples numeric.
  return currency === "INR" ? example : example.slice(currency.length + 1);
}

export function amountPrecisionHint(currency: string): string {
  const digits = currencyMeta(currency).minorDigits;
  return digits === 0
    ? `${currency} uses whole amounts (no decimal places).`
    : `Use up to ${digits} decimal places for ${currency}.`;
}

export function bankCsvExample(currency: string): string {
  return `Date,Amount,Description,Reference,Counterparty\n2026-10-20,"${amountPlaceholder(currency)}",Example customer payment,EXAMPLE-001,Example customer\n`;
}
