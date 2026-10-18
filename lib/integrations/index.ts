import { PlaidClient, QuickBooksClient, XeroClient } from "./providers";
import type { AccountingProvider } from "./types";

export function accountingProvider(provider: string) {
  if (provider === "quickbooks") return new QuickBooksClient();
  if (provider === "xero") return new XeroClient();
  throw new Error(`Unsupported accounting provider: ${provider}`);
}

export function plaidProvider() {
  return new PlaidClient();
}

export function integrationScopes(provider: AccountingProvider): string[] {
  return provider === "quickbooks"
    ? ["com.intuit.quickbooks.accounting"]
    : ["openid", "profile", "email", "accounting.transactions", "accounting.settings"];
}
