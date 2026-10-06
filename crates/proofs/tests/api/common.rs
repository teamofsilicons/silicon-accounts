//! Shared fixtures: a fresh database with a Carbon signed into `dm` (the issuing app), plus
//! `briefcase` (the receiving app) and an unrelated app.
#![allow(dead_code)]

use accounts_core::jwt::AccessTokenInput;
use accounts_core::models::{Account, App, Scope};
use accounts_core::test_support::{Req, Resp, TestContext};
use serde_json::{Value, json};
use uuid::Uuid;

/// Exactly the contract's invalid answer.
pub fn invalid() -> Value {
    json!({"valid": false, "expires_at": null})
}

pub struct World {
    pub ctx: TestContext,
    pub carbon: Account,
    /// Issuing app.
    pub dm: App,
    pub dm_secret: String,
    /// Receiving app.
    pub briefcase: App,
    pub briefcase_secret: String,
    /// An unrelated app.
    pub other: App,
    pub other_secret: String,
    /// The Carbon's access token at dm (the OBO subject token).
    pub subject_token: String,
    pub subject_refresh: String,
}

impl World {
    pub async fn new() -> World {
        let ctx = TestContext::new().await;
        let carbon = ctx.carbon().await;
        let (dm, dm_secret) = ctx.app("dm").await;
        let (briefcase, briefcase_secret) = ctx.app("briefcase").await;
        let (other, other_secret) = ctx.app("other").await;
        ctx.membership(&dm.app_id, &carbon.uuid, &[Scope::Profile, Scope::Email])
            .await;
        let tokens = ctx
            .tokens_for(&carbon, &dm.app_id, &[Scope::Profile, Scope::Email])
            .await;
        World {
            ctx,
            carbon,
            dm,
            dm_secret,
            briefcase,
            briefcase_secret,
            other,
            other_secret,
            subject_token: tokens.access_token,
            subject_refresh: tokens.refresh_token,
        }
    }

    pub async fn call(&self, req: Req) -> Resp {
        self.ctx.call(accounts_proofs::router(), req).await
    }

    /// `POST /v1/proofs/obo` as dm.
    pub async fn obo(&self, body: Value) -> Resp {
        self.call(
            Req::post("/v1/proofs/obo")
                .basic(&self.dm.app_id, &self.dm_secret)
                .json(body),
        )
        .await
    }

    /// The standard OBO body: the Carbon's dm token → briefcase, scope files.write.
    pub fn obo_body(&self) -> Value {
        json!({
            "subject_token": self.subject_token,
            "receiving_app": self.briefcase.app_id,
            "scopes": ["files.write"],
        })
    }

    /// Issues the standard OBO proof (asserting 201) and returns the response body.
    pub async fn issue_obo(&self) -> Value {
        let r = self.obo(self.obo_body()).await;
        assert_eq!(r.status, 201, "{}", r.json);
        r.json
    }

    /// Issues an OBO proof with a given token lifetime.
    pub async fn issue_obo_ttl(&self, ttl: i64) -> Value {
        let mut body = self.obo_body();
        body["access_ttl_seconds"] = json!(ttl);
        let r = self.obo(body).await;
        assert_eq!(r.status, 201, "{}", r.json);
        r.json
    }

    /// `POST /v1/proofs/ata` as `app`.
    pub async fn ata_as(&self, app: &App, secret: &str, body: Value) -> Resp {
        self.call(
            Req::post("/v1/proofs/ata")
                .basic(&app.app_id, secret)
                .json(body),
        )
        .await
    }

    /// `POST /v1/proofs/verify` as `app`.
    pub async fn verify_as(&self, app: &App, secret: &str, token: &str) -> Resp {
        self.call(
            Req::post("/v1/proofs/verify")
                .basic(&app.app_id, secret)
                .json(json!({"proof_token": token})),
        )
        .await
    }

