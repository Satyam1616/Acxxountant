import { neonConfig, Pool } from "@neondatabase/serverless";
import ws from "ws";
import { snapshotFromStored } from "@/lib/store/serialize";
import { validateStorageState } from "@/lib/store/schema";

neonConfig.webSocketConstructor ??= ws;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString, max: 1 });
async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const stateRow = await client.query<{ state: unknown }>(
      "SELECT state FROM ledgerflow_state WHERE id = $1 FOR UPDATE",
      ["primary-workspace"],
    );
    if (!stateRow.rows[0]) throw new Error("The legacy primary-workspace state row does not exist");
    const state = validateStorageState(stateRow.rows[0].state);
    const snapshot = snapshotFromStored(state);
    const userId = `user_${state.entity.id}`;
    const membershipId = `membership_${state.organization.id}`;
    const periodId = `period_${state.entity.id}_legacy`;
    const bankAccountId = `bank_account_${state.entity.id}_legacy`;

    await client.query(
      "SELECT set_config('app.organization_id', $1, true), set_config('app.entity_id', $2, true)",
      [state.organization.id, state.entity.id],
    );

    await client.query(
      "INSERT INTO organizations (id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
      [state.organization.id, state.organization.name, state.organization.createdAt],
    );
    await client.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
      [userId, process.env.APP_AUTH_EMAIL ?? "admin@ledgerflow.local", "LedgerFlow Admin"],
    );
    await client.query(
      "INSERT INTO entities (id, organization_id, name, legal_name, base_currency, timezone, auto_apply_threshold, fee_tolerance_minor, ai_provider) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING",
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
    await client.query(
      "INSERT INTO organization_memberships (id, organization_id, user_id, role) VALUES ($1,$2,$3,'admin') ON CONFLICT (organization_id, user_id) DO NOTHING",
      [membershipId, state.organization.id, userId],
    );
    await client.query(
      "INSERT INTO membership_entities (organization_id, membership_id, entity_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [state.organization.id, membershipId, state.entity.id],
    );
    await client.query(
      "INSERT INTO fiscal_periods (id, organization_id, entity_id, name, start_date, end_date) VALUES ($1,$2,$3,'Legacy migration','2000-01-01','2100-01-01') ON CONFLICT (id) DO NOTHING",
      [periodId, state.organization.id, state.entity.id],
    );

    for (const account of state.accounts) {
      await client.query(
        "INSERT INTO accounts (id, organization_id, entity_id, code, name, account_type, control_type, currency, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING",
        [
          account.id,
          state.organization.id,
          state.entity.id,
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
      await client.query(
        "INSERT INTO customers (id, organization_id, entity_id, name, email, company, currency, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING",
        [
          customer.id,
          state.organization.id,
          state.entity.id,
          customer.name,
          customer.email,
          customer.company ?? null,
          customer.currency,
          customer.createdAt,
        ],
      );
    }
    for (const rule of state.categoryRules) {
      await client.query(
        "INSERT INTO category_rules (id, organization_id, entity_id, name, account_id, flow, priority, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING",
        [
          rule.id,
          state.organization.id,
          state.entity.id,
          rule.name,
          rule.accountId,
          rule.flow ?? null,
          rule.priority,
          rule.active,
        ],
      );
      for (const [position, keyword] of rule.keywords.entries())
        await client.query(
          "INSERT INTO category_rule_keywords (organization_id, entity_id, rule_id, position, keyword) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
          [state.organization.id, state.entity.id, rule.id, position, keyword],
        );
    }
    // Journal entries must exist before invoices because invoices carry a
    // tenant-qualified journal_entry_id foreign key.
    for (const entry of snapshot.journalEntries) {
      await client.query(
        "INSERT INTO journal_entries (id, organization_id, entity_id, fiscal_period_id, posting_date, base_currency, description, source_type, source_id, reverses_entry_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING",
        [
          entry.id,
          state.organization.id,
          state.entity.id,
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
        await client.query(
          "INSERT INTO journal_lines (id, organization_id, entity_id, journal_entry_id, line_no, account_id, side, base_amount_minor, memo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING",
          [
            line.id,
            state.organization.id,
            state.entity.id,
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
      await client.query(
        "INSERT INTO invoices (id, organization_id, entity_id, customer_id, number, issue_date, due_date, currency, subtotal_minor, total_minor, base_subtotal_minor, base_total_minor, status, journal_entry_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING",
        [
          invoice.id,
          state.organization.id,
          state.entity.id,
          invoice.customerId,
          invoice.number,
          invoice.issueDate,
          invoice.dueDate,
          invoice.currency,
          invoice.total.minor.toString(),
          invoice.status,
          invoice.journalEntryId ?? null,
          invoice.createdAt,
        ],
      );
      for (const [lineNo, line] of invoice.lines.entries())
        await client.query(
          "INSERT INTO invoice_lines (id, organization_id, entity_id, invoice_id, line_no, description, quantity, unit_minor, line_total_minor, base_line_total_minor, account_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10) ON CONFLICT (id) DO NOTHING",
          [
            line.id,
            state.organization.id,
            state.entity.id,
            invoice.id,
            lineNo + 1,
            line.description,
            line.quantity,
            line.unitMinor.toString(),
            (line.unitMinor * BigInt(line.quantity)).toString(),
            line.accountId,
          ],
        );
    }
    await client.query(
      "INSERT INTO bank_accounts (id, organization_id, entity_id, general_ledger_account_id, name, currency) VALUES ($1,$2,$3,'acct_bank','Legacy operating bank',$4) ON CONFLICT (id) DO NOTHING",
      [bankAccountId, state.organization.id, state.entity.id, state.entity.currency],
    );
    for (const transaction of snapshot.transactions) {
      await client.query(
        "INSERT INTO bank_transactions (id, organization_id, entity_id, bank_account_id, source, external_id, transaction_date, amount_minor, currency, base_amount_minor, flow, description, reference, counterparty, status, posted_journal_entry_id, created_at) VALUES ($1,$2,$3,$4,'legacy',$5,$6,$7,$8,$7,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING",
        [
          transaction.id,
          state.organization.id,
          state.entity.id,
          bankAccountId,
          transaction.externalId,
          transaction.date,
          transaction.amount.minor.toString(),
          transaction.amount.currency,
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
      await client.query(
        "INSERT INTO matches (id, organization_id, entity_id, bank_transaction_id, status, confidence, suggested_account_id, rationale, created_at, resolved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) ON CONFLICT (id) DO NOTHING",
        [
          match.id,
          state.organization.id,
          state.entity.id,
          match.bankTransactionId,
          match.status,
          match.confidence,
          match.suggestedAccountId ?? null,
          JSON.stringify(match.rationale),
          match.createdAt,
          match.resolvedAt ?? null,
        ],
      );
      for (const allocation of match.allocations)
        await client.query(
          "INSERT INTO match_allocations (id, organization_id, entity_id, match_id, invoice_id, amount_minor, currency, base_amount_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$6) ON CONFLICT (id) DO NOTHING",
          [
            `allocation_${match.id}_${allocation.invoiceId}`,
            state.organization.id,
            state.entity.id,
            match.id,
            allocation.invoiceId,
            allocation.amount.minor.toString(),
            allocation.amount.currency,
          ],
        );
    }
    for (const event of state.auditEvents)
      await client.query(
        "INSERT INTO audit_events (id, organization_id, entity_id, actor_label, action, object_type, object_id, detail, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING",
        [
          event.id,
          state.organization.id,
          state.entity.id,
          event.actor,
          event.action,
          event.objectType,
          event.objectId,
          event.detail,
          event.createdAt,
        ],
      );
    await client.query("COMMIT");
    console.log(
      JSON.stringify({
        status: "ok",
        organizationId: state.organization.id,
        entityId: state.entity.id,
      }),
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
