import { assertOAuthConfiguration } from "./oauth";
import type { CurrencyCode, Invoice } from "@/lib/domain/types";
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

const currencyScales: Record<CurrencyCode, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  JPY: 0,
  KRW: 0,
  BHD: 3,
  KWD: 3,
};

function currencyCode(value: string | undefined): CurrencyCode {
  return value && value in currencyScales ? (value as CurrencyCode) : "USD";
}

function minorUnits(value: string | number | undefined, currency: CurrencyCode): string {
  const text = String(value ?? "0").trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new ProviderError("malformed_response", "Provider returned an invalid amount");
  const scale = currencyScales[currency];
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]);
  let fraction = (match[3] ?? "").padEnd(scale, "0");
  let rounded = 0n;
  if (fraction.length > scale) {
    const roundDigit = fraction[scale];
    fraction = fraction.slice(0, scale);
    rounded = roundDigit && roundDigit >= "5" ? 1n : 0n;
  }
  const minor = whole * 10n ** BigInt(scale) + BigInt(fraction || "0") + rounded;
  return (sign * minor).toString();
}

function providerCallHeaders(input: ProviderCall): Record<string, string> {
  return {
    Authorization: `Bearer ${input.credential.accessToken}`,
    Accept: "application/json",
    "x-ledgerflow-request-id": input.requestId,
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
    const realmId = input.credential.credentialRef;
    if (!realmId)
      throw new ProviderError(
        "invalid_request",
        "QuickBooks invoice pull requires a realm connection",
      );
    const startPosition = Math.max(1, Number.parseInt(input.cursor ?? "1", 10) || 1);
    const query = `SELECT * FROM Invoice STARTPOSITION ${startPosition} MAXRESULTS 100`;
    const url = new URL(`${this.apiBase}/v3/company/${encodeURIComponent(realmId)}/query`);
    url.searchParams.set("query", query);
    url.searchParams.set("minorversion", "75");
    const payload = await fetchJson<{
      QueryResponse?: {
        Invoice?: Array<{
          Id?: string;
          DocNumber?: string;
          TxnDate?: string;
          DueDate?: string;
          CurrencyRef?: { value?: string };
          TotalAmt?: string | number;
          Balance?: string | number;
          CustomerRef?: { name?: string };
          TxnStatus?: string;
        }>;
      };
    }>(url.toString(), { headers: providerCallHeaders(input), signal: input.signal }, "QuickBooks");
    const invoices = payload.QueryResponse?.Invoice ?? [];
    const items = invoices.map((invoice) => {
      const currency = currencyCode(invoice.CurrencyRef?.value);
      const balance = minorUnits(invoice.Balance, currency);
      return {
        externalId: invoice.Id ?? invoice.DocNumber ?? "",
        number: invoice.DocNumber ?? invoice.Id ?? "",
        customerName: invoice.CustomerRef?.name,
        issueDate: invoice.TxnDate ?? new Date().toISOString().slice(0, 10),
        dueDate: invoice.DueDate,
        currency,
        total: { currency, minor: minorUnits(invoice.TotalAmt, currency) },
        status: balance === "0" ? "paid" : (invoice.TxnStatus ?? "open"),
      };
    });
    return {
      items,
      nextCursor: items.length === 100 ? String(startPosition + items.length) : null,
      hasMore: items.length === 100,
    };
  }
  async listPayments(
    input: ProviderCall & { cursor: string | null },
  ): Promise<SyncPage<ExternalPayment>> {
    const realmId = input.credential.credentialRef;
    if (!realmId)
      throw new ProviderError(
        "invalid_request",
        "QuickBooks payment pull requires a realm connection",
      );
    const startPosition = Math.max(1, Number.parseInt(input.cursor ?? "1", 10) || 1);
    const query = `SELECT * FROM Payment STARTPOSITION ${startPosition} MAXRESULTS 100`;
    const url = new URL(`${this.apiBase}/v3/company/${encodeURIComponent(realmId)}/query`);
    url.searchParams.set("query", query);
    url.searchParams.set("minorversion", "75");
    const payload = await fetchJson<{
      QueryResponse?: {
        Payment?: Array<{
          Id?: string;
          TxnDate?: string;
          TotalAmt?: string | number;
          PrivateNote?: string;
          CustomerRef?: { name?: string };
          CurrencyRef?: { value?: string };
        }>;
      };
    }>(url.toString(), { headers: providerCallHeaders(input), signal: input.signal }, "QuickBooks");
    const payments = payload.QueryResponse?.Payment ?? [];
    const items = payments.map((payment) => {
      const currency = currencyCode(payment.CurrencyRef?.value);
      return {
        externalId: payment.Id ?? "",
        date: payment.TxnDate ?? new Date().toISOString().slice(0, 10),
        amount: { currency, minor: minorUnits(payment.TotalAmt, currency) },
        reference: payment.PrivateNote ?? payment.CustomerRef?.name,
        status: "posted",
      };
    });
    return {
      items,
      nextCursor: items.length === 100 ? String(startPosition + items.length) : null,
      hasMore: items.length === 100,
    };
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
    const tenantId = input.credential.credentialRef;
    if (!tenantId)
      throw new ProviderError("invalid_request", "Xero invoice pull requires a tenant connection");
    const page = Math.max(1, Number.parseInt(input.cursor ?? "1", 10) || 1);
    const url = new URL("https://api.xero.com/api.xro/2.0/Invoices");
    url.searchParams.set("page", String(page));
    const payload = await fetchJson<{
      Invoices?: Array<{
        InvoiceID?: string;
        InvoiceNumber?: string;
        Type?: string;
        DateString?: string;
        DueDateString?: string;
        CurrencyCode?: string;
        Total?: string | number;
        AmountDue?: string | number;
        Contact?: { Name?: string };
        Status?: string;
      }>;
    }>(
      url.toString(),
      {
        headers: { ...providerCallHeaders(input), "Xero-tenant-id": tenantId },
        signal: input.signal,
      },
      "Xero",
    );
    const invoices = (payload.Invoices ?? []).filter((invoice) => invoice.Type === "ACCREC");
    const items = invoices.map((invoice) => {
      const currency = currencyCode(invoice.CurrencyCode);
      return {
        externalId: invoice.InvoiceID ?? invoice.InvoiceNumber ?? "",
        number: invoice.InvoiceNumber ?? invoice.InvoiceID ?? "",
        customerName: invoice.Contact?.Name,
        issueDate: invoice.DateString ?? new Date().toISOString().slice(0, 10),
        dueDate: invoice.DueDateString,
        currency,
        total: { currency, minor: minorUnits(invoice.Total, currency) },
        status:
          minorUnits(invoice.AmountDue, currency) === "0" || invoice.Status === "PAID"
            ? "paid"
            : (invoice.Status ?? "open"),
      };
    });
    return {
      items,
      nextCursor: items.length === 100 ? String(page + 1) : null,
      hasMore: items.length === 100,
    };
  }
  async listPayments(
    input: ProviderCall & { cursor: string | null },
  ): Promise<SyncPage<ExternalPayment>> {
    const tenantId = input.credential.credentialRef;
    if (!tenantId)
      throw new ProviderError("invalid_request", "Xero payment pull requires a tenant connection");
    const page = Math.max(1, Number.parseInt(input.cursor ?? "1", 10) || 1);
    const url = new URL("https://api.xero.com/api.xro/2.0/Payments");
    url.searchParams.set("page", String(page));
    const payload = await fetchJson<{
      Payments?: Array<{
        PaymentID?: string;
        Date?: string;
        Amount?: string | number;
        Reference?: string;
        Status?: string;
        Invoice?: { InvoiceNumber?: string; CurrencyCode?: string };
        Account?: { Name?: string };
      }>;
    }>(
      url.toString(),
      {
        headers: { ...providerCallHeaders(input), "Xero-tenant-id": tenantId },
        signal: input.signal,
      },
      "Xero",
    );
    const payments = payload.Payments ?? [];
    const items = payments.map((payment) => {
      const currency = currencyCode(payment.Invoice?.CurrencyCode);
      return {
        externalId: payment.PaymentID ?? "",
        date: payment.Date?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
        amount: { currency, minor: minorUnits(payment.Amount, currency) },
        reference: payment.Reference ?? payment.Invoice?.InvoiceNumber ?? payment.Account?.Name,
        status: payment.Status ?? "posted",
      };
    });
    return {
      items,
      nextCursor: items.length === 100 ? String(page + 1) : null,
      hasMore: items.length === 100,
    };
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
