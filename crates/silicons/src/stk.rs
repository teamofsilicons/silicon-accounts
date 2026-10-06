//! A new STK for a Silicon: generated (`stk-` + 12 hex) or chosen, hashed with Argon2id on the
//! blocking pool (core's `StkHasher::hash_async`) instead of stalling other requests.

use accounts_core::crypto::stk;
use accounts_core::error::ApiResult;
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
    let hash = state.keys.stk.hash_async(plain.clone()).await?;
    Ok(NewStk {
        plain,
        generated,
        hash,
    })
}
