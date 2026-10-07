//! Integration tests of the oauth crate's endpoints, driven through `accounts_oauth::router()`
//! with `tower::ServiceExt::oneshot` (via `accounts_core::test_support`) against a fresh
//! Postgres database per test (127.0.0.1:5444; start it with scripts/dev-db.sh).

mod code;
mod common;
mod developer;
mod device;
mod discovery;
mod introspect;
mod refresh;
mod revoke;
mod slt;
mod sweep;
mod token;
mod userinfo;
