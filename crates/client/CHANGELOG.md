# Changelog

## 0.7.0

Adds the official Silicon Cells delegation APIs: current author and app checks,
link/unlink, sign-in exchange, session introspection and revocation, and the
generation-fenced custom-domain callback update. The callback API preserves the
permanent callback and webhook addresses and uses a stable idempotency key.

These methods require the matching Accounts server Cells bridge. Ordinary apps
cannot call the internal bridge. Existing public sign-in, verification, webhook
verification and anonymous bug-report APIs remain available.

Release preparation must run the client route tests, verify the packaged crate,
and test Cells against the exact archive checksum. Publishing this package and
deploying the matching Accounts server are separate operator actions.
