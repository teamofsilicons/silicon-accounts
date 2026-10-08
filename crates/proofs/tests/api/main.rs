//! Integration tests of every proofs endpoint, driven through `accounts_proofs::router()` with
//! `tower::ServiceExt::oneshot` (via `accounts_core::test_support`) on a throwaway Postgres
//! database per test.

mod common;

mod app_verification;
mod listings;
mod migration;
mod portal;
mod refresh;
mod revoke;
mod sign_in;
mod user_verification;
mod verify;
