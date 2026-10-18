import { assertOAuthConfiguration } from "./oauth";
import type { Invoice } from "@/lib/domain/types";
import type {
  AccountingProviderPort,
  BankFeedDelta,
  BankFeedProviderPort,
  CredentialMaterial,
  ExternalBankAccount,
  ExternalInvoice,
  ExternalPayment,
  ExternalTenant,
  ProviderCall,
  SecretValue,
  SyncPage,
  TokenSet,
} from "./types";

export class ProviderError extends Error {
  readonly kind: string;
  readonly providerRequestId?: string;
  readonly status?: number;
  constructor(kind: string, message: string, status?: number, providerRequestId?: string) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
    this.providerRequestId = providerRequestId;
  }
}

async function fetchJson<T>(url: string, init: RequestInit, provider: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { ...init, signal: init.signal ?? controller.signal });
    const requestId =
      response.headers.get("intuit_tid") ??
      response.headers.get("xero-correlation-id") ??
      undefined;
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new ProviderError(
        "malformed_response",
        `${provider} returned invalid JSON`,
        response.status,
        requestId,
      );
    }
    if (!response.ok) {
      const kind =
        response.status === 401
          ? "expired_token"
          : response.status === 403
            ? "forbidden"
            : response.status === 429
              ? "rate_limited"
              : response.status >= 500
                ? "server"
                : "invalid_request";
      throw new ProviderError(kind, `${provider} request failed`, response.status, requestId);
    }
    return body as T;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof DOMException && error.name === "AbortError")
      throw new ProviderError("timeout", `${provider} request timed out`);
    throw new ProviderError("network", `${provider} network request failed`);
  } finally {
    clearTimeout(timer);
  }
}

function basic(value: string): string {
  return Buffer.from(value).toString("base64");
}
function tokenSet(
  payload: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string },
  fallbackScopes: readonly string[],
): TokenSet {
  return {
    accessToken: payload.access_token as SecretValue,
    refreshToken: payload.refresh_token as SecretValue | undefined,
    expiresAt: new Date(Date.now() + (payload.expires_in ?? 3600) * 1000).toISOString(),
    scopes: payload.scope?.split(" ").filter(Boolean) ?? fallbackScopes,
    tokenType: "Bearer",
  };
}

