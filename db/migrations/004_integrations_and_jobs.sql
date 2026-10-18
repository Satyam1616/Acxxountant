CREATE TABLE IF NOT EXISTS credit_notes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  original_invoice_id TEXT,
  number TEXT NOT NULL,
  issue_date DATE NOT NULL,
  currency TEXT NOT NULL REFERENCES currencies(code),
  subtotal_minor BIGINT NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor BIGINT NOT NULL CHECK (total_minor = subtotal_minor + tax_minor),
  base_total_minor BIGINT NOT NULL CHECK (base_total_minor >= 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'issued', 'void')),
  reason TEXT,
  journal_entry_id TEXT,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, entity_id, number),
  UNIQUE (organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, customer_id) REFERENCES customers(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, original_invoice_id) REFERENCES invoices(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, journal_entry_id) REFERENCES journal_entries(organization_id, entity_id, id)
);

CREATE TABLE IF NOT EXISTS credit_note_allocations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  credit_note_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL REFERENCES currencies(code),
  base_amount_minor BIGINT NOT NULL CHECK (base_amount_minor > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, entity_id, credit_note_id, invoice_id),
  FOREIGN KEY (organization_id, entity_id, credit_note_id) REFERENCES credit_notes(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, invoice_id) REFERENCES invoices(organization_id, entity_id, id)
);

CREATE TABLE IF NOT EXISTS credit_note_lines (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  credit_note_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity BIGINT NOT NULL CHECK (quantity > 0),
  unit_minor BIGINT NOT NULL CHECK (unit_minor >= 0),
  line_total_minor BIGINT NOT NULL CHECK (line_total_minor = quantity * unit_minor),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  account_id TEXT NOT NULL,
  UNIQUE (organization_id, entity_id, credit_note_id, line_no),
  FOREIGN KEY (organization_id, entity_id, credit_note_id) REFERENCES credit_notes(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, account_id) REFERENCES accounts(organization_id, entity_id, id)
);

CREATE TABLE IF NOT EXISTS integration_connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('plaid', 'quickbooks', 'xero')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'needs_attention', 'disconnected', 'revoked')),
  external_tenant_id TEXT,
  external_tenant_name TEXT,
  credential_ref TEXT,
  credentials_ciphertext TEXT,
  credential_key_version INTEGER,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, entity_id, id),
  UNIQUE (organization_id, provider, external_tenant_id),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id)
);

CREATE TABLE IF NOT EXISTS integration_sync_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  sync_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  cursor_before TEXT,
  cursor_after TEXT,
  rows_imported INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (organization_id, entity_id, connection_id) REFERENCES integration_connections(organization_id, entity_id, id)
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  integration_connection_id TEXT,
  external_account_id TEXT,
  general_ledger_account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  currency TEXT NOT NULL REFERENCES currencies(code),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, entity_id, id),
  UNIQUE (organization_id, entity_id, integration_connection_id, external_account_id),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id),
  FOREIGN KEY (organization_id, entity_id, integration_connection_id) REFERENCES integration_connections(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, general_ledger_account_id) REFERENCES accounts(organization_id, entity_id, id)
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  bank_account_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'csv',
  external_id TEXT NOT NULL,
  provider_transaction_id TEXT,
  pending_provider_transaction_id TEXT,
  transaction_date DATE NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL REFERENCES currencies(code),
  base_amount_minor BIGINT NOT NULL CHECK (base_amount_minor > 0),
  flow TEXT NOT NULL CHECK (flow IN ('inflow', 'outflow')),
  description TEXT NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  counterparty TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'posted' CHECK (lifecycle IN ('pending', 'posted', 'removed')),
  status TEXT NOT NULL CHECK (status IN ('unreviewed', 'suggested', 'posted', 'excluded')),
  posted_journal_entry_id TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, entity_id, bank_account_id, source, external_id),
  UNIQUE (organization_id, entity_id, bank_account_id, source, provider_transaction_id),
  UNIQUE (organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, bank_account_id) REFERENCES bank_accounts(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, posted_journal_entry_id) REFERENCES journal_entries(organization_id, entity_id, id)
);

CREATE INDEX IF NOT EXISTS bank_transactions_review_idx ON bank_transactions (organization_id, entity_id, status, transaction_date DESC);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  bank_transaction_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'rejected', 'unmatched')),
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  confidence NUMERIC(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  proposal_source TEXT NOT NULL DEFAULT 'rules',
  suggested_account_id TEXT,
  rationale JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, entity_id, id),
  resolved_at TIMESTAMPTZ,
  resolved_by_user_id TEXT REFERENCES users(id),
  FOREIGN KEY (organization_id, entity_id, bank_transaction_id) REFERENCES bank_transactions(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, suggested_account_id) REFERENCES accounts(organization_id, entity_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS matches_current_uq ON matches (organization_id, entity_id, bank_transaction_id) WHERE is_current;

CREATE TABLE IF NOT EXISTS match_allocations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  invoice_id TEXT,
  payable_invoice_id TEXT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL REFERENCES currencies(code),
  base_amount_minor BIGINT NOT NULL CHECK (base_amount_minor > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (organization_id, entity_id, match_id) REFERENCES matches(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, invoice_id) REFERENCES invoices(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, payable_invoice_id) REFERENCES payable_invoices(organization_id, entity_id, id),
  CHECK ((invoice_id IS NOT NULL AND payable_invoice_id IS NULL) OR (invoice_id IS NULL AND payable_invoice_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS match_invoice_allocation_uq ON match_allocations (match_id, invoice_id) WHERE invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS match_payable_allocation_uq ON match_allocations (match_id, payable_invoice_id) WHERE payable_invoice_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS oauth_states (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  user_id TEXT,
  provider TEXT NOT NULL CHECK (provider IN ('quickbooks', 'xero')),
  redirect_uri TEXT NOT NULL,
  code_verifier_ciphertext TEXT NOT NULL,
  return_path TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS oauth_pending_connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('quickbooks', 'xero')),
  credentials_ciphertext TEXT NOT NULL,
  tenants JSONB NOT NULL,
  return_path TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  CHECK (jsonb_typeof(tenants) = 'array')
);

CREATE INDEX IF NOT EXISTS oauth_pending_connections_expiry_idx
  ON oauth_pending_connections (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT,
  actor_user_id TEXT REFERENCES users(id),
  actor_label TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  detail TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id)
);

CREATE INDEX IF NOT EXISTS audit_events_entity_idx ON audit_events (organization_id, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  idempotency_key TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id)
);

CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox_events (available_at, occurred_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT,
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'dead_letter', 'cancelled')),
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  idempotency_key TEXT,
  UNIQUE (organization_id, idempotency_key),
  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id)
);

CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs (run_after, created_at) WHERE status IN ('queued', 'retry_wait');

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'succeeded', 'failed')),
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (organization_id, entity_id, scope, idempotency_key),
  FOREIGN KEY (organization_id) REFERENCES organizations(id),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id)
);
