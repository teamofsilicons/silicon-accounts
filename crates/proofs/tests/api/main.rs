//! Integration tests of every proofs endpoint, driven through `accounts_proofs::router()` with
//! `tower::ServiceExt::oneshot` (via `accounts_core::test_support`) on a throwaway Postgres
//! database per test.

mod common;

mod ata;
mod listings;
mod obo;
mod portal;
mod refresh;
mod revoke;
mod sign_in;
mod verify;
