CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  requested_role TEXT NOT NULL DEFAULT 'accountant' CHECK (requested_role IN ('accountant', 'viewer')),
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS access_requests_pending_email_uq
  ON access_requests (LOWER(email))
  WHERE status = 'pending';

ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS access_requests_insert_policy ON access_requests;
CREATE POLICY access_requests_insert_policy ON access_requests
  FOR INSERT WITH CHECK (TRUE);