export class PlaidClient implements BankFeedProviderPort {
  readonly provider = "plaid" as const;
  private readonly base =
    process.env.PLAID_ENV === "production"
      ? "https://production.plaid.com"
      : "https://sandbox.plaid.com";
  private credentials() {
    if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET)
      throw new ProviderError("invalid_request", "Plaid is not configured");
    return { client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET };
  }
  async createLinkToken(input: { userId: string; redirectUri?: string }) {
    const payload = await fetchJson<{ link_token: string; expiration: string }>(
      `${this.base}/link/token/create`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...this.credentials(),
          client_name: process.env.NEXT_PUBLIC_APP_NAME ?? "LedgerFlow",
          user: { client_user_id: input.userId },
          products: ["transactions"],
          country_codes: ["US"],
          language: "en",
          redirect_uri: input.redirectUri,
        }),
      },
      "Plaid",
    );
    return { linkToken: payload.link_token as SecretValue, expiresAt: payload.expiration };
  }
  async exchangePublicToken(input: { publicToken: SecretValue }) {
    const payload = await fetchJson<{ access_token: string; item_id: string }>(
      `${this.base}/item/public_token/exchange`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...this.credentials(), public_token: input.publicToken }),
      },
      "Plaid",
    );
    const credential: CredentialMaterial = {
      kind: "access_token",
      accessToken: payload.access_token as SecretValue,
    };
    return {
      externalConnectionId: payload.item_id,
      credential,
      accounts: await this.listAccounts({
        credential: {
          connectionId: payload.item_id,
          credentialRef: "exchange",
          accessToken: payload.access_token as SecretValue,
          scopes: [],
        },
        requestId: payload.item_id,
      }),
    };
  }
  async listAccounts(input: ProviderCall): Promise<ExternalBankAccount[]> {
    const payload = await fetchJson<{
      accounts: Array<{
        account_id: string;
        name: string;
        mask?: string;
        balances?: { iso_currency_code?: string };
        subtype?: string;
      }>;
    }>(
      `${this.base}/accounts/get`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...this.credentials(), access_token: input.credential.accessToken }),
      },
      "Plaid",
    );
    return payload.accounts.map((account) => ({
      providerAccountId: account.account_id,
      name: account.name,
      mask: account.mask,
      currency: account.balances?.iso_currency_code ?? "USD",
      active: true,
    }));
  }
  async syncTransactions(input: ProviderCall & { cursor: string | null }): Promise<BankFeedDelta> {
    const payload = await fetchJson<{
      added: Array<{
        account_id: string;
        transaction_id: string;
        pending_transaction_id?: string;
        date: string;
        amount: number;
        name: string;
        merchant_name?: string;
        pending: boolean;
      }>;
      modified: Array<{
        account_id: string;
        transaction_id: string;
        date: string;
        amount: number;
        name: string;
        pending: boolean;
      }>;
      removed: Array<{ transaction_id: string }>;
      next_cursor: string;
      has_more: boolean;
      request_id?: string;
    }>(
      `${this.base}/transactions/sync`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...this.credentials(),
          access_token: input.credential.accessToken,
          cursor: input.cursor ?? undefined,
        }),
      },
      "Plaid",
    );
    const normalize = (transaction: {
      account_id: string;
      transaction_id: string;
      pending_transaction_id?: string;
      date: string;
      amount: number;
      name: string;
      merchant_name?: string;
      pending: boolean;
    }) => ({
      providerAccountId: transaction.account_id,
      providerTransactionId: transaction.transaction_id,
      pendingProviderTransactionId: transaction.pending_transaction_id,
      lifecycle: transaction.pending ? ("pending" as const) : ("posted" as const),
      date: transaction.date,
      amount: { currency: "USD", minor: String(Math.round(Math.abs(transaction.amount) * 100)) },
      direction: transaction.amount < 0 ? ("inflow" as const) : ("outflow" as const),
      description: transaction.merchant_name ?? transaction.name,
      counterparty: transaction.merchant_name,
    });
    return {
      added: payload.added.map(normalize),
      modified: payload.modified.map(normalize),
      removed: payload.removed.map((item) => item.transaction_id),
      nextCursor: payload.next_cursor,
      hasMore: payload.has_more,
      providerRequestId: payload.request_id,
    };
  }
}

export class QuickBooksClient implements AccountingProviderPort {
  readonly provider = "quickbooks" as const;
  private readonly authBase = "https://appcenter.intuit.com/connect/oauth2";
  private readonly tokenBase = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
  private readonly apiBase =
    process.env.QUICKBOOKS_ENV === "production"
      ? "https://quickbooks.api.intuit.com"
      : "https://sandbox-quickbooks.api.intuit.com";
  buildAuthorizationUrl(input: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scopes: readonly string[];
  }) {
    const config = assertOAuthConfiguration("quickbooks");
    const url = new URL(this.authBase);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      scope: input.scopes.join(" "),
      redirect_uri: input.redirectUri,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url;
  }
  async exchangeCode(input: {
    code: SecretValue;
    codeVerifier: SecretValue;
    redirectUri: string;
  }): Promise<TokenSet> {
    const config = assertOAuthConfiguration("quickbooks");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    });
    const payload = await fetchJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      x_refresh_token_expires_in?: number;
      scope?: string;
    }>(
      this.tokenBase,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic(`${config.clientId}:${config.clientSecret}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
      "QuickBooks",
    );
    return tokenSet(payload, ["com.intuit.quickbooks.accounting"]);
  }
  async refreshToken(input: {
    refreshToken: SecretValue;
    scopes: readonly string[];
  }): Promise<TokenSet> {
    const config = assertOAuthConfiguration("quickbooks");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    });
    const payload = await fetchJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    }>(
      this.tokenBase,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic(`${config.clientId}:${config.clientSecret}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
      "QuickBooks",
    );
    return tokenSet(payload, input.scopes);
  }
  async listExternalTenants(input: { accessToken: SecretValue }): Promise<ExternalTenant[]> {
    const payload = await fetchJson<Array<{ realmId: string; companyName: string }>>(
      "https://appcenter.intuit.com/api/v1/connection",
      { headers: { Authorization: `Bearer ${input.accessToken}` } },
      "QuickBooks",
    );
    return payload.map((item) => ({ externalTenantId: item.realmId, name: item.companyName }));
  }
  async listInvoices(
    input: ProviderCall & { cursor: string | null },
  ): Promise<SyncPage<ExternalInvoice>> {
    void input;
    throw new ProviderError(
      "invalid_request",
      "QuickBooks invoice pull requires a selected realm connection",
    );
  }
  async listPayments(
    input: ProviderCall & { cursor: string | null },
  ): Promise<SyncPage<ExternalPayment>> {
    void input;
    throw new ProviderError(
      "invalid_request",
      "QuickBooks payment pull requires a selected realm connection",
    );
  }
  async pushInvoice(
    input: ProviderCall & { invoice: Invoice; requestKey: string },
  ): Promise<{ externalId: string }> {
    void input;
    throw new ProviderError(
      "invalid_request",
      "QuickBooks invoice push requires a selected realm connection",
    );
  }
}

