import { describe, expect, it } from "vitest";
import { authenticate, getSession, sessionCookie } from "@/lib/auth";

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
});
