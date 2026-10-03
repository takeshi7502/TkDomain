# Stability rollout — 2026-10-03

## Changes

- Remove runtime DDL/backfills. Check schema version once per process instead.
- Admin loads 50 rows in the selected tab, filters pending requests server-side,
  fetches DNS details on expansion and polls a summary every 30 seconds while visible.
- Limit authenticated DNS writes to 10/minute per owner, 30/minute per network,
  60/minute globally; default quota 50 records per primary subdomain, including its main record.
  Daily write budgets are 200 per owner and 1,000 globally to bound audit growth.
- Journal DNS operations before calling Cloudflare. Serialize mutations, replay
  operation IDs, reconcile uncertain provider outcomes and delete full domains in batches.
- Commit database records and audit events in the same transaction. A releasing
  name stays reserved until all records are removed; history is retained.
- Commit registration, notification jobs and the temporary status session together.
  Send mail/admin notifications after the response, retry with leases/backoff.
- Bound JSON bodies and validate runtime types; enforce exact-origin mutations,
  host-only secure production cookies, provider timeouts and bounded database pools.
- Telegram update claiming is atomic. Link + completed update share a transaction.
  Owner/token lock order is consistent; usernames can refresh via a verified private /start.
- Upgrade Next/React and remove an unused direct React server dependency.

## Before production

1. Obtain access to **the existing production Neon project**, not an empty replacement.
2. Create an isolated branch of production. Inject its direct URL as
   `DATABASE_URL_UNPOOLED` and run `npm run db:migrate` twice.
3. Check row counts, ownership, primary record uniqueness, existing key hashes,
   and old/new request flows on that branch. No real email/bot/DNS writes in tests.
4. Run tests, typecheck, lint and production build.
5. In Vercel Production, set `REGISTRY_AUTH_SECRET` to the **exact current**
   `REGISTRY_ADMIN_KEY`. Keep the auth secret stable permanently. Do not generate
   a replacement value for existing data. The code retains a legacy fallback
   until this is configured, so no keys are silently invalidated.
6. Configure a separate random `CRON_SECRET`. Daily `/api/maintenance` housekeeping
   removes bounded batches of expired temporary rows and resumes due jobs.
   Admin can also run “Kiểm tra đồng bộ”; only an authenticated admin can retry
   stalled DNS operations after the automatic retry limit.
7. Apply migration to production, then push/deploy. Avoid concurrent DNS changes
   during the short transition. Additive schema changes support the previous app
   if deployment must be rolled back. Do not delete journal/outbox data to roll back.
8. Verify admin pagination, refresh/session persistence, one real reviewed request,
   approval email and one normal DNS change. Existing sessions need a one-time login
   because of the protected cookie names; access keys are unchanged.

## Operational limits

- Daily cron is a safety net, not a minute-by-minute worker. Open admin tabs resume
  due notifications; owner panels resume pending DNS work after responding. No continuous
  keep-alive is added; Neon cold starts can still occur.
- DNS operations that repeatedly fail remain reserved/pending for admin review;
  the system never frees a name with an uncertain Cloudflare outcome.
- Email sends with an uncertain outcome beyond the provider idempotency window
  require a manual provider check instead of blind retries. Optional DNS Telegram
  notifications are best-effort; admin-registration notifications use the outbox
  but cannot promise exactly-once delivery across a provider/network crash.
- Registration contacts are unverified until linked through Telegram. Quotas
  reduce abuse, but are not proof of identity or a substitute for Cloudflare/Vercel
  edge DDoS protection. No user DNS content is fetched as a URL by this backend.
- Request and DNS history are retained, not auto-expired/deleted. Only temporary
  auth/verification/rate-limit data and old completed technical jobs are cleaned.
- `npm audit --omit=dev` is clean after upgrades. Full audit still reports
  development-tool transitive advisories (including braces with no patched 3.x
  release); no forced framework downgrade or untested major override is applied.

## Verified rollout

- All 20 local tests, TypeScript, ESLint and the production build pass.
- Opened the existing Vercel-managed resource `neon-aqua-sail`, project
  `lucky-flower-42229933`, through the authenticated Neon Console. No API key was
  created and no production connection variables were replaced.
- Created `stability-test-2026-10-03` (`br-raspy-band-azphm62k`) from the existing
  `main` branch (`br-sweet-voice-azsdycxn`). It auto-expires after one day.
- Ran migration twice on that branch, compared full existing registry/auth/DNS
  rows, and verified real concurrent DNS claims, idempotent replay, release
  blocking and 20 simultaneous rate-limit attempts. No real Cloudflare/email/bot
  API was called. Synthetic owner/domain fixtures were removed from the test branch.
- Applied schema version 9 to production and compared all existing managed
  domains, requests, owners, subdomains, DNS records/events and Telegram links.
  All remained identical: 32 requests, 19 subdomains and 25 DNS records.
- Added a random secret `CRON_SECRET` to Vercel Production for the daily task.
- `REGISTRY_AUTH_SECRET` is not yet separated because Vercel does not reveal the
  existing Secret. The compatibility fallback uses the unchanged admin key, so
  existing owner access keys still work. Before ever rotating the admin key,
  configure the auth secret with the exact previous admin-key value.

Deployment uses GitHub `main` → Vercel. After rollout, confirm public endpoints,
auth rejection/origin guards and deployment logs. Existing sessions need a
one-time login because of the protected cookie names. Real approval mail and
Cloudflare changes should be checked with the next genuine request; do not create
fake live requests or mutate a friend's records just to smoke-test.
