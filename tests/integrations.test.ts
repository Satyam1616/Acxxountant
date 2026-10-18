import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { createPkcePair, validateReturnPath } from "@/lib/integrations/oauth";
import { QuickBooksClient, XeroClient } from "@/lib/integrations/providers";

describe("integration security foundations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ENCRYPTION_KEY;
    delete process.env.QUICKBOOKS_CLIENT_ID;
    delete process.env.QUICKBOOKS_CLIENT_SECRET;
    delete process.env.QUICKBOOKS_REDIRECT_URI;
    delete process.env.XERO_CLIENT_ID;
    delete process.env.XERO_CLIENT_SECRET;
    delete process.env.XERO_REDIRECT_URI;
  });

  it("encrypts credentials with authenticated encryption", () => {
    process.env.ENCRYPTION_KEY = "test-key-that-is-long-enough-for-hmac";
    const encrypted = encryptSecret("provider-token", "tenant:connection");
    expect(decryptSecret(encrypted, "tenant:connection")).toBe("provider-token");
    expect(() => decryptSecret(`${encrypted}tampered`, "tenant:connection")).toThrow(
      "credential_tampered",
    );
  });

  it("creates PKCE material and rejects open redirects", () => {
    const pair = createPkcePair();
    expect(pair.state.length).toBeGreaterThan(32);
    expect(pair.challenge).not.toBe(pair.verifier);
    expect(validateReturnPath("/settings")).toBe("/settings");
    expect(validateReturnPath("https://evil.example")).toBe("/settings");
    expect(validateReturnPath("//evil.example")).toBe("/settings");
  });

  it("builds a provider authorization URL without exposing client secrets", () => {
    process.env.QUICKBOOKS_CLIENT_ID = "client-id";
    process.env.QUICKBOOKS_CLIENT_SECRET = "client-secret";
    process.env.QUICKBOOKS_REDIRECT_URI =
      "https://app.example/api/integrations/quickbooks/callback";
    const url = new QuickBooksClient().buildAuthorizationUrl({
      redirectUri: process.env.QUICKBOOKS_REDIRECT_URI,
      state: "state",
      codeChallenge: "challenge",
      scopes: ["com.intuit.quickbooks.accounting"],
    });
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.toString()).not.toContain("client-secret");
  });

  it("sends PKCE parameters to Xero too", () => {
    process.env.XERO_CLIENT_ID = "xero-client-id";
    process.env.XERO_CLIENT_SECRET = "xero-client-secret";
    process.env.XERO_REDIRECT_URI = "https://app.example/api/integrations/xero/callback";
    const url = new XeroClient().buildAuthorizationUrl({
      redirectUri: process.env.XERO_REDIRECT_URI,
      state: "state",
      codeChallenge: "challenge",
      scopes: ["openid", "offline_access"],
    });
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("normalizes QuickBooks invoice pages without using floating-point money", async () => {
    const fetchMock = vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            QueryResponse: {
              Invoice: [
                {
                  Id: "qb-1",
                  DocNumber: "INV-1",
                  TxnDate: "2026-01-02",
                  DueDate: "2026-02-01",
                  CurrencyRef: { value: "USD" },
                  TotalAmt: "123.45",
                  Balance: "0.00",
                  CustomerRef: { name: "Example Co" },
                },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await new QuickBooksClient().listInvoices({
      credential: {
        connectionId: "connection",
        credentialRef: "realm",
        accessToken: "token" as never,
        scopes: [],
      },
      requestId: "request",
      cursor: null,
    });
    expect(result.items[0]).toMatchObject({
      externalId: "qb-1",
      number: "INV-1",
      total: { currency: "USD", minor: "12345" },
      status: "paid",
    });
    expect(String(fetchMock.mock.calls[0][0])).toContain("realm");
  });

  it("normalizes Xero payment pages and sends the tenant header", async () => {
    const fetchMock = vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(
      async (_url, init) => {
        void init;
        return new Response(
          JSON.stringify({
            Payments: [
              {
                PaymentID: "xero-payment-1",
                Date: "2026-01-03T00:00:00",
                Amount: "20.50",
                Reference: "INV-1",
                Status: "AUTHORISED",
                Invoice: { CurrencyCode: "EUR" },
              },
            ],
          }),
          { status: 200 },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await new XeroClient().listPayments({
      credential: {
        connectionId: "connection",
        credentialRef: "xero-tenant",
        accessToken: "token" as never,
        scopes: [],
      },
      requestId: "request",
      cursor: null,
    });
    expect(result.items[0]).toMatchObject({
      externalId: "xero-payment-1",
      amount: { currency: "EUR", minor: "2050" },
      status: "AUTHORISED",
    });
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>)["Xero-tenant-id"]).toBe(
      "xero-tenant",
    );
  });
});
