import type { CurrencyCode, Invoice, MoneyWire } from "@/lib/domain/types";

export type IntegrationProvider = "plaid" | "quickbooks" | "xero";
export type AccountingProvider = Exclude<IntegrationProvider, "plaid">;
export type TenantContext = {
  organizationId: string;
  entityId: string;
  actorId: string;
  sessionId: string;
};
export type SecretValue = string & { readonly __brand: "SecretValue" };

export type CredentialMaterial =
  | {
      kind: "oauth2";
      accessToken: SecretValue;
      refreshToken?: SecretValue;
      expiresAt: string;
      scopes: readonly string[];
    }
  | { kind: "access_token"; accessToken: SecretValue };

export type IntegrationConnectionStatus =
  | "pending"
  | "connected"
  | "needs_attention"
  | "disconnected"
  | "revoked";
export type IntegrationConnection = {
  id: string;
  organizationId: string;
  entityId: string;
  provider: IntegrationProvider;
  externalTenantId?: string;
  externalTenantName?: string;
  credentialRef?: string;
  scopes: readonly string[];
  status: IntegrationConnectionStatus;
  lastSuccessfulSyncAt?: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
};

export type CredentialLease = {
  connectionId: string;
  credentialRef: string;
  accessToken: SecretValue;
  refreshToken?: SecretValue;
  expiresAt?: string;
  scopes: readonly string[];
};

export type ExternalTenant = { externalTenantId: string; name: string };
export type TokenSet = {
  accessToken: SecretValue;
  refreshToken?: SecretValue;
  expiresAt: string;
  scopes: readonly string[];
  tokenType: "Bearer";
};

export interface CredentialVault {
  put(input: { connectionId: string; material: CredentialMaterial }): Promise<string>;
  load(connectionId: string): Promise<CredentialLease>;
  revoke(connectionId: string): Promise<void>;
}

export interface OAuthProviderPort {
  readonly provider: AccountingProvider;
  buildAuthorizationUrl(input: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scopes: readonly string[];
  }): URL;
  exchangeCode(input: {
    code: SecretValue;
    codeVerifier: SecretValue;
    redirectUri: string;
  }): Promise<TokenSet>;
  refreshToken(input: { refreshToken: SecretValue; scopes: readonly string[] }): Promise<TokenSet>;
  listExternalTenants(input: { accessToken: SecretValue }): Promise<ExternalTenant[]>;
}

export type ExternalBankAccount = {
  providerAccountId: string;
  name: string;
  mask?: string;
  currency: CurrencyCode;
  active: boolean;
};
export type NormalizedBankTransaction = {
  providerAccountId: string;
  providerTransactionId: string;
  pendingProviderTransactionId?: string;
  lifecycle: "pending" | "posted" | "removed";
  date: string;
  authorizedDate?: string;
  amount: MoneyWire;
  direction: "inflow" | "outflow";
  description: string;
  reference?: string;
  counterparty?: string;
};
export type BankFeedDelta = {
  added: NormalizedBankTransaction[];
  modified: NormalizedBankTransaction[];
  removed: string[];
  nextCursor: string | null;
  hasMore: boolean;
  providerRequestId?: string;
};
export type ProviderCall = { credential: CredentialLease; requestId: string; signal?: AbortSignal };

export interface BankFeedProviderPort {
  readonly provider: "plaid";
  createLinkToken(input: {
    userId: string;
    redirectUri?: string;
  }): Promise<{ linkToken: SecretValue; expiresAt: string }>;
  exchangePublicToken(input: { publicToken: SecretValue }): Promise<{
    externalConnectionId: string;
    credential: CredentialMaterial;
    accounts: ExternalBankAccount[];
  }>;
  listAccounts(input: ProviderCall): Promise<ExternalBankAccount[]>;
  syncTransactions(input: ProviderCall & { cursor: string | null }): Promise<BankFeedDelta>;
}

export type ExternalInvoice = {
  externalId: string;
  number: string;
  customerName?: string;
  issueDate: string;
  dueDate?: string;
  currency: CurrencyCode;
  total: MoneyWire;
  status: string;
};
export type ExternalPayment = {
  externalId: string;
  date: string;
  amount: MoneyWire;
  reference?: string;
  status: string;
};
export type SyncPage<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  providerRequestId?: string;
};

export interface AccountingProviderPort extends OAuthProviderPort {
  listInvoices(input: ProviderCall & { cursor: string | null }): Promise<SyncPage<ExternalInvoice>>;
  listPayments(input: ProviderCall & { cursor: string | null }): Promise<SyncPage<ExternalPayment>>;
  pushInvoice(
    input: ProviderCall & { invoice: Invoice; requestKey: string },
  ): Promise<{ externalId: string }>;
}

export type ProviderFailureKind =
  | "rate_limited"
  | "network"
  | "timeout"
  | "server"
  | "expired_token"
  | "invalid_grant"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "malformed_response"
  | "ambiguous";
