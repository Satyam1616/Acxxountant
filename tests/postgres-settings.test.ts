import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/lib/store/seed";
import { type StorageState } from "@/lib/store/schema";
import { sessionCookie } from "@/lib/auth";
import { PUT } from "@/app/api/settings/route";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@neondatabase/serverless", () => ({ neon: () => ({ query }) }));
// Exercise the real PostgreSQL adapter and API error mapper, not the JSON adapter.
vi.mock("@/lib/store", async () => {
  const postgres = await import("@/lib/store/postgres");
  return {
    getState: postgres.getPostgresState,
    updateState: postgres.updatePostgresState,
    getStorageInfo: () => ({ adapter: "postgres", durable: true, ephemeral: false }),
  };
});

describe("PostgreSQL settings API", () => {
  let persisted: StorageState;
  let version: number;

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgres://test:placeholder@db.example/test");
    vi.stubEnv("AUTH_SECRET", "test-only-signing-key-not-used-in-production");
    vi.stubEnv(
      "APP_AUTH_USERS",
      '[{"email":"admin@example.com","password":"test-only-password","role":"admin"}]',
    );
    persisted = createSeedState();
    version = 12;
    query.mockReset();
    query.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("CREATE TABLE")) return [];
      if (sql.includes("SELECT version, state"))
        return [{ version, state: structuredClone(persisted) }];
      if (sql.includes("UPDATE ledgerflow_state")) {
        expect(params[2]).toBe(version);
        persisted = JSON.parse(String(params[1]));
        version += 1;
        return [{ version }];
      }
      throw new Error("Unexpected test query");
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  function request(body: unknown, role: "admin" | "accountant" | "viewer" = "admin") {
    const cookie = sessionCookie({
      email: "admin@example.com",
      role,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    return new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: `${cookie.name}=${cookie.value}` },
      body: JSON.stringify(body),
    });
  }

  it("returns 400 rather than 503 for forbidden base-currency changes, without writing", async () => {
    // A synthetic legacy USD fixture, not a conversion operation.
    persisted = JSON.parse(JSON.stringify(persisted).replaceAll('"INR"', '"USD"'));
    const before = structuredClone(persisted);
    const response = await PUT(request({ currency: "INR", timezone: "Asia/Kolkata" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "currency_change_forbidden" });
    expect(persisted).toEqual(before);
    expect(query.mock.calls.some(([sql]) => sql.includes("UPDATE ledgerflow_state"))).toBe(false);
  });

  it("saves normal INR settings and can read the persisted result back", async () => {
    const response = await PUT(
      request({ currency: "INR", timezone: "Asia/Kolkata", feeToleranceMinor: "2500" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      defaultCurrency: "INR",
      feeToleranceMinor: "2500",
    });
    expect(persisted.entity.currency).toBe("INR");
    expect(persisted.auditEvents[0]?.actor).toBe("admin@example.com");
    expect(version).toBe(13);
  });

  it("returns 400 for invalid input before querying the database", async () => {
    const response = await PUT(request({ currency: "ZZZ" }));
    expect(response.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["accountant", "viewer"] as const)(
    "rejects a %s before database access",
    async (role) => {
      expect((await PUT(request({ currency: "INR" }, role))).status).toBe(403);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("keeps real database failures as redacted 503 responses", async () => {
    query.mockRejectedValueOnce(new Error("private connection details must not be returned"));
    const response = await PUT(request({ timezone: "Asia/Kolkata" }));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.code).toBe("database_write_failed");
    expect(body.error).not.toContain("private connection details");
  });
});
