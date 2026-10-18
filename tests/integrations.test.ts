import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { createPkcePair, validateReturnPath } from "@/lib/integrations/oauth";
import { QuickBooksClient, XeroClient } from "@/lib/integrations/providers";

describe("integration security foundations", () => {
  afterEach(() => {
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
});
