import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export type Role = "admin" | "accountant" | "viewer";
export type Session = { email: string; role: Role; issuedAt: number; expiresAt: number };

export class AuthError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

export const loginSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(512),
  })
  .strict();

const cookieName = "ledgerflow_session";
const sessionLifetimeMs = 8 * 60 * 60 * 1000;

function configuredSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret && (process.env.NODE_ENV !== "production" || secret.length >= 32)) return secret;
  if (process.env.NODE_ENV !== "production") return "local-development-secret-change-me";
  throw new AuthError(
    "auth_not_configured",
    "AUTH_SECRET is required before production access is enabled",
    503,
  );
}

function configuredCredentials(): { email: string; password: string; role: Role } {
  const password =
    process.env.APP_AUTH_PASSWORD ?? (process.env.NODE_ENV !== "production" ? "demo" : "");
  if (!password || (process.env.NODE_ENV === "production" && password.length < 12))
    throw new AuthError(
      "auth_not_configured",
      "APP_AUTH_PASSWORD is required before production access is enabled",
      503,
    );
  const email = (process.env.APP_AUTH_EMAIL ?? "admin@ledgerflow.local").trim().toLowerCase();
  if (process.env.NODE_ENV === "production" && !process.env.APP_AUTH_EMAIL)
    throw new AuthError(
      "auth_not_configured",
      "APP_AUTH_EMAIL is required before production access is enabled",
      503,
    );
  const roleValue = process.env.APP_AUTH_ROLE ?? "admin";
  if (!email || !["admin", "accountant", "viewer"].includes(roleValue)) {
    throw new AuthError("auth_not_configured", "APP_AUTH_EMAIL and APP_AUTH_ROLE are invalid", 503);
  }
  return { email, password, role: roleValue as Role };
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signature(value: string): string {
  return createHmac("sha256", configuredSecret()).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenFor(session: Session): string {
  const payload = encode(JSON.stringify(session));
  return `${payload}.${signature(payload)}`;
}

function sessionFromToken(token: string | undefined): Session | null {
  if (!token) return null;
  const [payload, providedSignature] = token.split(".");
  if (!payload || !providedSignature || !safeEqual(signature(payload), providedSignature))
    return null;
  try {
    const session = JSON.parse(decode(payload)) as Session;
    if (!session.email || !session.expiresAt || session.expiresAt <= Date.now()) return null;
    if (!["admin", "accountant", "viewer"].includes(session.role)) return null;
    return session;
  } catch {
    return null;
  }
}

function cookieValue(request: Request): string | undefined {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  return cookie?.slice(cookieName.length + 1);
}

export function authenticate(email: string, password: string): Session {
  const credentials = configuredCredentials();
  if (
    email.trim().toLowerCase() !== credentials.email ||
    !safeEqual(password, credentials.password)
  ) {
    throw new AuthError("invalid_credentials", "Email or password is incorrect");
  }
  const issuedAt = Date.now();
  return {
    email: credentials.email,
    role: credentials.role,
    issuedAt,
    expiresAt: issuedAt + sessionLifetimeMs,
  };
}

export function sessionCookie(session: Session): {
  name: string;
  value: string;
  options: Record<string, unknown>;
} {
  return {
    name: cookieName,
    value: tokenFor(session),
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: Math.floor(sessionLifetimeMs / 1000),
    },
  };
}

export function clearSessionCookie() {
  return {
    name: cookieName,
    value: "",
    options: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      path: "/",
      maxAge: 0,
    },
  };
}

export function getSession(request: Request): Session | null {
  return sessionFromToken(cookieValue(request));
}

export function requireSession(
  request: Request,
  allowedRoles: Role[] = ["admin", "accountant", "viewer"],
): Session {
  configuredCredentials();
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin && origin !== process.env.APP_URL)
      throw new AuthError("origin_mismatch", "Cross-origin mutations are not allowed", 403);
  }
  const session = getSession(request);
  if (!session) throw new AuthError("authentication_required", "Sign in to continue");
  if (!allowedRoles.includes(session.role))
    throw new AuthError("forbidden", "Your role cannot perform this action", 403);
  return session;
}

export function authStatus(): { configured: boolean; developmentFallback: boolean } {
  try {
    configuredSecret();
    configuredCredentials();
    return {
      configured: true,
      developmentFallback: process.env.NODE_ENV !== "production" && !process.env.APP_AUTH_PASSWORD,
    };
  } catch {
    return { configured: false, developmentFallback: false };
  }
}
