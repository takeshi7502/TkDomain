-- Nullable recipient keeps old requests and existing access-key identity intact.
ALTER TABLE subdomain_requests
  ADD COLUMN IF NOT EXISTS notification_email TEXT,
  ADD COLUMN IF NOT EXISTS notification_language TEXT NOT NULL DEFAULT 'vi',
  ADD COLUMN IF NOT EXISTS approval_email_sent_at BIGINT,
  ADD COLUMN IF NOT EXISTS approval_email_first_attempt_at BIGINT,
  ADD COLUMN IF NOT EXISTS approval_email_attempted_at BIGINT,
  ADD COLUMN IF NOT EXISTS approval_email_error TEXT;
