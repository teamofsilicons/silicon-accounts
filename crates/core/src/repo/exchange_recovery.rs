//! Atomic recovery of code and SLT exchanges after a dropped response.
use crate::repo::{accounts, organizations, tokens};
use crate::views::TokenResponse;
use crate::{AppState, OAuthError};
use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
use uuid::Uuid;

pub struct Operation {
    app: String,
    key: Vec<u8>,
    request: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
struct Envelope {
    app: String,
    key: Vec<u8>,
    request: Vec<u8>,
    family: Uuid,
    tokens: TokenResponse,
}
impl Operation {
    pub async fn begin(
        conn: &mut PgConnection,
        state: &AppState,
        app: &str,
        key: &str,
        request: &[u8],
    ) -> Result<(Self, Option<TokenResponse>), OAuthError> {
        let op = Self {
            app: app.into(),
            key: state.keys.pepper.hash(key).to_vec(),
            request: state
                .keys
                .pepper
                .hash(&String::from_utf8_lossy(request))
                .to_vec(),
        };
        let lock = crate::crypto::sha256(
            &serde_json::to_vec(&(&op.app, &op.key))
                .map_err(|_| OAuthError::server_error("Could not encode exchange key."))?,
        );
        let mut bytes = [0; 8];
        bytes.copy_from_slice(&lock[..8]);
        let locked: bool = sqlx::query_scalar("select pg_try_advisory_xact_lock($1)")
            .bind(i64::from_be_bytes(bytes))
            .fetch_one(&mut *conn)
            .await?;
        if !locked {
            return Err(conflict(
                "exchange_in_progress",
                "This exchange is processing. Retry the same grant and Idempotency-Key.",
            ));
        }
        let saved:Option<(Vec<u8>,Uuid,Vec<u8>,bool)>=sqlx::query_as("select request_hash,family_id,response,expires_at<=now() from grant_exchange_recoveries where app_id=$1 and key_hash=$2").bind(app).bind(&op.key).fetch_optional(&mut *conn).await?;
        let Some((request_hash, family, sealed, expired)) = saved else {
            return Ok((op, None));
        };
        if request_hash != op.request {
            return Err(conflict(
                "idempotency_key_reused",
                "This exchange key belongs to different grant credentials, redirect URI or PKCE proof.",
            ));
        }
        if expired {
            return Err(conflict(
                "exchange_result_unavailable",
                "The exchange result expired. Start a fresh sign-in.",
            ));
        }
        let live:bool=sqlx::query_scalar("select exists(select 1 from token_families f join accounts a on a.uuid=f.account_uuid where f.id=$1 and f.app_id=$2 and f.revoked_at is null and f.expires_at>now() and a.status='active')").bind(family).bind(app).fetch_one(&mut *conn).await?;
        if !live {
            return Err(conflict(
                "exchange_session_ended",
                "The recovered session was revoked, expired or deleted. Sign in again.",
            ));
        }
        let advanced:bool=sqlx::query_scalar("select exists(select 1 from refresh_tokens where family_id=$1 and used_at is not null)").bind(family).fetch_one(&mut *conn).await?;
        if advanced {
            return Err(conflict(
                "exchange_superseded",
                "This session has already refreshed. Read the stored successor session.",
            ));
        }
        let plain = state
            .keys
            .keyring
            .decrypt(&sealed)
            .map_err(|_| OAuthError::server_error("Could not decrypt exchange receipt."))?;
        let mut envelope: Envelope = serde_json::from_slice(&plain)
            .map_err(|_| OAuthError::server_error("Invalid exchange receipt."))?;
        if envelope.app != op.app
            || envelope.key != op.key
            || envelope.request != op.request
            || envelope.family != family
        {
            return Err(OAuthError::server_error(
                "Exchange receipt binding mismatch.",
            ));
        }
        let claims = state
            .keys
            .jwt
            .verify_access_ignoring_expiry(&envelope.tokens.access_token)
            .map_err(|_| OAuthError::server_error("Invalid saved exchange token."))?;
        let account = accounts::require(conn, &claims.sub).await?;
        organizations::check(conn, &account.uuid, app).await?;
        if !crate::is_first_party_app_id(app) {
            let active:bool=sqlx::query_scalar("select exists(select 1 from memberships where account_uuid=$1 and app_id=$2 and status='active')").bind(&account.uuid).bind(app).fetch_one(&mut *conn).await?;
            if !active {
                return Err(conflict(
                    "exchange_session_ended",
                    "This app no longer has account access.",
                ));
            }
        }
        envelope.tokens.expires_in = (envelope.tokens.access_token_expires_at.unix_timestamp()
            - time::OffsetDateTime::now_utc().unix_timestamp())
        .max(0);
        Ok((op, Some(envelope.tokens)))
    }
    pub async fn save(
        self,
        conn: &mut PgConnection,
        state: &AppState,
        response: &TokenResponse,
    ) -> Result<(), OAuthError> {
        let verified =
            tokens::verify_access_token(conn, &state.keys, &response.access_token, Some(&self.app))
                .await?;
        let envelope = Envelope {
            app: self.app.clone(),
            key: self.key.clone(),
            request: self.request.clone(),
            family: verified.family.id,
            tokens: response.clone(),
        };
        let sealed = state
            .keys
            .keyring
            .encrypt(
                &serde_json::to_vec(&envelope)
                    .map_err(|_| OAuthError::server_error("Could not encode exchange receipt."))?,
            )
            .map_err(|_| OAuthError::server_error("Could not encrypt exchange receipt."))?;
        sqlx::query("insert into grant_exchange_recoveries(app_id,key_hash,request_hash,family_id,response,expires_at) values($1,$2,$3,$4,$5,least($6,now()+interval '7 days'))").bind(self.app).bind(self.key).bind(self.request).bind(verified.family.id).bind(sealed).bind(verified.family.expires_at).execute(conn).await?;
        Ok(())
    }
}
fn conflict(code: &'static str, message: &'static str) -> OAuthError {
    OAuthError::new(axum::http::StatusCode::CONFLICT, code, message)
}
