import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDemoResetPlan } from "@/lib/store/demo-reset";
import { buildBackfillStatements, type SqlStatement } from "@/lib/store/relational-backfill";
import { createSeedState } from "@/lib/store/seed";
import type { StorageState } from "@/lib/store/schema";

// Real PostgreSQL semantics compiled to WASM: no network, server, credentials, or
// modifications to any configured database. Exercises all six actual migrations.
describe("atomic demo replacement on offline PostgreSQL", () => {
  let db: PGlite;
  let legacy: StorageState;

  beforeEach(async () => {
    db = new PGlite();
    const directory = path.join(process.cwd(), "db/migrations");
    for (const file of (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort())
      await db.exec(await readFile(path.join(directory, file), "utf8"));
    legacy = JSON.parse(JSON.stringify(createSeedState()).replaceAll('"INR"', '"USD"'));
    await db.query(
      "INSERT INTO ledgerflow_state (id, version, state) VALUES ('primary-workspace', 9, $1::jsonb)",
      [JSON.stringify(legacy)],
    );
    for (const { text, params } of buildBackfillStatements(legacy)) await db.query(text, params);
    await db.exec(`
      INSERT INTO users (id,email) VALUES ('extra-user','viewer@example.test');
      INSERT INTO organization_memberships (id, organization_id, user_id, role, all_entities)
        VALUES ('extra-membership','org_demo','extra-user','viewer',false);
      INSERT INTO membership_entities (organization_id,membership_id,entity_id)
        VALUES ('org_demo','extra-membership','entity_demo');
      INSERT INTO organizations (id,name) VALUES ('org_other','Other tenant');
      INSERT INTO entities (id,organization_id,name,legal_name,base_currency,timezone)
        VALUES ('entity_other','org_other','Other','Other Limited','USD','UTC');
      INSERT INTO customers (id,organization_id,entity_id,name,email,currency)
        VALUES ('other-customer','org_other','entity_other','Other Customer','other@example.test','USD');
      CREATE ROLE reset_operator NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO reset_operator;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO reset_operator;
    `);
  }, 30_000);
  afterEach(async () => {
    await db?.close();
  });

  async function apply(statements: SqlStatement[], failAtEnd = false) {
    await db.transaction(async (tx) => {
      await tx.exec("SET LOCAL ROLE reset_operator");
      for (const { text, params } of statements) await tx.query(text, params);
      if (failAtEnd) await tx.exec("SELECT 1 / 0");
    });
  }
  async function current() {
    return (
      await db.query<{ version: number; state: StorageState }>(
        "SELECT version, state FROM ledgerflow_state WHERE id = 'primary-workspace'",
      )
    ).rows[0];
  }

  it("replaces both representations under RLS and preserves identity, audit, backup and other tenants", async () => {
    const plan = buildDemoResetPlan(legacy, 9);
    await apply(plan.statements);
    expect((await current()).version).toBe(10);
    expect((await current()).state).toEqual(plan.state);
    const backup = await db.query<{ state: StorageState }>(
      "SELECT state FROM ledgerflow_state WHERE id = $1",
      [plan.backupId],
    );
    expect(backup.rows[0].state).toEqual(legacy);
    const invoice = (
      await db.query(
        "SELECT currency, total_minor::text AS minor FROM invoices WHERE id = 'inv_1042'",
      )
    ).rows[0];
    expect(invoice).toEqual({ currency: "INR", minor: "12500000" });
    expect(
      (await db.query("SELECT currency FROM customers WHERE id = 'other-customer'")).rows[0],
    ).toEqual({ currency: "USD" });
    expect(
      (await db.query("SELECT role FROM organization_memberships WHERE id = 'extra-membership'"))
        .rows[0],
    ).toEqual({ role: "viewer" });
    expect(
      (await db.query("SELECT 1 FROM membership_entities WHERE membership_id = 'extra-membership'"))
        .rows,
    ).toHaveLength(1);
    const auditCount = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM audit_events WHERE organization_id = 'org_demo'",
    );
    expect(auditCount.rows[0].count).toBe(legacy.auditEvents.length + 1);
  }, 30_000);

  it("rolls back all deletions, replacements and the backup after a late failure", async () => {
    const plan = buildDemoResetPlan(legacy, 9);
    await expect(apply(plan.statements, true)).rejects.toThrow();
    expect((await current()).state).toEqual(legacy);
    expect((await current()).version).toBe(9);
    expect((await db.query("SELECT currency FROM invoices WHERE id = 'inv_1042'")).rows[0]).toEqual(
      { currency: "USD" },
    );
    expect(
      (await db.query("SELECT 1 FROM ledgerflow_state WHERE id = $1", [plan.backupId])).rows,
    ).toHaveLength(0);
  }, 30_000);

  it("refuses a stale snapshot before making changes", async () => {
    const plan = buildDemoResetPlan(legacy, 9);
    await db.exec("UPDATE ledgerflow_state SET version = 10 WHERE id = 'primary-workspace'");
    await expect(apply(plan.statements)).rejects.toThrow("demo_reset_workspace_changed");
    expect((await current()).state).toEqual(legacy);
  }, 30_000);

  it("refuses protected provider records instead of deleting credentials", async () => {
    await db.exec(
      "INSERT INTO integration_connections (id,organization_id,entity_id,provider) VALUES ('connected-test','org_demo','entity_demo','xero')",
    );
    await expect(apply(buildDemoResetPlan(legacy, 9).statements)).rejects.toThrow(
      "demo_reset_protected_records",
    );
    expect((await current()).state).toEqual(legacy);
    expect(
      (await db.query("SELECT 1 FROM integration_connections WHERE id = 'connected-test'")).rows,
    ).toHaveLength(1);
  }, 30_000);
});