    /// Verifies as briefcase and returns the body (asserting 200).
    pub async fn verify_bc(&self, token: &str) -> Value {
        let r = self
            .verify_as(&self.briefcase, &self.briefcase_secret, token)
            .await;
        assert_eq!(r.status, 200, "{}", r.json);
        r.json
    }

    /// `POST /v1/proofs/refresh` as dm.
    pub async fn refresh(&self, refresh_token: &str) -> Resp {
        self.call(
            Req::post("/v1/proofs/refresh")
                .basic(&self.dm.app_id, &self.dm_secret)
                .json(json!({"proof_refresh_token": refresh_token})),
        )
        .await
    }

    /// `POST /v1/proofs/revoke` as `app`.
    pub async fn revoke_as(&self, app: &App, secret: &str, body: Value) -> Resp {
        self.call(
            Req::post("/v1/proofs/revoke")
                .basic(&app.app_id, secret)
                .json(body),
        )
        .await
    }

    /// The token family id behind the subject token.
    pub fn subject_family(&self) -> Uuid {
        let claims = self
            .ctx
            .state
            .keys
            .jwt
            .verify_access(&self.subject_token, None)
            .expect("subject token");
        claims.family_id().expect("fid")
    }

    /// An access token for `account` at `app_id` signed with our key whose `exp` is already
    /// past (beyond the 30 s leeway), on the same family as `family_id`.
    pub fn expired_token(&self, account: &Account, app_id: &str, family_id: Uuid) -> String {
        self.ctx
            .state
            .keys
            .jwt
            .sign_access(&AccessTokenInput {
                account_uuid: &account.uuid,
                app_id,
                kind: account.kind,
                id: account.id(),
                family_id,
                scope: "profile",
                ttl_seconds: -300,
            })
            .expect("sign")
            .0
    }

    /// A count from SQL.
    pub async fn count(&self, sql: &str) -> i64 {
        let mut conn = self.ctx.conn().await;
        sqlx::query_scalar::<_, i64>(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(&mut *conn)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"))
    }

    /// One text value from SQL.
    pub async fn text(&self, sql: &str) -> Option<String> {
        let mut conn = self.ctx.conn().await;
        sqlx::query_scalar::<_, Option<String>>(sqlx::AssertSqlSafe(sql.to_string()))
            .fetch_one(&mut *conn)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"))
    }
}

/// `proof_id` of an issue/refresh body.
pub fn proof_id(v: &Value) -> String {
    v["proof_id"].as_str().expect("proof_id").to_string()
}

/// Whole seconds from now until a timestamp field of a body (e.g. `expires_at`).
pub fn secs_until(v: &Value, field: &str) -> i64 {
    let at = accounts_core::timefmt::parse_rfc3339(v[field].as_str().expect(field)).expect(field);
    (at - time::OffsetDateTime::now_utc()).whole_seconds()
}

/// Asserts a proof token issued just now lives `ttl` seconds (a few seconds of test time
/// allowed).
pub fn assert_token_ttl(v: &Value, ttl: i64) {
    let left = secs_until(v, "expires_at");
    assert!(
        (ttl - 10..=ttl).contains(&left),
        "proof token should live {ttl} s, {left} s left: {v}"
    );
}

/// Parses an RFC 3339 timestamp.
pub fn ts(s: &str) -> time::OffsetDateTime {
    accounts_core::timefmt::parse_rfc3339(s).expect("rfc3339")
}

/// A timestamp column, formatted the way the API formats timestamps (RFC 3339 UTC, milliseconds).
pub async fn api_time(w: &World, sql: &str) -> Option<String> {
    let mut conn = w.ctx.conn().await;
    let at: Option<time::OffsetDateTime> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_string()))
        .fetch_one(&mut *conn)
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    at.map(accounts_core::timefmt::format_rfc3339_ms)
}

pub fn token(v: &Value) -> String {
    v["proof_token"].as_str().expect("proof_token").to_string()
}

pub fn refresh_token(v: &Value) -> String {
    v["proof_refresh_token"]
        .as_str()
        .expect("proof_refresh_token")
        .to_string()
}
