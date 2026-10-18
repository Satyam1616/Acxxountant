CREATE TABLE IF NOT EXISTS ledgerflow_state (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ledgerflow_state_updated_at_idx
  ON ledgerflow_state (updated_at);
