-- A short-lived token minted by a sign-in from a trusted outside token (a CI job, see
-- 0017_federation_and_identity_tokens.sql) carries that sign-in's end and its trust, so the app
-- sign-in it starts can't outlive either: the app's token family expires no later than
-- family_expires_cap, and the exchange links that family to the trust in
-- silicon_federation_sessions, so removing the trust ends it too. Both are null for every other
-- short-lived token.
--
-- Nothing before this migration recorded which sign-in minted a short-lived token, so app
-- sign-ins already made from tokens a CI sign-in minted (possible since 0017) can't be found and
-- aren't backfilled: they keep their 900-day families with no silicon_federation_sessions link,
-- and removing the trust doesn't end them. Removing the Silicon's access to the app, rotating its
-- STK or the app revoking them does (docs/start/ci-and-cloud.md says so).
alter table short_lived_tokens add column family_expires_cap timestamptz;
alter table short_lived_tokens add column federation_id uuid;
alter table short_lived_tokens add constraint short_lived_tokens_federation_check
    check ((federation_id is null) = (family_expires_cap is null));
