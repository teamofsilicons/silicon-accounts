# Verification names release

Accounts 0.2.0 uses `app-verification` and `user-verification` in issuance routes,
CLI commands and documentation URLs. JSON kinds use `app_verification` and
`user_verification`. SDK callers use `issue_app_verification` and
`issue_user_verification`. Upgrade clients with the API deployment.

Migration 0011 changes existing verification kinds and audit details in one
transaction. Family IDs, token hashes, grants, audiences, scopes, expiry times
and revocation state are preserved. It rebuilds the two partial indexes and
retains the subject constraint. Applied migrations are never rewritten.

Before listening, the API migrates unexpired encrypted retry responses with its
configured keyring. It preserves the original token, request hash, retry key and
expiry, and seals each response against its new route. This also handles cached
refresh responses, so retrying an already completed refresh does not consume its
token twice. A failure aborts that transaction and prevents API startup.

Deploy the API, account site and shared developer portal as one bundle after a
database backup. The installer checks migration and service readiness before
reporting success. Verify the two new issuance routes, both listing filters,
the per-app portal route, shared documentation and normal sign-in.

If rollback is required before traffic resumes, stop the services and restore
the matching predeployment database backup and previous release together.
Do not run the previous API against the renamed kinds. If new writes occurred,
preserve them and reconcile them before restoring; do not discard live data.
