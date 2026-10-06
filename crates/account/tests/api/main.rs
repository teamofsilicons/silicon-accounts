//! Integration tests for the account router (`accounts_account::router()`), each against a fresh
//! migrated database (Postgres on 127.0.0.1:5444, see `scripts/dev-db.sh`).

mod common;

mod apps;
mod contacts;
mod deletion;
mod history;
mod id_change;
mod identities;
mod lookup;
mod me;
mod photos;
mod sessions;
