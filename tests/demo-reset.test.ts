import { describe, expect, it, vi } from "vitest";
import type { neon } from "@neondatabase/serverless";
import {
  buildDemoResetPlan,
  DEMO_RESET_ACTION,
  DEMO_RESET_CONFIRMATION,
} from "@/lib/store/demo-reset";
import { buildBackfillStatements } from "@/lib/store/relational-backfill";
import { createSeedState } from "@/lib/store/seed";
import { snapshotFromStored } from "@/lib/store/serialize";
import { validateJournalEntry, invoiceTotal } from "@/lib/domain/ledger";
import { runBackfill } from "@/scripts/backfill-relational";

describe("guarded INR demo replacement", () => {
  function client() {
    const source = createSeedState();
    const query = vi.fn(async () => [{ version: 9, state: source }]);
    const transaction = vi.fn(async () => []);
    return {
      query,
      transaction,
      sql: { query, transaction } as unknown as ReturnType<typeof neon>,
    };
  }

  it("is read-only by default, even with the confirmation set", async () => {
    const db = client();
    expect(
      await runBackfill(db.sql, {
        resetDemo: true,
        apply: false,
        confirmation: DEMO_RESET_CONFIRMATION,
      }),
    ).toMatchObject({ status: "dry_run", currency: "INR" });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects missing confirmation before any query", async () => {
    const db = client();
    await expect(runBackfill(db.sql, { resetDemo: true, apply: true })).rejects.toMatchObject({
      code: "demo_reset_confirmation_required",
    });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("submits the entire backup, replacement, rebuild, and verification in one transaction", async () => {
    const db = client();
    const result = await runBackfill(db.sql, {
      resetDemo: true,
      apply: true,
      confirmation: DEMO_RESET_CONFIRMATION,
    });
    expect(result.status).toBe("ok");
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls.length).toBeGreaterThan(80);
  });

  it("does not report success or continue if its atomic transaction fails", async () => {
    const db = client();
    db.transaction.mockRejectedValueOnce(new Error("constraint failure"));
    await expect(
      runBackfill(db.sql, { resetDemo: true, apply: true, confirmation: DEMO_RESET_CONFIRMATION }),
    ).rejects.toThrow("constraint failure");
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("refuses other workspaces, mixed tenants, repeat resets and invalid versions", () => {
    const state = createSeedState();
    expect(() =>
      buildDemoResetPlan({ ...state, organization: { ...state.organization, id: "other" } }, 1),
    ).toThrow("demo_reset_wrong_workspace");
    expect(() => buildDemoResetPlan(state, 0)).toThrow("demo_reset_invalid_version");
    state.customers[0].entityId = "other";
    expect(() => buildDemoResetPlan(state, 1)).toThrow("demo_reset_mixed_workspace");
    const reset = buildDemoResetPlan(createSeedState(), 1);
    expect(reset.state.auditEvents[0].action).toBe(DEMO_RESET_ACTION);
    expect(() => buildDemoResetPlan(reset.state, 2)).toThrow("demo_already_reset");
  });

  it("locks and checks the version before backup/deletion, with explicit RLS context", () => {
    const plan = buildDemoResetPlan(createSeedState(), 9);
    expect(plan.statements[1].params).toEqual(["org_demo", "entity_demo", "9"]);
    expect(plan.statements[1].text).toContain("set_config('app.entity_id'");
    expect(plan.statements[2].text).toContain("FOR UPDATE");
    expect(plan.statements[2].text).toContain("app.demo_reset_version");
    expect(plan.statements[2].text).toContain("demo_reset_protected_records");
    expect(plan.statements[3].params).toEqual([plan.backupId]);
    expect(plan.statements[3].text).toContain("INSERT INTO ledgerflow_state");
    const deletions = plan.statements.filter(({ text }) => text.startsWith("DELETE"));
    for (const deletion of deletions) {
      expect(deletion.text).toContain("WHERE organization_id = $1 AND entity_id = $2");
      expect(deletion.params).toEqual(["org_demo", "entity_demo"]);
      expect(deletion.text).not.toMatch(/users|membership|audit|integration|oauth/);
    }
    expect(plan.statements.at(-1)?.text).toContain("demo_reset_accounting_verification_failed");
  });

  it("rebuilds exact rupee/paise values and uses strict inserts to detect ID collisions", () => {
    const state = createSeedState();
    const snapshot = snapshotFromStored(state);
    expect(state.invoices[0].total).toEqual({ currency: "INR", minor: "12500000" });
    for (const invoice of snapshot.invoices)
      expect(invoiceTotal(invoice.lines, invoice.currency)).toEqual(invoice.total);
    for (const entry of snapshot.journalEntries)
      expect(() => validateJournalEntry(entry, snapshot.accounts)).not.toThrow();
    const statements = buildBackfillStatements(state, { replacingDemo: true });
    const firstInvoice = statements.find(({ text }) => text.startsWith("INSERT INTO invoices "))!;
    expect(firstInvoice.params.slice(7, 12)).toEqual([
      "INR",
      "12500000",
      "12500000",
      "12500000",
      "12500000",
    ]);
    expect(firstInvoice.text).not.toContain("ON CONFLICT");
    expect(
      statements.some(({ text }) =>
        /^INSERT INTO (users|entities|organizations|.*memberships|membership_entities) /.test(text),
      ),
    ).toBe(false);
    const indexOf = (table: string) =>
      statements.findIndex(({ text }) => text.startsWith(`INSERT INTO ${table} `));
    expect(indexOf("journal_entries")).toBeLessThan(indexOf("invoices"));
    expect(indexOf("invoices")).toBeLessThan(indexOf("match_allocations"));
    for (const statement of statements.filter(({ text }) => text.startsWith("INSERT"))) {
      const columns = statement.text.match(/\(([^)]+)\) VALUES/)![1].split(",");
      expect(columns).toHaveLength(statement.params.length);
      expect(statement.text).toContain(`$${statement.params.length}`);
    }
  });

  it("preserves idempotent insert behavior for ordinary backfills", () => {
    const inserts = buildBackfillStatements(createSeedState()).filter(({ text }) =>
      text.startsWith("INSERT"),
    );
    expect(inserts.every(({ text }) => text.includes("DO NOTHING"))).toBe(true);
    expect(inserts.some(({ text }) => text.startsWith("INSERT INTO users "))).toBe(true);
  });
});
