//! Durable recovery of one refresh operation. All calls use the rotation's transaction.
//! Only ciphertext survives a lost reply; the request binding remains after it is retired.

use serde::{Deserialize, Serialize};
use sqlx::{PgConnection, PgPool};
use uuid::Uuid;

use super::tokens::{GrantError, TokenFamily};
use crate::{crypto, state::Keys, views::TokenResponse};

/// How long a lost refresh response can be recovered, while its successor is unused.
pub const REPLAY_SECONDS: i64 = 24 * 60 * 60;

pub(crate) struct Operation {
    app_id: String,
    key_hash: Vec<u8>,
    request_hash: Vec<u8>,
    saved: Option<Saved>,
}

#[derive(sqlx::FromRow)]
struct Saved {
    request_hash: Vec<u8>,
    family_id: Uuid,
    generation: i32,
    response: Option<Vec<u8>>,
    access_expires_at: i64,
    expired: bool,
}

// Authenticate the binding inside the ciphertext too: moving a database value
// to another row must never turn it into that caller's recovery response.
#[derive(Serialize, Deserialize)]
struct Envelope {
    app_id: String,
    key_hash: Vec<u8>,
    request_hash: Vec<u8>,
    family_id: Uuid,
    generation: i32,
    access_expires_at: i64,
    tokens: TokenResponse,
}

pub(crate) async fn begin(
    conn: &mut PgConnection,
    keys: &Keys,
    app_id: &str,
    key: &str,
    token_hash: &[u8],
    scope: Option<&str>,
) -> Result<Operation, GrantError> {
    let key_hash = keys.pepper.hash(key).to_vec();
    let request = serde_json::to_vec(&(token_hash, scope))
        .map_err(|_| GrantError::Internal("could not encode refresh binding".into()))?;
    let request_hash = crypto::sha256(&request).to_vec();
    let lock_material = serde_json::to_vec(&("refresh-recovery", app_id, &key_hash))
        .map_err(|_| GrantError::Internal("could not encode refresh lock".into()))?;
    let hash = crypto::sha256(&lock_material);
    let mut lock_bytes = [0; 8];
    lock_bytes.copy_from_slice(&hash[..8]);
    let locked: bool = sqlx::query_scalar("select pg_try_advisory_xact_lock($1)")
        .bind(i64::from_be_bytes(lock_bytes))
        .fetch_one(&mut *conn)
        .await?;
    if !locked {
        return Err(GrantError::RefreshConflict(
            "refresh_in_progress",
            "This refresh is still processing. Retry with the same token and Idempotency-Key.",
        ));
    }
    let saved: Option<Saved> = sqlx::query_as(
        "select request_hash, family_id, generation, response, access_expires_at, \
         expires_at <= clock_timestamp() as expired from refresh_recoveries where app_id=$1 and key_hash=$2",
    ).bind(app_id).bind(&key_hash).fetch_optional(conn).await?;
    if saved
        .as_ref()
        .is_some_and(|s| s.request_hash != request_hash)
    {
        return Err(GrantError::RefreshConflict(
            "idempotency_key_reused",
            "This key belongs to another refresh request. Use the saved key only with its original token and scope.",
        ));
    }
    Ok(Operation {
        app_id: app_id.into(),
        key_hash,
        request_hash,
        saved,
    })
}

impl Operation {
    /// Called only after checking current client, family, account and membership authority.
    pub(crate) async fn replay(
        &self,
        conn: &mut PgConnection,
        keys: &Keys,
        family: &TokenFamily,
        generation: i32,
    ) -> Result<Option<TokenResponse>, GrantError> {
        let Some(saved) = &self.saved else {
            return Ok(None);
        };
        let unavailable = || {
            GrantError::RefreshConflict(
                "refresh_result_unavailable",
                "The refresh completed, but its saved reply is no longer available. Re-read the shared session; do not retry this token with a new key.",
            )
        };
        if saved.family_id != family.id || saved.generation != generation || saved.expired {
            return Err(unavailable());
        }
        let successor_used: bool = sqlx::query_scalar(
            "select exists(select 1 from refresh_tokens where family_id=$1 and generation=$2 and used_at is not null)",
        ).bind(family.id).bind(generation + 1).fetch_one(&mut *conn).await?;
        if successor_used {
            return Err(GrantError::RefreshConflict(
                "refresh_superseded",
                "This session has already advanced beyond that refresh. Re-read the shared session before continuing.",
            ));
        }
        let bytes = saved.response.as_deref().ok_or_else(unavailable)?;
        let plain = keys.keyring.decrypt(bytes).map_err(|_| unavailable())?;
        let envelope: Envelope = serde_json::from_slice(&plain).map_err(|_| unavailable())?;
        if envelope.app_id != self.app_id
            || envelope.key_hash != self.key_hash
            || envelope.request_hash != self.request_hash
            || envelope.family_id != family.id
            || envelope.generation != generation
            || envelope.access_expires_at != saved.access_expires_at
        {
            return Err(unavailable());
        }
        let mut tokens = envelope.tokens;
        // Never restart the access-token lifetime when replaying yesterday's reply.
        tokens.expires_in =
            (saved.access_expires_at - time::OffsetDateTime::now_utc().unix_timestamp()).max(0);
        Ok(Some(tokens))
    }

    pub(crate) async fn save(
        &self,
        conn: &mut PgConnection,
        keys: &Keys,
        family: &TokenFamily,
        generation: i32,
        tokens: &TokenResponse,
    ) -> Result<(), GrantError> {
        let expires = tokens.access_token_expires_at.unix_timestamp();
        let envelope = Envelope {
            app_id: self.app_id.clone(),
            key_hash: self.key_hash.clone(),
            request_hash: self.request_hash.clone(),
            family_id: family.id,
            generation,
            access_expires_at: expires,
            tokens: tokens.clone(),
        };
        let plain = serde_json::to_vec(&envelope)
            .map_err(|_| GrantError::Internal("could not encode refresh recovery result".into()))?;
        let sealed = keys.keyring.encrypt(&plain).map_err(|_| {
            GrantError::Internal("could not encrypt refresh recovery result".into())
        })?;
        sqlx::query("insert into refresh_recoveries(app_id,key_hash,request_hash,family_id,generation,response,access_expires_at,expires_at) \
            values($1,$2,$3,$4,$5,$6,$7,least($8,clock_timestamp()+make_interval(secs=>$9)))")
            .bind(&self.app_id).bind(&self.key_hash).bind(&self.request_hash).bind(family.id)
            .bind(generation).bind(sealed).bind(expires).bind(family.expires_at).bind(REPLAY_SECONDS as f64)
            .execute(conn).await?;
        Ok(())
    }
}

/// Erases expired/revoked secret material in bounded batches; keeps retry bindings.
pub async fn purge(pool: &PgPool) -> Result<u64, sqlx::Error> {
    Ok(sqlx::query("update refresh_recoveries set response=null where (app_id,key_hash) in \
        (select r.app_id,r.key_hash from refresh_recoveries r join token_families f on f.id=r.family_id \
         where r.response is not null and (r.expires_at<=now() or f.revoked_at is not null or f.expires_at<=now()) limit 5000)")
        .execute(pool).await?.rows_affected())
}
