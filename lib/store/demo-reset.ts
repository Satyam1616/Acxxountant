import { randomUUID } from "node:crypto";
import { invariant } from "@/lib/domain/errors";
import { validateJournalEntry } from "@/lib/domain/ledger";
import { createSeedState } from "./seed";
import { validateStorageState, type StorageState } from "./schema";
import { snapshotFromStored } from "./serialize";
import { buildBackfillStatements, type SqlStatement } from "./relational-backfill";

export const DEMO_RESET_CONFIRMATION = "RESET_ORG_DEMO";
export const DEMO_RESET_ACTION = "workspace.demo_reset_to_inr";

// Only these legacy demo tables are replaced. Identity, memberships, audit history,
// integration credentials and other tenants are never deleted by this operation.
const replacementTables = [
  "match_allocations",
  "matches",
  "bank_transactions",
  "bank_accounts",
  "invoice_lines",
  "invoices",
  "journal_lines",
  "journal_entries",
  "category_rule_keywords",
  "category_rules",
  "customers",
  "accounts",
  "fiscal_periods",
] as const;

// These features are not represented in the JSON snapshot. Fail closed rather than
// delete records/credentials that could not be restored from our snapshot backup.
const protectedTables = [
  "integration_connections",
  "integration_sync_runs",
  "oauth_states",
  "oauth_pending_connections",
  "credit_notes",
  "credit_note_lines",
  "credit_note_allocations",
  "payable_invoices",
  "payable_invoice_lines",
  "vendors",
  "tax_rates",
  "fx_rates",
  "jobs",
  "outbox_events",
  "idempotency_keys",
] as const;

export function assertResetConfirmation(confirmation: string | undefined): void {
  invariant(
    confirmation === DEMO_RESET_CONFIRMATION,
    "demo_reset_confirmation_required",
    `Set RESET_DEMO_CONFIRM=${DEMO_RESET_CONFIRMATION} to replace the disposable demo data`,
  );
}

export function buildDemoResetPlan(original: StorageState, version: number) {
  invariant(Number.isSafeInteger(version) && version > 0, "demo_reset_invalid_version");
  invariant(
    original.organization.id === "org_demo" &&
      original.entity.id === "entity_demo" &&
      original.entity.organizationId === "org_demo",
    "demo_reset_wrong_workspace",
  );
  for (const records of [
    original.customers,
    original.invoices,
    original.transactions,
    original.matches,
    original.journalEntries,
    original.categoryRules,
    original.auditEvents,
  ]) {
    invariant(
      records.every((record) => record.entityId === "entity_demo"),
      "demo_reset_mixed_workspace",
    );
  }
  invariant(
    !original.auditEvents.some((event) => event.action === DEMO_RESET_ACTION),
    "demo_already_reset",
    "This demo was already reset; existing INR work was left untouched",
  );

  const backupId = `demo-inr-backup-${randomUUID()}`;
  const seed = createSeedState();
  seed.auditEvents.unshift({
    id: `audit_${randomUUID()}`,
    entityId: seed.entity.id,
    actor: "demo-reset-cli",
    action: DEMO_RESET_ACTION,
    objectType: "entity",
    objectId: seed.entity.id,
    detail: `Replaced disposable ${original.entity.currency} demo with fresh INR data; snapshot backup ${backupId}`,
    createdAt: new Date().toISOString(),
  });
  const state = validateStorageState(seed);
  const snapshot = snapshotFromStored(state);
  invariant(state.entity.currency === "INR", "demo_reset_seed_invalid");
  for (const entry of snapshot.journalEntries) validateJournalEntry(entry, snapshot.accounts);
  const scope = ["org_demo", "entity_demo"];
  const statements: SqlStatement[] = [
    { text: "SELECT pg_advisory_xact_lock(7813921)", params: [] },
    {
      text: "SELECT set_config('app.organization_id', $1, true), set_config('app.entity_id', $2, true), set_config('app.demo_reset_version', $3, true)",
      params: [...scope, String(version)],
    },
    { text: resetGuardSql(), params: [] },
    {
      text: "INSERT INTO ledgerflow_state (id, version, state) SELECT $1, version, state FROM ledgerflow_state WHERE id = 'primary-workspace'",
      params: [backupId],
    },
  ];
  for (const table of replacementTables) {
    statements.push({
      text: `DELETE FROM ${table} WHERE organization_id = $1 AND entity_id = $2`,
      params: scope,
    });
  }
  statements.push({
    text: "UPDATE entities SET name = $3, legal_name = $4, base_currency = 'INR', timezone = $5, auto_apply_threshold = $6, fee_tolerance_minor = $7, ai_provider = $8, updated_at = NOW() WHERE organization_id = $1 AND id = $2",
    params: [
      ...scope,
      state.entity.name,
      state.entity.legalName,
      state.entity.timezone,
      state.entity.settings.autoApplyThreshold,
      state.entity.settings.feeToleranceMinor,
      state.entity.settings.aiProvider,
    ],
  });
  statements.push(...buildBackfillStatements(state, { replacingDemo: true }));
  statements.push({
    text: "UPDATE ledgerflow_state SET version = version + 1, state = $1::jsonb, updated_at = NOW() WHERE id = 'primary-workspace'",
    params: [JSON.stringify(state)],
  });
  statements.push({ text: resetVerificationSql, params: [] });
  return { state, backupId, statements };
}

