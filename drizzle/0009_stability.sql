CREATE INDEX IF NOT EXISTS idx_subdomain_requests_created_id ON subdomain_requests(created_at, id);
CREATE INDEX IF NOT EXISTS idx_dns_events_created_id ON dns_events(created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dns_records_one_primary ON dns_records(subdomain_id) WHERE is_primary = TRUE;
CREATE INDEX IF NOT EXISTS idx_owner_sessions_expiry ON owner_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_pending_sessions_expiry ON pending_request_sessions(expires_at);
CREATE TABLE IF NOT EXISTS dns_operations (
  id TEXT PRIMARY KEY, subdomain_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', payload JSONB NOT NULL,
  result JSONB, lease_token TEXT, lease_until BIGINT NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dns_operations_pending_domain ON dns_operations(subdomain_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_dns_operations_retry ON dns_operations(status, lease_until);
CREATE TABLE IF NOT EXISTS notification_jobs (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES subdomain_requests(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at BIGINT NOT NULL, lease_token TEXT, lease_until BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_jobs_identity ON notification_jobs(request_id, kind);
CREATE INDEX IF NOT EXISTS idx_notification_jobs_retry ON notification_jobs(status, next_attempt_at);
ALTER TABLE telegram_webhook_updates ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'done';
ALTER TABLE telegram_webhook_updates ADD COLUMN IF NOT EXISTS lease_token TEXT;
ALTER TABLE telegram_webhook_updates ADD COLUMN IF NOT EXISTS lease_until BIGINT NOT NULL DEFAULT 0;
