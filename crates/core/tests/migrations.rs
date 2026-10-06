//! Migrations: idempotent, reported, and they create the first-party app.

use accounts_core::models::{AppSource, AppStatus, Method};
use accounts_core::repo::apps;
use accounts_core::test_support::TestContext;

#[tokio::test]
async fn migrations_are_idempotent_and_seed_the_first_party_app() {
    let ctx = TestContext::new().await;
    let again = accounts_core::db::migrate(&ctx.state.db)
        .await
        .expect("re-run");
    assert!(again.applied_now.is_empty(), "nothing new to apply");
    assert!(
        again
            .already_applied
            .iter()
            .any(|m| m.version == 1 && m.description == "init")
    );

    let mut conn = ctx.conn().await;
    let app = apps::get(&mut conn, "accounts")
        .await
        .expect("q")
        .expect("first-party app");
    assert_eq!(app.source, AppSource::FirstParty);
    assert_eq!(app.status, AppStatus::Active);
    let config = apps::effective_config(&mut conn, &ctx.state.settings, "accounts")
        .await
        .expect("config");
    assert_eq!(
        config.available_methods(&ctx.state.settings),
        vec![Method::Email, Method::Phone]
    );
    assert!(config.redirect_allowed(
        &ctx.state.settings,
        "accounts",
        "http://localhost:8590/apps"
    ));
    assert!(!config.redirect_allowed(&ctx.state.settings, "accounts", "https://evil.test/"));
    accounts_core::db::ping(&ctx.state.db).await.expect("ping");
}
