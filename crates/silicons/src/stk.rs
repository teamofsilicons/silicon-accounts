//! STK hashing and verification off the async runtime: Argon2id is deliberately slow and
//! memory-hard, so it runs on the blocking pool instead of stalling other requests.

use accounts_core::crypto::stk::{self, StkHasher};
use accounts_core::error::{ApiError, ApiResult};
use accounts_core::state::AppState;

/// A new STK ready to store: the plain value (returned to the caller only when generated) and
/// its Argon2id hash.
pub struct NewStk {
    pub plain: String,
    /// True when we generated it (show it exactly once); false when the caller chose it.
    pub generated: bool,
    pub hash: String,
}

impl std::fmt::Debug for NewStk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NewStk")
            .field("generated", &self.generated)
            .finish_non_exhaustive()
    }
}

impl NewStk {
    /// The STK for the response: `Some` only when generated (a chosen STK is never echoed).
    pub fn reveal(&self) -> Option<&str> {
        self.generated.then_some(self.plain.as_str())
    }
}

/// Hashes `chosen` (already normalized), or generates `stk-` + 12 hex and hashes that.
pub async fn prepare(state: &AppState, chosen: Option<String>) -> ApiResult<NewStk> {
    let (plain, generated) = match chosen {
        Some(s) => (s, false),
        None => (stk::generate(), true),
    };
    let hash = hash(state.keys.stk, plain.clone()).await?;
    Ok(NewStk {
        plain,
        generated,
        hash,
    })
}

/// Argon2id PHC string of `stk`.
pub async fn hash(hasher: StkHasher, stk: String) -> ApiResult<String> {
    tokio::task::spawn_blocking(move || hasher.hash(&stk))
        .await
        .map_err(|e| ApiError::internal(format!("STK hashing task failed: {e}")))?
        .map_err(ApiError::from)
}

/// True when `stk` matches the stored PHC string.
pub async fn verify(stk: String, phc: String) -> bool {
    tokio::task::spawn_blocking(move || StkHasher::verify(&stk, &phc))
        .await
        .unwrap_or(false)
}

/// Spends the same Argon2id work as a verification without checking anything, so a sign-in
/// with an unknown si:id takes as long as one with a wrong STK (no timing oracle for ids).
pub async fn burn(hasher: StkHasher) {
    let _ = hash(hasher, "stk-000000000000".to_string()).await;
}
