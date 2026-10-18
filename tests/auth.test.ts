import { describe, expect, it } from "vitest";
import { authenticate, getSession, sessionCookie } from "@/lib/auth";
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

  it("limits repeated mutation attempts", () => {
    clearRateLimits();
    for (let attempt = 0; attempt < 2; attempt += 1) enforceRateLimit("test", 2, 60_000);
    expect(() => enforceRateLimit("test", 2, 60_000)).toThrow("Too many requests");
    clearRateLimits();
  });
});
