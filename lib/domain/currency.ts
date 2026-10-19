export const CURRENCY_META = {
  INR: { minorDigits: 2, symbol: "₹", name: "Indian Rupee", locale: "en-IN" },
  USD: { minorDigits: 2, symbol: "$", name: "US Dollar", locale: "en-US" },
  EUR: { minorDigits: 2, symbol: "€", name: "Euro", locale: "en-IN" },
  GBP: { minorDigits: 2, symbol: "£", name: "Pound Sterling", locale: "en-IN" },
  CAD: { minorDigits: 2, symbol: "CA$", name: "Canadian Dollar", locale: "en-IN" },
  JPY: { minorDigits: 0, symbol: "¥", name: "Japanese Yen", locale: "en-IN" },
  KRW: { minorDigits: 0, symbol: "₩", name: "South Korean Won", locale: "en-IN" },
  BHD: { minorDigits: 3, symbol: "BD", name: "Bahraini Dinar", locale: "en-IN" },
  KWD: { minorDigits: 3, symbol: "KD", name: "Kuwaiti Dinar", locale: "en-IN" },
} as const;

export type SupportedCurrency = keyof typeof CURRENCY_META;
export const supportedCurrencies = Object.keys(CURRENCY_META) as SupportedCurrency[];

export function isSupportedCurrency(value: string): value is SupportedCurrency {
  return Object.hasOwn(CURRENCY_META, value);
}

export function currencyMeta(value: string) {
  return isSupportedCurrency(value) ? CURRENCY_META[value] : CURRENCY_META.USD;
}

export function groupInteger(value: string, currency: string): string {
  if (currency !== "INR") {
    return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  if (value.length <= 3) return value;
  const lastThree = value.slice(-3);
  const leading = value.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${leading},${lastThree}`;
}
