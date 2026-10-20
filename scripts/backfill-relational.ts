import { pathToFileURL } from "node:url";
import { neon } from "@neondatabase/serverless";
import { Agent } from "undici";
import { DomainError, invariant } from "@/lib/domain/errors";
import { createSeedState } from "@/lib/store/seed";
import { validateStorageState } from "@/lib/store/schema";
import { assertResetConfirmation, buildDemoResetPlan } from "@/lib/store/demo-reset";
import { buildBackfillStatements } from "@/lib/store/relational-backfill";

export type BackfillOptions = {
  resetDemo: boolean;
  apply: boolean;
  confirmation?: string;
  adminEmail?: string;
};

export async function runBackfill(sql: ReturnType<typeof neon>, options: BackfillOptions) {
  if (options.resetDemo && options.apply) assertResetConfirmation(options.confirmation);
  let rows = (await sql.query("SELECT version, state FROM ledgerflow_state WHERE id = $1", [
    "primary-workspace",
  ])) as Array<{ version: number; state: unknown }>;
  if (!rows[0] && !options.resetDemo) {
    const seed = createSeedState();
    await sql.query(
      "INSERT INTO ledgerflow_state (id, version, state) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING",
      ["primary-workspace", seed.version, JSON.stringify(seed)],
    );
    rows = (await sql.query("SELECT version, state FROM ledgerflow_state WHERE id = $1", [
      "primary-workspace",
    ])) as Array<{ version: number; state: unknown }>;
  }
  invariant(rows[0], "workspace_missing", "Backfill the database before resetting a demo");
  const state = validateStorageState(rows[0].state);
  if (options.resetDemo) {
    const plan = buildDemoResetPlan(state, rows[0].version);
    const summary = {
      organizationId: state.organization.id,
      entityId: state.entity.id,
      previousCurrency: state.entity.currency,
      currency: plan.state.entity.currency,
      replacedInvoices: state.invoices.length,
      replacedTransactions: state.transactions.length,
      seedInvoices: plan.state.invoices.length,
      seedTransactions: plan.state.transactions.length,
    };
    if (!options.apply) return { status: "dry_run", ...summary };
    // Neon executes these lazily in ONE HTTPS transaction. Any guard, constraint,
    // insert or final verification failure leaves the previous state untouched.
    await sql.transaction(plan.statements.map(({ text, params }) => sql.query(text, params)));
    return { status: "ok", ...summary, backupId: plan.backupId };
  }
  const statements = buildBackfillStatements(state, { adminEmail: options.adminEmail });
  await sql.transaction(statements.map(({ text, params }) => sql.query(text, params)));
  return {
    status: "ok",
    organizationId: state.organization.id,
    entityId: state.entity.id,
    queries: statements.length,
  };
}

async function main() {
  const args = process.argv.slice(2);
  invariant(
    args.every((arg) => ["--reset-demo-inr", "--apply"].includes(arg)),
    "invalid_backfill_option",
  );
  const resetDemo = args.includes("--reset-demo-inr");
  const apply = args.includes("--apply");
  invariant(!apply || resetDemo, "invalid_backfill_option");
  if (resetDemo && apply) assertResetConfirmation(process.env.RESET_DEMO_CONFIRM);
  const connection = process.env.DATABASE_URL;
  invariant(connection, "database_not_configured", "DATABASE_URL is required");
  const dispatcher = new Agent({ connect: { family: 4, port: 443 } });
  try {
    const result = await runBackfill(neon(connection, { fetchOptions: { dispatcher } }), {
      resetDemo,
      apply,
      confirmation: process.env.RESET_DEMO_CONFIRM,
      adminEmail: process.env.APP_AUTH_EMAIL,
    });
    console.log(JSON.stringify(result));
  } finally {
    await dispatcher.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Never print connection strings, SQL parameters, provider material or raw database errors.
    const code =
      error instanceof DomainError
        ? error.code
        : error instanceof Error && /^demo_reset_[a-z_]+$/.test(error.message)
          ? error.message
          : "database_operation_failed";
    console.error(
      JSON.stringify({
        status: "error",
        code,
        hint: "No reset is committed on failure. Check database connectivity, migration 006, and the README reset prerequisites.",
      }),
    );
    process.exitCode = 1;
  });
}
