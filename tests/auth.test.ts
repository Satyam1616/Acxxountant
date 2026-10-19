import { describe, expect, it } from "vitest";
import { authenticate, getSession, requireSession, sessionCookie } from "@/lib/auth";
import { clearRateLimits, enforceRateLimit } from "@/lib/rate-limit";

describe("workspace authentication", () => {
  it("signs and verifies an http-only session cookie", () => {
    const session = authenticate("admin@ledgerflow.local", "demo");
    const cookie = sessionCookie(session);
    const request = new Request("http://localhost", {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    expect(getSession(request)?.email).toBe("admin@ledgerflow.local");
    expect(
      getSession(
        new Request("http://localhost", { headers: { cookie: `${cookie.name}=tampered` } }),
      ),
    ).toBeNull();
  });

  it("rejects invalid credentials", () => {
    expect(() => authenticate("admin@ledgerflow.local", "wrong-password")).toThrow(
      "Email or password",
    );
  });

  it("supports multiple configured users with independent roles", () => {
    const previous = process.env.APP_AUTH_USERS;
    process.env.APP_AUTH_USERS = JSON.stringify([
      { email: "owner@example.com", password: "owner-password", role: "admin" },
      { email: "books@example.com", password: "books-password", role: "accountant" },
      { email: "review@example.com", password: "review-password", role: "viewer" },
    ]);
    try {
      expect(authenticate("books@example.com", "books-password").role).toBe("accountant");
      expect(authenticate("review@example.com", "review-password").role).toBe("viewer");
      expect(() => authenticate("review@example.com", "books-password")).toThrow(
        "Email or password",
      );
    } finally {
      if (previous === undefined) delete process.env.APP_AUTH_USERS;
      else process.env.APP_AUTH_USERS = previous;
    }
  });

  it("enforces role boundaries before a route performs its action", () => {
    const previous = process.env.APP_AUTH_USERS;
    process.env.APP_AUTH_USERS = JSON.stringify([
      { email: "review@example.com", password: "review-password", role: "viewer" },
    ]);
    try {
      const cookie = sessionCookie(authenticate("review@example.com", "review-password"));
      const request = new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { cookie: `${cookie.name}=${cookie.value}` },
      });
      expect(() => requireSession(request, ["admin"])).toThrow(
        "Your role cannot perform this action",
      );
      expect(requireSession(request).role).toBe("viewer");
    } finally {
      if (previous === undefined) delete process.env.APP_AUTH_USERS;
      else process.env.APP_AUTH_USERS = previous;
    }
  });

  it("limits repeated mutation attempts", () => {
    clearRateLimits();
    for (let attempt = 0; attempt < 2; attempt += 1) enforceRateLimit("test", 2, 60_000);
    expect(() => enforceRateLimit("test", 2, 60_000)).toThrow("Too many requests");
    clearRateLimits();
  });
});
