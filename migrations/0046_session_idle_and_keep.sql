-- Signed-in devices that nobody uses (Anil, 2026-11-26). A browser session now ends after 60 days
-- without use, within its 900-day limit: every use moves expires_at to 60 days ahead (sessions::touch).
-- Live sessions already quiet for longer end now.
--
-- kept_at: when the Carbon answered "Keep" to Home's "Still using …?" for this sign-in, so the
-- question isn't asked again on any browser until the sign-in is used and goes quiet again.
alter table browser_sessions add column kept_at timestamptz;
alter table token_families add column kept_at timestamptz;

update browser_sessions
   set expires_at = least(expires_at, last_seen_at + interval '60 days')
 where revoked_at is null and expires_at > now();
