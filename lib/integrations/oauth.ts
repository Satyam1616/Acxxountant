import { createHash, randomBytes } from "node:crypto";
import { AuthError } from "@/lib/auth";

export function createPkcePair(): { state: string; verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { state, verifier, challenge };
}

export function validateReturnPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\"))
    return "/settings";
  return value;
}

export function assertOAuthConfiguration(provider: "quickbooks" | "xero"): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const prefix = provider === "quickbooks" ? "QUICKBOOKS" : "XERO";
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  const redirectUri = process.env[`${prefix}_REDIRECT_URI`];
  if (!clientId || !clientSecret || !redirectUri)
    throw new AuthError("integration_not_configured", `${provider} OAuth is not configured`, 503);
  return { clientId, clientSecret, redirectUri };
}
