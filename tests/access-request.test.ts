import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/auth/access-request/route";
import { clearRateLimits } from "@/lib/rate-limit";

const filename = path.join(tmpdir(), `ledgerflow-access-request-test-${randomUUID()}.json`);

function request(body: unknown, ip = "198.51.100.20") {
  return new Request("http://localhost/api/auth/access-request", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("request access workflow", () => {
  beforeEach(() => {
    process.env.ACCESS_REQUESTS_FILE = filename;
    clearRateLimits();
  });
  afterEach(async () => {
    delete process.env.ACCESS_REQUESTS_FILE;
    clearRateLimits();
    await fs.rm(filename, { force: true });
  });

  it("accepts a valid request and stores no password or privileged role", async () => {
    const response = await POST(
      request({
        name: "Priya Accountant",
        email: "Priya@example.com",
        message: "Need INR review access",
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "received" });
    const records = JSON.parse(await fs.readFile(filename, "utf8")) as Array<
      Record<string, string>
    >;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      name: "Priya Accountant",
      email: "priya@example.com",
      message: "Need INR review access",
      requestedRole: "accountant",
      status: "pending",
    });
    expect(records[0]).not.toHaveProperty("password");
  });

  it("does not reveal whether a pending email already exists", async () => {
    const payload = { name: "A User", email: "same@example.com" };
    expect((await POST(request(payload))).status).toBe(202);
    expect((await POST(request({ ...payload, name: "Another Name" }))).status).toBe(202);
    const records = JSON.parse(await fs.readFile(filename, "utf8")) as unknown[];
    expect(records).toHaveLength(1);
  });

  it("validates input and rate-limits public requests", async () => {
    expect((await POST(request({ name: "x", email: "not-an-email" }))).status).toBe(400);
    // The invalid attempt also consumes one public rate-limit slot.
    for (let attempt = 0; attempt < 4; attempt += 1)
      expect(
        (await POST(request({ name: `User ${attempt}`, email: `user${attempt}@example.com` })))
          .status,
      ).toBe(202);
    expect((await POST(request({ name: "Sixth User", email: "sixth@example.com" }))).status).toBe(
      429,
    );
  });
});
