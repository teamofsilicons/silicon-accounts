//! Integration tests of `accounts_silicons`: every endpoint through the crate's router on a fresh
//! Postgres database (core's `test-support`), plus one end-to-end run over real HTTP with the
//! published Rust client.

mod common;

mod client_e2e;
mod custodian;
mod custodian_requests;
mod login;
mod own_webhook;
mod races;
mod request_status;
mod self_create;
mod slt;
mod sweep;
mod transfer;
