//! End to end over real HTTP with the published Rust package (`silicon-accounts-client`), the
//! way the `accounts` CLI talks to the service: a Silicon creates its own account and waits;
//! its custodian accepts; the Silicon signs in, gets an SLT and manages its webhook; the
//! custodian manages the Silicon. Every response must parse into the client's types.

use std::net::SocketAddr;
use std::time::Duration;

use accounts_core::AppState;
use accounts_core::test_support::TestContext;
use silicon_accounts_client::{
    AccountKind, AccountsClient, CreateSilicon, SiliconSelfCreate, UpdateSilicon, WaitEvent,
    WaitOptions,
};

use crate::common::*;

async fn serve(state: AppState) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let app = accounts_silicons::router().with_state(state);
    let handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("serve");
    });
    (format!("http://{addr}"), handle)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_silicon_journey_through_the_rust_client() {
    let ctx = TestContext::new().await;
    let saket = ctx.carbon().await;
    let newcomer = ctx.carbon().await;
    let (remind, _) = ctx.app("remind").await;
    let (base, server) = serve(ctx.state.clone()).await;
    let client = AccountsClient::new(base.clone()).expect("client");

    // 1. The Silicon creates its own account (an idempotent retry returns the same result).
    let wanted = silicon_id("journey");
    let request = SiliconSelfCreate {
        id: wanted.clone(),
        display_name: "Journey".into(),
        custodian: saket.handle.clone().expect("id"),
        webhook_url: Some("http://127.0.0.1:8593/hooks/journey".into()),
        ..Default::default()
    };
    let created = client
        .silicon_self_create(&request, Some("journey-1"))
        .await
        .expect("self-create");
    assert_eq!(created.silicon.status, "pending_custodian");
    assert_eq!(created.silicon.id, wanted);
    assert_eq!(created.silicon.kind, AccountKind::Silicon);
    assert_eq!(created.request.status, "pending");
    assert_eq!(created.request.custodian, saket.handle.clone().expect("id"));
    assert!(created.request.expires_at.is_some());
    assert_eq!(created.request_token.prefix(), Some("sarq_"));
    assert_eq!(created.stk.as_ref().and_then(|s| s.prefix()), Some("stk-"));
    assert_eq!(
        created.webhook_secret.as_ref().and_then(|s| s.prefix()),
        Some("whsec_")
    );
    let replay = client
        .silicon_self_create(&request, Some("journey-1"))
        .await
        .expect("replay");
    assert_eq!(replay.request.id, created.request.id);
    let stk = created.stk.clone().expect("stk").into_inner();

    // 2. It can't sign in yet, and says why.
    let err = client
        .silicon_login(&wanted, &stk, None)
        .await
        .expect_err("pending");
    assert_eq!(err.code(), "custodian_pending");
    assert_eq!(err.status(), Some(403));

    // 3. It waits (like `accounts silicon create --wait`) while the custodian accepts.
    let waiter_client = client.clone();
    let request_id = created.request.id.clone();
    let request_token = created.request_token.expose().to_string();
    let waiter = tokio::spawn(async move {
        let mut polls = 0;
        let status = waiter_client
            .wait_for_custodian_decision(
                &request_id,
                &request_token,
                &WaitOptions::fixed(Duration::from_millis(50))
                    .with_timeout(Some(Duration::from_secs(20))),
                |event| {
                    if let WaitEvent::Polled(_) = event {
                        polls += 1;
                    }
                },
            )
            .await
            .expect("decision");
        (status, polls)
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    let carbon_token = token(&ctx, &saket).await;
    let custodian = client.with_token(&carbon_token);
    let waiting = custodian.custodian_requests().await.expect("requests");
    assert_eq!(waiting.len(), 1);
    assert_eq!(waiting[0].id, created.request.id);
    assert_eq!(waiting[0].kind, "initial");
    assert_eq!(
        waiting[0].silicon.as_ref().map(|s| s.uuid.clone()),
        Some(created.silicon.uuid.clone())
    );
    custodian
        .accept_custodian_request(&created.request.id)
        .await
        .expect("accept");
    let (status, polls) = waiter.await.expect("waiter");
    assert!(status.is_accepted(), "{status:?}");
    assert_eq!(status.silicon.status, "active");
    assert!(polls >= 2, "it polled while pending ({polls})");

    // 4. The Silicon signs in, gets an SLT for an app and manages its own webhook.
    let tokens = client
        .silicon_login(&wanted, &stk, Some("journey test"))
        .await
        .expect("login");
    let account = tokens.account.clone().expect("account");
    assert_eq!(account.kind, AccountKind::Silicon);
    assert_eq!(
        tokens.membership_id.as_deref(),
        Some(format!("accounts:{}", created.silicon.uuid).as_str())
    );
    let silicon = client.with_token(tokens.access_token.expose());
    let slt = silicon
        .short_lived_token(&remind.app_id)
        .await
        .expect("slt");
    assert_eq!(slt.app_id, remind.app_id);
    assert_eq!(slt.slt.prefix(), Some("slt_"));
    let hook = silicon
        .set_my_webhook("http://127.0.0.1:8593/hooks/journey-2")
        .await
        .expect("set webhook");
    assert_eq!(hook.webhook_url, "http://127.0.0.1:8593/hooks/journey-2");
    assert!(hook.webhook_secret.is_some());
    let ping = silicon.test_my_webhook().await.expect("ping");
    assert!(ping.event_id.is_some());
    silicon.remove_my_webhook().await.expect("remove webhook");
    let wrong = client
        .silicon_login(&wanted, "stk-000000000000", None)
        .await
        .expect_err("wrong stk");
    assert_eq!(wrong.code(), "invalid_credentials");

    // 5. The custodian manages it.
    let mine = custodian.silicons().await.expect("list");
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].silicon.uuid, created.silicon.uuid);
    assert!(mine[0].pending_transfer.is_none());
    let uuid = created.silicon.uuid.clone();
    let shown = custodian.get_silicon(&uuid).await.expect("show");
    assert_eq!(shown.silicon.id, wanted);
    let updated = custodian
        .update_silicon(
            &uuid,
            &UpdateSilicon {
                display_name: Some("Journey Two".into()),
                ..Default::default()
            },
        )
        .await
        .expect("update");
    assert_eq!(updated.display_name, "Journey Two");
    let renamed_to = silicon_id("journey-renamed");
    let renamed = custodian
        .change_silicon_id(&uuid, &renamed_to)
        .await
        .expect("id");
    assert_eq!(renamed.id, renamed_to);
    let rotated = custodian.rotate_stk(&uuid, None).await.expect("rotate");
    let new_stk = rotated.stk.expect("generated").into_inner();
    assert!(rotated.rotated_at.is_some());
    client
        .silicon_login(&renamed_to, &new_stk, None)
        .await
        .expect("login with the new STK");
    let set = custodian
        .set_silicon_webhook(&uuid, "http://127.0.0.1:8593/hooks/by-custodian")
        .await
        .expect("custodian webhook");
    assert!(set.webhook_secret.is_some());
    custodian
        .remove_silicon_webhook(&uuid)
        .await
        .expect("remove custodian webhook");
    let transfer = custodian
        .transfer_silicon(&uuid, newcomer.handle.as_deref().expect("id"))
        .await
        .expect("transfer");
    assert_eq!(transfer.kind, "transfer");
    assert_eq!(transfer.status, "pending");
    let listed = custodian.silicons().await.expect("list");
    assert!(listed[0].pending_transfer.is_some());
    custodian.cancel_transfer(&uuid).await.expect("cancel");

    // 6. A Carbon-created Silicon, then deleting it.
    let made = custodian
        .create_silicon(
            &CreateSilicon {
                id: silicon_id("made"),
                display_name: "Made".into(),
                ..Default::default()
            },
            Some("made-1"),
        )
        .await
        .expect("create");
    assert_eq!(made.silicon.status, "active");
    assert!(made.stk.is_some());
    custodian
        .delete_silicon(&made.silicon.uuid, &made.silicon.id)
        .await
        .expect("delete");
    let after = custodian.silicons().await.expect("list");
    assert_eq!(after.len(), 1);

    server.abort();
}
