import { DomainError, invariant } from "./errors";
import { currencyMeta, groupInteger } from "./currency";
import type { CurrencyCode, Money, MoneyWire } from "./types";

export function minorDigits(currency: CurrencyCode): number {
  return currencyMeta(currency).minorDigits;
}

export function money(currency: CurrencyCode, minor: bigint | number | string): Money {
  return { currency, minor: typeof minor === "bigint" ? minor : BigInt(minor) };
}

export function zero(currency: CurrencyCode): Money {
  return money(currency, 0n);
}

export function assertSameCurrency(a: Money, b: Money): void {
  invariant(
    a.currency === b.currency,
    "currency_mismatch",
    "Money values use different currencies",
  );
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.currency, a.minor + b.minor);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.currency, a.minor - b.minor);
}

export function multiply(a: Money, quantity: number): Money {
  invariant(Number.isInteger(quantity) && quantity >= 0, "invalid_quantity");
  return money(a.currency, a.minor * BigInt(quantity));
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0;
}

export function isZero(a: Money): boolean {
  return a.minor === 0n;
}

export function isPositive(a: Money): boolean {
  return a.minor > 0n;
}

export function parseAmount(value: string | number, currency: CurrencyCode): Money {
  const raw = String(value)
    .trim()
    .replace(/,/g, "")
    .replace(/^[+₹$€£]/, "")
    .trim();
  if (!raw || /e/i.test(raw) || !/^-?\d+(?:\.\d+)?$/.test(raw)) {
    throw new DomainError("invalid_amount", `Invalid ${currency} amount: ${value}`);
  }

  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ""] = unsigned.split(".");
  const digits = minorDigits(currency);
  invariant(
    fraction.length <= digits,
    "too_many_decimals",
    `${currency} supports ${digits} decimals`,
  );
  const minor = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0") || "0");
  return money(currency, negative ? -minor : minor);
}

export function formatMoney(value: Money, options?: { sign?: boolean }): string {
  const digits = minorDigits(value.currency);
  const negative = value.minor < 0n;
  const absolute = negative ? -value.minor : value.minor;
  const scale = 10n ** BigInt(digits);
  const whole = absolute / scale;
  const fraction = digits ? `.${(absolute % scale).toString().padStart(digits, "0")}` : "";
  const sign = negative ? "-" : options?.sign ? "+" : "";
  const grouped = groupInteger(whole.toString(), value.currency);
  const prefix = value.currency === "INR" ? "₹" : value.currency;
  return `${sign}${prefix}${value.currency === "INR" ? "" : " "}${grouped}${fraction}`;
}

export function toWire(value: Money): MoneyWire {
  return { currency: value.currency, minor: value.minor.toString() };
}

export function fromWire(value: MoneyWire): Money {
  return money(value.currency, value.minor);
}

export function allocateEvenly(total: Money, count: number): Money[] {
  invariant(Number.isInteger(count) && count > 0, "invalid_allocation_count");
  const base = total.minor / BigInt(count);
  let remainder = total.minor % BigInt(count);
  return Array.from({ length: count }, () => {
    const extra = remainder > 0n ? 1n : remainder < 0n ? -1n : 0n;
    remainder -= extra;
    return money(total.currency, base + extra);
  });
}
