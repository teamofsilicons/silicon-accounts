-- Silicon Accounts — hardening after the phase-2 reviews.
--
-- 0001 is applied and never edited; everything below builds on it.

-- 1. Unverified emails and phones --------------------------------------------------------------
-- UNDERSTANDING.md: "Every email and phone number is verified before it's added". The only
-- unverified rows are the addresses an app import attached to an account nobody has finished
-- yet (status 'unclaimed'); proving one of them is how its Carbon finishes the account, and
-- finishing it removes the import's other addresses (core: repo::accounts::finish_claim).
-- Rows left unverified on any other account by claims made before that rule identify nobody,
-- so they are removed here; core keeps the rule from now on. Where a removed row was the
-- primary, the oldest remaining address of that kind becomes the primary ("one of them is
-- always the primary"). This is a one-time cleanup of development data (no webhooks are sent).
update account_emails e set is_primary = false
  from accounts a
 where a.uuid = e.account_uuid and a.status <> 'unclaimed' and e.verified_at is null and e.is_primary;
delete from account_emails e using accounts a
 where a.uuid = e.account_uuid and a.status <> 'unclaimed' and e.verified_at is null;
update account_emails e set is_primary = true
 where e.email in (
   select distinct on (x.account_uuid) x.email from account_emails x
    where not exists (select 1 from account_emails y where y.account_uuid = x.account_uuid and y.is_primary)
    order by x.account_uuid, x.created_at, x.email);

update account_phones p set is_primary = false
  from accounts a
 where a.uuid = p.account_uuid and a.status <> 'unclaimed' and p.verified_at is null and p.is_primary;
delete from account_phones p using accounts a
 where a.uuid = p.account_uuid and a.status <> 'unclaimed' and p.verified_at is null;
update account_phones p set is_primary = true
 where p.phone in (
   select distinct on (x.account_uuid) x.phone from account_phones x
    where not exists (select 1 from account_phones y where y.account_uuid = x.account_uuid and y.is_primary)
    order by x.account_uuid, x.created_at, x.phone);

-- 2. When the Carbon actually authenticated (OIDC auth_time) -----------------------------------
-- A browser session is reused when the same Carbon signs in again in that browser, so its
-- created_at goes stale: authenticated_at moves on every proof of identity (a code, Google,
-- Apple, a finished sign-up). An authorization code carries the authenticated_at of the session
-- that completed its flow (continue-as and prompt=none reuse the session's last one), and the
-- token family issued from it keeps it for its id_tokens, also after refreshes.
alter table browser_sessions add column authenticated_at timestamptz;
update browser_sessions set authenticated_at = created_at where authenticated_at is null;
alter table browser_sessions
    alter column authenticated_at set default now(),
    alter column authenticated_at set not null;
alter table authorization_codes add column auth_time timestamptz;
alter table token_families add column auth_time timestamptz;   -- null = created_at

-- 3. Webhook replays ----------------------------------------------------------------------------
-- A replayed delivery gets a fresh 72 h of retries counted from the replay itself.
alter table webhook_deliveries add column requeued_at timestamptz;

-- 4. Indexes ------------------------------------------------------------------------------------
-- Proof listings read the newest token of each proof (token_expires_at) with one index probe;
-- the leading family_id also serves the cascade from proof_families, so it replaces the plain
-- family_id index.
create index proof_tokens_family_kind_exp_idx on proof_tokens (family_id, kind, expires_at desc);
drop index proof_tokens_family_idx;
-- The hourly proofs sweep deletes long-expired access tokens.
create index proof_tokens_access_expires_idx on proof_tokens (expires_at) where kind = 'access';
-- The proofs sweep finds OBO proofs whose sign-in was revoked.
create index proof_families_unrevoked_obo_idx on proof_families (subject_family_id)
    where kind = 'obo' and revoked_at is null;
-- App proof listings page by (created_at, id); the old index lacked the tie-breaker.
create index proof_families_issuer_page_idx on proof_families (issuing_app, created_at desc, id desc);
drop index proof_families_issuer_idx;
-- Photo pruning: an account's uploads, and whether any account still shows one. pfp_url is only
-- ever compared for equality, and a hash index has no length limit on the URL.
create index photos_account_idx on photos (account_uuid);
create index accounts_pfp_url_idx on accounts using hash (pfp_url);
-- Per-delivery attempt listings and the cascade from webhook_deliveries.
create index webhook_attempts_delivery_idx on webhook_attempts (delivery_id, id);
