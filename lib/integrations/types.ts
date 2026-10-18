import type { BankTransaction, CurrencyCode, Invoice } from "@/lib/domain/types";

export type IntegrationProvider = "plaid" | "quickbooks" | "xero";

export type IntegrationConnection = {
  id: string;
  entityId: string;
  provider: IntegrationProvider;
  status: "connected" | "needs_attention" | "disconnected";
  externalAccountName?: string;
  lastSyncedAt?: string;
  errorMessage?: string;
};

export type BankFeedAdapter = {
  provider: "plaid";
  exchangePublicToken(
    publicToken: string,
  ): Promise<{ accessToken: string; accountId: string; accountName: string }>;
  fetchTransactions(
    accessToken: string,
    accountId: string,
    from: string,
    to: string,
  ): Promise<BankTransaction[]>;
};

export type AccountingSyncAdapter = {
  provider: "quickbooks" | "xero";
  pushInvoice(invoice: Invoice): Promise<{ externalId: string }>;
  pushPayment(payment: {
    externalId: string;
    amount: { currency: CurrencyCode; minor: string };
    date: string;
  }): Promise<{ externalId: string }>;
};
