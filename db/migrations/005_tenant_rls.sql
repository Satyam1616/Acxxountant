-- The application role must not own these tables and must not have BYPASSRLS.
-- It sets app.organization_id/app.entity_id with SET LOCAL per transaction.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'entities', 'organization_memberships', 'membership_entities', 'accounts',
    'category_rules', 'customers', 'vendors', 'fiscal_periods', 'tax_rates',
    'fx_rates', 'journal_entries', 'journal_lines', 'invoices', 'invoice_lines',
    'payable_invoices', 'payable_invoice_lines', 'credit_notes',
    'credit_note_lines', 'credit_note_allocations', 'integration_connections',
    'integration_sync_runs', 'bank_accounts', 'bank_transactions', 'matches',
    'match_allocations', 'oauth_states', 'audit_events', 'outbox_events',
    'jobs', 'idempotency_keys'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;

DROP POLICY IF EXISTS tenant_entities_policy ON entities;
CREATE POLICY tenant_entities_policy ON entities USING (
  organization_id = current_setting('app.organization_id', true)
  AND id = current_setting('app.entity_id', true)
) WITH CHECK (
  organization_id = current_setting('app.organization_id', true)
  AND id = current_setting('app.entity_id', true)
);

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'membership_entities', 'accounts', 'category_rules',
    'customers', 'vendors', 'fiscal_periods', 'tax_rates', 'fx_rates',
    'journal_entries', 'journal_lines', 'invoices', 'invoice_lines',
    'payable_invoices', 'payable_invoice_lines', 'credit_notes',
    'credit_note_lines', 'credit_note_allocations', 'integration_connections',
    'integration_sync_runs', 'bank_accounts', 'bank_transactions', 'matches',
    'match_allocations', 'oauth_states', 'audit_events', 'outbox_events',
    'jobs', 'idempotency_keys'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_scope_policy ON %I', table_name);
    EXECUTE format($policy$
      CREATE POLICY tenant_scope_policy ON %I USING (
        organization_id = current_setting('app.organization_id', true)
        AND (entity_id IS NULL OR entity_id = current_setting('app.entity_id', true))
      ) WITH CHECK (
        organization_id = current_setting('app.organization_id', true)
        AND (entity_id IS NULL OR entity_id = current_setting('app.entity_id', true))
      )
    $policy$, table_name);
  END LOOP;
END $$;

DROP POLICY IF EXISTS tenant_memberships_policy ON organization_memberships;
CREATE POLICY tenant_memberships_policy ON organization_memberships USING (
  organization_id = current_setting('app.organization_id', true)
) WITH CHECK (
  organization_id = current_setting('app.organization_id', true)
);
