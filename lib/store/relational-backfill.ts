import { snapshotFromStored } from "./serialize";
import type { StorageState } from "./schema";

export type SqlStatement = { text: string; params: Array<string | number | boolean | null> };

/** Shared by the normal idempotent backfill and the atomic demo replacement. */
export function buildBackfillStatements(
  state: StorageState,
  options: { adminEmail?: string; replacingDemo?: boolean } = {},
): SqlStatement[] {
  const snapshot = snapshotFromStored(state);
  const scope = [state.organization.id, state.entity.id];
  const userId = `user_${state.entity.id}`;
  const membershipId = `membership_${state.organization.id}`;
  const periodId = `period_${state.entity.id}_legacy`;
  const bankId = `bank_account_${state.entity.id}_legacy`;
  const statements: SqlStatement[] = [
    {
      text: "SELECT set_config('app.organization_id', $1, true), set_config('app.entity_id', $2, true)",
      params: scope,
    },
  ];
  function insert(
    table: string,
    columns: string,
    params: SqlStatement["params"],
    conflict = "(id)",
  ) {
    const ignoreConflict = !options.replacingDemo || table === "audit_events";
    statements.push({
      text: `INSERT INTO ${table} (${columns}) VALUES (${params.map((_, i) => `$${i + 1}`).join(", ")})${ignoreConflict ? ` ON CONFLICT ${conflict} DO NOTHING` : ""}`,
      params,
    });
  }

  // Reset keeps the existing entity and every user/membership exactly in place.
  if (!options.replacingDemo) {
    insert("organizations", "id, name, created_at", [
      state.organization.id,
      state.organization.name,
      state.organization.createdAt,
    ]);
    insert("users", "id, email, display_name", [
      userId,
      options.adminEmail ?? "admin@ledgerflow.local",
      "LedgerFlow Admin",
    ]);
    insert(
      "entities",
      "id, organization_id, name, legal_name, base_currency, timezone, auto_apply_threshold, fee_tolerance_minor, ai_provider",
      [
        state.entity.id,
        state.organization.id,
        state.entity.name,
        state.entity.legalName,
        state.entity.currency,
        state.entity.timezone,
        state.entity.settings.autoApplyThreshold,
        state.entity.settings.feeToleranceMinor,
        state.entity.settings.aiProvider,
      ],
    );
    insert(
      "organization_memberships",
      "id, organization_id, user_id, role",
      [membershipId, state.organization.id, userId, "admin"],
      "(organization_id, user_id)",
    );
    insert(
      "membership_entities",
      "organization_id, membership_id, entity_id",
      [state.organization.id, membershipId, state.entity.id],
      "",
    );
  }
  insert("fiscal_periods", "id, organization_id, entity_id, name, start_date, end_date", [
    periodId,
    ...scope,
    "Legacy migration",
    "2000-01-01",
    "2100-01-01",
  ]);

  for (const account of state.accounts) {
    insert(
      "accounts",
      "id, organization_id, entity_id, code, name, account_type, control_type, currency, active",
      [
        account.id,
        ...scope,
        account.code,
        account.name,
        account.type,
        account.control,
        account.currency,
        account.active,
      ],
    );
  }
  for (const customer of state.customers) {
    insert(
      "customers",
      "id, organization_id, entity_id, name, email, company, currency, created_at",
      [
        customer.id,
        ...scope,
        customer.name,
        customer.email,
        customer.company ?? null,
        customer.currency,
        customer.createdAt,
      ],
    );
  }
  for (const rule of state.categoryRules) {
    insert(
      "category_rules",
      "id, organization_id, entity_id, name, account_id, flow, priority, active",
      [rule.id, ...scope, rule.name, rule.accountId, rule.flow ?? null, rule.priority, rule.active],
    );
    for (const [position, keyword] of rule.keywords.entries())
      insert(
        "category_rule_keywords",
        "organization_id, entity_id, rule_id, position, keyword",
        [...scope, rule.id, position, keyword],
        "",
      );
  }

  // Journals precede documents, which reference their entry IDs.
  for (const entry of snapshot.journalEntries) {
    insert(
      "journal_entries",
      "id, organization_id, entity_id, fiscal_period_id, posting_date, base_currency, description, source_type, source_id, reverses_entry_id, created_at",
      [
        entry.id,
        ...scope,
        periodId,
        entry.date,
        entry.lines[0]?.amount.currency ?? state.entity.currency,
        entry.description,
        entry.source,
        entry.sourceId,
        entry.reverses ?? null,
        entry.createdAt,
      ],
    );
    for (const [lineNo, line] of entry.lines.entries())
      insert(
        "journal_lines",
        "id, organization_id, entity_id, journal_entry_id, line_no, account_id, side, base_amount_minor, memo",
        [
          line.id,
          ...scope,
          entry.id,
          lineNo + 1,
          line.accountId,
          line.side,
          line.amount.minor.toString(),
          line.memo ?? null,
        ],
      );
  }
  for (const invoice of snapshot.invoices) {
    const total = invoice.total.minor.toString();
    insert(
      "invoices",
      "id, organization_id, entity_id, customer_id, number, issue_date, due_date, currency, subtotal_minor, total_minor, base_subtotal_minor, base_total_minor, status, journal_entry_id, created_at",
      [
        invoice.id,
        ...scope,
        invoice.customerId,
        invoice.number,
        invoice.issueDate,
        invoice.dueDate,
        invoice.currency,
        total,
        total,
        total,
        total,
        invoice.status,
        invoice.journalEntryId ?? null,
        invoice.createdAt,
      ],
    );
    for (const [lineNo, line] of invoice.lines.entries()) {
      const lineTotal = (line.unitMinor * BigInt(line.quantity)).toString();
      insert(
        "invoice_lines",
        "id, organization_id, entity_id, invoice_id, line_no, description, quantity, unit_minor, line_total_minor, base_line_total_minor, account_id",
        [
          line.id,
          ...scope,
          invoice.id,
          lineNo + 1,
          line.description,
          line.quantity,
          line.unitMinor.toString(),
          lineTotal,
          lineTotal,
          line.accountId,
        ],
      );
    }
  }
  insert(
    "bank_accounts",
    "id, organization_id, entity_id, general_ledger_account_id, name, currency",
    [bankId, ...scope, "acct_bank", "Legacy operating bank", state.entity.currency],
  );
  for (const transaction of snapshot.transactions) {
    const amount = transaction.amount.minor.toString();
    insert(
      "bank_transactions",
      "id, organization_id, entity_id, bank_account_id, source, external_id, transaction_date, amount_minor, currency, base_amount_minor, flow, description, reference, counterparty, status, posted_journal_entry_id, created_at",
      [
        transaction.id,
        ...scope,
        bankId,
        "legacy",
        transaction.externalId,
        transaction.date,
        amount,
        transaction.amount.currency,
        amount,
        transaction.flow,
        transaction.description,
        transaction.reference,
        transaction.counterparty ?? null,
        transaction.status,
        transaction.journalEntryId ?? null,
        transaction.createdAt,
      ],
    );
  }
  for (const match of snapshot.matches) {
    insert(
      "matches",
      "id, organization_id, entity_id, bank_transaction_id, status, confidence, suggested_account_id, rationale, created_at, resolved_at",
      [
        match.id,
        ...scope,
        match.bankTransactionId,
        match.status,
        match.confidence,
        match.suggestedAccountId ?? null,
        JSON.stringify(match.rationale),
        match.createdAt,
        match.resolvedAt ?? null,
      ],
    );
    for (const allocation of match.allocations) {
      const amount = allocation.amount.minor.toString();
      insert(
        "match_allocations",
        "id, organization_id, entity_id, match_id, invoice_id, amount_minor, currency, base_amount_minor",
        [
          `allocation_${match.id}_${allocation.invoiceId}`,
          ...scope,
          match.id,
          allocation.invoiceId,
          amount,
          allocation.amount.currency,
          amount,
        ],
      );
    }
  }
  for (const event of state.auditEvents) {
    insert(
      "audit_events",
      "id, organization_id, entity_id, actor_label, action, object_type, object_id, detail, created_at",
      [
        event.id,
        ...scope,
        event.actor,
        event.action,
        event.objectType,
        event.objectId,
        event.detail,
        event.createdAt,
      ],
    );
  }
  return statements;
}
