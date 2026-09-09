-- Existing requests stay CNAME; new requests may select any supported type.
ALTER TABLE subdomain_requests
  ADD COLUMN IF NOT EXISTS record_type TEXT NOT NULL DEFAULT 'CNAME',
  ADD COLUMN IF NOT EXISTS record_priority INTEGER;
