CREATE TABLE IF NOT EXISTS fiscal_periods (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'locked')),
  closed_at TIMESTAMPTZ,
  closed_by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, entity_id, id),
  CHECK (start_date < end_date),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id)
);

CREATE INDEX IF NOT EXISTS fiscal_periods_lookup_idx ON fiscal_periods (organization_id, entity_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS tax_rates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  jurisdiction TEXT,
  applies_to TEXT NOT NULL DEFAULT 'both' CHECK (applies_to IN ('sales', 'purchase', 'both')),
  rate_ppm BIGINT NOT NULL CHECK (rate_ppm BETWEEN 0 AND 1000000),
  effective_from DATE NOT NULL,
  effective_to DATE,
  output_account_id TEXT,
  input_account_id TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, entity_id, code, effective_from),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id),
  FOREIGN KEY (organization_id, entity_id, output_account_id) REFERENCES accounts(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, input_account_id) REFERENCES accounts(organization_id, entity_id, id),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE IF NOT EXISTS fx_rates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  rate_date DATE NOT NULL,
  from_currency TEXT NOT NULL REFERENCES currencies(code),
  to_currency TEXT NOT NULL REFERENCES currencies(code),
  numerator NUMERIC(40,0) NOT NULL CHECK (numerator > 0),
  denominator NUMERIC(40,0) NOT NULL CHECK (denominator > 0),
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'transaction' CHECK (purpose IN ('transaction', 'closing')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, entity_id, rate_date, from_currency, to_currency, provider, purpose),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  fiscal_period_id TEXT NOT NULL,
  posting_date DATE NOT NULL,
  base_currency TEXT NOT NULL REFERENCES currencies(code),
  description TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('invoice', 'credit-note', 'payable-invoice', 'payable-credit-note', 'bank-reconciliation', 'manual', 'opening', 'reversal', 'fx-revaluation')),
  source_id TEXT NOT NULL,
  reverses_entry_id TEXT,
  reversal_reason TEXT,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, entity_id, id),
  UNIQUE (organization_id, entity_id, source_type, source_id),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id),
  FOREIGN KEY (organization_id, entity_id, fiscal_period_id) REFERENCES fiscal_periods(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, reverses_entry_id) REFERENCES journal_entries(organization_id, entity_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS journal_reversal_uq ON journal_entries (organization_id, entity_id, reverses_entry_id) WHERE source_type = 'reversal';
CREATE INDEX IF NOT EXISTS journal_entries_date_idx ON journal_entries (organization_id, entity_id, posting_date DESC, id);

CREATE TABLE IF NOT EXISTS journal_lines (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  journal_entry_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('debit', 'credit')),
  base_amount_minor BIGINT NOT NULL CHECK (base_amount_minor > 0),
  foreign_amount_minor BIGINT,
  foreign_currency TEXT REFERENCES currencies(code),
  fx_rate_id TEXT REFERENCES fx_rates(id),
  memo TEXT,
  UNIQUE (organization_id, entity_id, journal_entry_id, line_no),
  FOREIGN KEY (organization_id, entity_id, journal_entry_id) REFERENCES journal_entries(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, account_id) REFERENCES accounts(organization_id, entity_id, id),
  CHECK (foreign_amount_minor IS NULL OR foreign_amount_minor > 0),
  CHECK ((foreign_amount_minor IS NULL AND foreign_currency IS NULL) OR (foreign_amount_minor IS NOT NULL AND foreign_currency IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS journal_lines_account_idx ON journal_lines (organization_id, entity_id, account_id);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  number TEXT NOT NULL,
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  currency TEXT NOT NULL REFERENCES currencies(code),
  fx_rate_id TEXT REFERENCES fx_rates(id),
  subtotal_minor BIGINT NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor BIGINT NOT NULL CHECK (total_minor = subtotal_minor + tax_minor),
  base_subtotal_minor BIGINT NOT NULL CHECK (base_subtotal_minor >= 0),
  base_tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (base_tax_minor >= 0),
  base_total_minor BIGINT NOT NULL CHECK (base_total_minor = base_subtotal_minor + base_tax_minor),
  status TEXT NOT NULL CHECK (status IN ('draft', 'issued', 'partial', 'paid', 'overdue', 'void')),
  journal_entry_id TEXT,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issued_at TIMESTAMPTZ,
  voided_at TIMESTAMPTZ,
  UNIQUE (organization_id, entity_id, number),
  FOREIGN KEY (organization_id, entity_id, customer_id) REFERENCES customers(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, journal_entry_id) REFERENCES journal_entries(organization_id, entity_id, id),
  CHECK (issue_date <= due_date)
);

CREATE INDEX IF NOT EXISTS invoices_review_idx ON invoices (organization_id, entity_id, status, due_date);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity BIGINT NOT NULL CHECK (quantity > 0),
  unit_minor BIGINT NOT NULL CHECK (unit_minor >= 0),
  line_total_minor BIGINT NOT NULL CHECK (line_total_minor = quantity * unit_minor),
  tax_rate_id TEXT REFERENCES tax_rates(id),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  base_line_total_minor BIGINT NOT NULL CHECK (base_line_total_minor >= 0),
  base_tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (base_tax_minor >= 0),
  account_id TEXT NOT NULL,
  UNIQUE (organization_id, entity_id, invoice_id, line_no),
  FOREIGN KEY (organization_id, entity_id, invoice_id) REFERENCES invoices(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, account_id) REFERENCES accounts(organization_id, entity_id, id)
);

CREATE TABLE IF NOT EXISTS payable_invoices (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL,
  number TEXT NOT NULL,
  vendor_reference TEXT,
  issue_date DATE NOT NULL,
  due_date DATE NOT NULL,
  currency TEXT NOT NULL REFERENCES currencies(code),
  fx_rate_id TEXT REFERENCES fx_rates(id),
  subtotal_minor BIGINT NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor BIGINT NOT NULL CHECK (total_minor = subtotal_minor + tax_minor),
  base_subtotal_minor BIGINT NOT NULL CHECK (base_subtotal_minor >= 0),
  base_tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (base_tax_minor >= 0),
  base_total_minor BIGINT NOT NULL CHECK (base_total_minor = base_subtotal_minor + base_tax_minor),
  status TEXT NOT NULL CHECK (status IN ('draft', 'received', 'partial', 'paid', 'overdue', 'void')),
  journal_entry_id TEXT,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, entity_id, number),
  FOREIGN KEY (organization_id, entity_id, vendor_id) REFERENCES vendors(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, journal_entry_id) REFERENCES journal_entries(organization_id, entity_id, id),
  CHECK (issue_date <= due_date)
);

CREATE TABLE IF NOT EXISTS payable_invoice_lines (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payable_invoice_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity BIGINT NOT NULL CHECK (quantity > 0),
  unit_minor BIGINT NOT NULL CHECK (unit_minor >= 0),
  line_total_minor BIGINT NOT NULL CHECK (line_total_minor = quantity * unit_minor),
  tax_rate_id TEXT REFERENCES tax_rates(id),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  base_line_total_minor BIGINT NOT NULL CHECK (base_line_total_minor >= 0),
  base_tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (base_tax_minor >= 0),
  account_id TEXT NOT NULL,
  UNIQUE (organization_id, entity_id, payable_invoice_id, line_no),
  FOREIGN KEY (organization_id, entity_id, payable_invoice_id) REFERENCES payable_invoices(organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id, account_id) REFERENCES accounts(organization_id, entity_id, id)
);
