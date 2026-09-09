-- Delivery receipt for the email sent immediately after a request is stored.
ALTER TABLE subdomain_requests
  ADD COLUMN IF NOT EXISTS request_email_sent_at BIGINT,
  ADD COLUMN IF NOT EXISTS request_email_attempted_at BIGINT,
  ADD COLUMN IF NOT EXISTS request_email_error TEXT;
