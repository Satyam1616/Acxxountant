CREATE TABLE IF NOT EXISTS currencies (
  code TEXT PRIMARY KEY,
  minor_units SMALLINT NOT NULL CHECK (minor_units BETWEEN 0 AND 6),
  active BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO currencies (code, minor_units) VALUES
  ('USD', 2), ('EUR', 2), ('GBP', 2), ('CAD', 2), ('JPY', 0),
  ('KRW', 0), ('BHD', 3), ('KWD', 3)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT,
  auth_subject TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_auth_subject_uq ON users (auth_subject) WHERE auth_subject IS NOT NULL;

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  legal_name TEXT NOT NULL,
  base_currency TEXT NOT NULL REFERENCES currencies(code),
  timezone TEXT NOT NULL,
  auto_apply_threshold NUMERIC(5,4) NOT NULL DEFAULT 0.9000 CHECK (auto_apply_threshold BETWEEN 0 AND 1),
  fee_tolerance_minor BIGINT NOT NULL DEFAULT 0 CHECK (fee_tolerance_minor >= 0),
  ai_provider TEXT NOT NULL DEFAULT 'rules' CHECK (ai_provider IN ('rules', 'groq', 'claude')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS entities_organization_idx ON entities (organization_id);

CREATE TABLE IF NOT EXISTS organization_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'accountant', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'suspended', 'revoked')),
  all_entities BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (organization_id, user_id),
  UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS memberships_user_idx ON organization_memberships (user_id, status);

CREATE TABLE IF NOT EXISTS membership_entities (
  organization_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, membership_id, entity_id),
  FOREIGN KEY (organization_id, membership_id) REFERENCES organization_memberships(organization_id, id),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id)
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'income', 'expense')),
  control_type TEXT CHECK (control_type IS NULL OR control_type IN ('bank', 'receivable', 'payable', 'unapplied')),
  currency TEXT REFERENCES currencies(code),
  parent_account_id TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  UNIQUE (organization_id, entity_id, id),
  UNIQUE (organization_id, entity_id, code),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id),
  FOREIGN KEY (organization_id, entity_id, parent_account_id) REFERENCES accounts(organization_id, entity_id, id),
  CHECK (control_type IS NULL OR (control_type IN ('bank', 'receivable') AND account_type = 'asset') OR (control_type IN ('payable', 'unapplied') AND account_type = 'liability'))
);

CREATE INDEX IF NOT EXISTS accounts_active_idx ON accounts (organization_id, entity_id, active, code);

CREATE TABLE IF NOT EXISTS category_rules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  account_id TEXT NOT NULL,
  flow TEXT CHECK (flow IS NULL OR flow IN ('inflow', 'outflow')),
  priority INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id),
  FOREIGN KEY (organization_id, entity_id, account_id) REFERENCES accounts(organization_id, entity_id, id)
);

CREATE TABLE IF NOT EXISTS category_rule_keywords (
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  keyword TEXT NOT NULL,
  PRIMARY KEY (organization_id, entity_id, rule_id, position),
  FOREIGN KEY (organization_id, entity_id, rule_id) REFERENCES category_rules(organization_id, entity_id, id),
  CHECK (position >= 0)
);

CREATE INDEX IF NOT EXISTS category_rule_keywords_lookup_idx
  ON category_rule_keywords (organization_id, entity_id, rule_id, position);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  currency TEXT NOT NULL REFERENCES currencies(code),
  external_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  UNIQUE (organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id)
);

CREATE INDEX IF NOT EXISTS customers_name_idx ON customers (organization_id, entity_id, LOWER(name));

CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  company TEXT,
  currency TEXT REFERENCES currencies(code),
  tax_identifier TEXT,
  external_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ,
  UNIQUE (organization_id, entity_id, id),
  FOREIGN KEY (organization_id, entity_id) REFERENCES entities(organization_id, id)
);