function resetGuardSql(): string {
  const protectedRecords = protectedTables
    .map(
      (table) =>
        `EXISTS (SELECT 1 FROM ${table} WHERE organization_id = 'org_demo' AND entity_id = 'entity_demo')`,
    )
    .join(" OR ");
  return `DO $$ BEGIN
    PERFORM 1 FROM ledgerflow_state WHERE id = 'primary-workspace' FOR UPDATE;
    IF NOT EXISTS (
      SELECT 1 FROM ledgerflow_state WHERE id = 'primary-workspace'
      AND version = current_setting('app.demo_reset_version')::integer
      AND state #>> '{organization,id}' = 'org_demo'
      AND state #>> '{entity,id}' = 'entity_demo'
      AND state #>> '{entity,organizationId}' = 'org_demo'
    ) THEN RAISE EXCEPTION 'demo_reset_workspace_changed'; END IF;
    PERFORM 1 FROM entities WHERE organization_id = 'org_demo' AND id = 'entity_demo' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'demo_reset_entity_missing'; END IF;
    IF NOT EXISTS (SELECT 1 FROM currencies WHERE code = 'INR' AND minor_units = 2 AND active)
      THEN RAISE EXCEPTION 'demo_reset_inr_migration_required'; END IF;
    IF ${protectedRecords}
      THEN RAISE EXCEPTION 'demo_reset_protected_records'; END IF;
  END $$`;
}

// Failure of any check rolls back the replacement AND the backup in the same transaction.
const resetVerificationSql = `DO $$
DECLARE snapshot JSONB;
BEGIN
  SELECT state INTO snapshot FROM ledgerflow_state WHERE id = 'primary-workspace';
  IF snapshot #>> '{entity,currency}' <> 'INR'
    OR NOT EXISTS (SELECT 1 FROM entities WHERE organization_id = 'org_demo' AND id = 'entity_demo' AND base_currency = 'INR')
    OR (SELECT count(*) FROM invoices WHERE organization_id = 'org_demo' AND entity_id = 'entity_demo') <> jsonb_array_length(snapshot->'invoices')
    OR (SELECT count(*) FROM journal_entries WHERE organization_id = 'org_demo' AND entity_id = 'entity_demo') <> jsonb_array_length(snapshot->'journalEntries')
    OR (SELECT count(*) FROM bank_transactions WHERE organization_id = 'org_demo' AND entity_id = 'entity_demo') <> jsonb_array_length(snapshot->'transactions')
  THEN RAISE EXCEPTION 'demo_reset_verification_failed'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'invoices') AS item
    LEFT JOIN invoices AS i ON i.id = item->>'id' AND i.organization_id = 'org_demo' AND i.entity_id = 'entity_demo'
    WHERE i.id IS NULL OR i.currency <> 'INR' OR i.total_minor <> (item #>> '{total,minor}')::bigint
  ) OR EXISTS (
    SELECT 1 FROM journal_lines WHERE organization_id = 'org_demo' AND entity_id = 'entity_demo'
    GROUP BY journal_entry_id
    HAVING sum(CASE WHEN side = 'debit' THEN base_amount_minor ELSE -base_amount_minor END) <> 0
  ) THEN RAISE EXCEPTION 'demo_reset_accounting_verification_failed'; END IF;
END $$`;