export class XeroClient implements AccountingProviderPort {
  readonly provider = "xero" as const;
  buildAuthorizationUrl(input: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scopes: readonly string[];
  }) {
    const config = assertOAuthConfiguration("xero");
    const url = new URL("https://login.xero.com/identity/connect/authorize");
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      scope: input.scopes.join(" "),
      state: input.state,
      redirect_uri: input.redirectUri,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return url;
  }
  async exchangeCode(input: {
    code: SecretValue;
    codeVerifier: SecretValue;
    redirectUri: string;
  }): Promise<TokenSet> {
    const config = assertOAuthConfiguration("xero");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    });
    const payload = await fetchJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    }>(
      "https://identity.xero.com/connect/token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic(`${config.clientId}:${config.clientSecret}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
      "Xero",
    );
    return tokenSet(payload, [
      "openid",
      "profile",
      "email",
      "offline_access",
      "accounting.transactions",
    ]);
  }
  async refreshToken(input: {
    refreshToken: SecretValue;
    scopes: readonly string[];
  }): Promise<TokenSet> {
    const config = assertOAuthConfiguration("xero");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    });
    const payload = await fetchJson<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    }>(
      "https://identity.xero.com/connect/token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic(`${config.clientId}:${config.clientSecret}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      },
      "Xero",
    );
    return tokenSet(payload, input.scopes);
  }
  async listExternalTenants(input: { accessToken: SecretValue }): Promise<ExternalTenant[]> {
    const payload = await fetchJson<Array<{ tenantId: string; tenantName: string }>>(
      "https://api.xero.com/connections",
      { headers: { Authorization: `Bearer ${input.accessToken}` } },
      "Xero",
    );
    return payload.map((item) => ({ externalTenantId: item.tenantId, name: item.tenantName }));
  }
  async listInvoices(
    input: ProviderCall & { cursor: string | null },
  ): Promise<SyncPage<ExternalInvoice>> {
    void input;
    throw new ProviderError(
      "invalid_request",
      "Xero invoice pull requires a selected tenant connection",
    );
  }
  async listPayments(
    input: ProviderCall & { cursor: string | null },
  ): Promise<SyncPage<ExternalPayment>> {
    void input;
    throw new ProviderError(
      "invalid_request",
      "Xero payment pull requires a selected tenant connection",
    );
  }
  async pushInvoice(
    input: ProviderCall & { invoice: Invoice; requestKey: string },
  ): Promise<{ externalId: string }> {
    void input;
    throw new ProviderError(
      "invalid_request",
      "Xero invoice push requires a selected tenant connection",
    );
  }
}
