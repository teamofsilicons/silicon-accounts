//! Browser-local sign-ins. Each saved profile holds an independent HttpOnly session
//! credential. Account links are resolved live and are never created by this picker.
use axum::http::{HeaderMap, header::COOKIE};
use cookie::Cookie;
use serde_json::Value;
use sqlx::PgConnection;
use uuid::Uuid;

use super::ClientMeta;
use super::cookies::{self, SESSION_COOKIE, SESSION_MAX_AGE};
use crate::repo::{organizations, sessions};
use crate::{ApiError, ApiResult, AppState};

const PREFIX: &str = "sa_profile_";
const MAX_SAVED: usize = 12;

pub struct Profile {
    session: sessions::BrowserSession,
    token: String,
}

pub struct BrowserProfiles {
    active: Option<Profile>,
    saved: Vec<Profile>,
    stale: Vec<String>,
}

pub struct Selection {
    pub session_id: Uuid,
    pub cookies: Vec<Cookie<'static>>,
}

fn profile_cookie(state: &AppState, uuid: &str, token: String) -> Cookie<'static> {
    cookies::build_cookie(
        &state.settings,
        &format!("{PREFIX}{uuid}"),
        token,
        SESSION_MAX_AGE,
    )
}

impl BrowserProfiles {
    pub async fn load(
        conn: &mut PgConnection,
        state: &AppState,
        headers: &HeaderMap,
    ) -> ApiResult<Self> {
        let mut active = None;
        if let Some(token) = cookies::read_cookie(headers, &state.settings, SESSION_COOKIE)
            && let Some(session) = sessions::lookup(conn, &state.keys.pepper, &token).await?
        {
            active = Some(Profile { session, token });
        }
        let prefix = cookies::cookie_name(&state.settings, PREFIX);
        let mut saved = Vec::new();
        let mut stale = Vec::new();
        let candidates = headers
            .get_all(COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| Cookie::split_parse(v).flatten())
            .filter(|c| c.name().starts_with(&prefix))
            .take(64);
        for cookie in candidates {
            let token = cookie.value();
            if let Some(session) = sessions::lookup(conn, &state.keys.pepper, token).await?
                && cookie.name()[prefix.len()..] == session.account_uuid
                && !saved
                    .iter()
                    .any(|p: &Profile| p.session.account_uuid == session.account_uuid)
            {
                saved.push(Profile {
                    session,
                    token: token.to_owned(),
                });
            } else {
                let suffix = &cookie.name()[prefix.len()..];
                if !suffix.is_empty()
                    && suffix.len() <= 64
                    && suffix
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                {
                    stale.push(format!("{PREFIX}{suffix}"));
                }
            }
        }
        Ok(Self {
            active,
            saved,
            stale,
        })
    }

    /// If the active credential expired, resume another independently authenticated profile.
    pub fn resume(&self, state: &AppState) -> Option<(sessions::BrowserSession, Cookie<'static>)> {
        if self.active.is_some() {
            return None;
        }
        let next = self.saved.iter().max_by_key(|p| p.session.last_seen_at)?;
        Some((
            next.session.clone(),
            cookies::session_cookie(&state.settings, &next.token),
        ))
    }

    pub fn session_ids(&self) -> Vec<Uuid> {
        self.saved.iter().map(|p| p.session.id).collect()
    }

    fn clear_stale(&self, state: &AppState) -> Vec<Cookie<'static>> {
        self.stale
            .iter()
            .map(|name| cookies::clear_cookie(&state.settings, name))
            .collect()
    }

    pub fn accounts(&self) -> Vec<String> {
        self.saved
            .iter()
            .map(|p| p.session.account_uuid.clone())
            .collect()
    }

    /// Resolve the live proof behind a choice, including its currently linked work accounts.
    async fn proof(&self, conn: &mut PgConnection, uuid: &str) -> ApiResult<Option<&Profile>> {
        let profiles = self.active.iter().chain(&self.saved);
        if let Some(p) = profiles.clone().find(|p| p.session.account_uuid == uuid) {
            return Ok(Some(p));
        }
        for p in profiles {
            if organizations::linked(conn, uuid, &p.session.account_uuid).await? {
                return Ok(Some(p));
            }
        }
        Ok(None)
    }

    pub async fn select(
        &self,
        conn: &mut PgConnection,
        state: &AppState,
        meta: &ClientMeta,
        uuid: &str,
        fresh_proof: bool,
    ) -> ApiResult<Selection> {
        let proof = self.proof(conn, uuid).await?;
        if !fresh_proof && proof.is_none() {
            return Err(ApiError::forbidden(
                "account_not_linked",
                "Sign in to this account on this browser before choosing it.",
            ));
        }
        let mut changes = self.clear_stale(state);
        // Keep a pre-upgrade session the first time this browser changes accounts.
        let mut saved_ids = self.accounts();
        if let Some(old) = &self.active
            && old.session.account_uuid != uuid
        {
            let mut represented = false;
            for p in &self.saved {
                if organizations::linked(conn, &old.session.account_uuid, &p.session.account_uuid)
                    .await?
                {
                    represented = true;
                    break;
                }
            }
            if !represented {
                changes.push(profile_cookie(
                    state,
                    &old.session.account_uuid,
                    old.token.clone(),
                ));
                saved_ids.push(old.session.account_uuid.clone());
            } else if !self.saved.iter().any(|p| p.session.id == old.session.id) {
                sessions::revoke(conn, &old.session.account_uuid, old.session.id).await?;
            }
        }
        let (token, session) = match proof.filter(|p| p.session.account_uuid == uuid) {
            Some(p) => {
                if fresh_proof {
                    sessions::mark_authenticated(conn, p.session.id).await?;
                }
                (p.token.clone(), p.session.clone())
            }
            None => {
                let (token, session) = sessions::create(
                    conn,
                    &state.keys.pepper,
                    uuid,
                    meta.ip.as_deref(),
                    meta.user_agent.as_deref(),
                )
                .await?;
                if let Some(p) = proof.filter(|_| !fresh_proof) {
                    sqlx::query("update browser_sessions set authenticated_at=$2 where id=$1")
                        .bind(session.id)
                        .bind(p.session.authenticated_at)
                        .execute(&mut *conn)
                        .await?;
                }
                (token, session)
            }
        };
        if self
            .active
            .as_ref()
            .is_none_or(|p| p.session.id != session.id)
        {
            changes.push(cookies::session_cookie(&state.settings, &token));
        }
        if fresh_proof && !saved_ids.iter().any(|id| id == uuid) {
            if saved_ids.len() >= MAX_SAVED
                && let Some(oldest) = self.saved.iter().min_by_key(|p| p.session.last_seen_at)
            {
                changes.push(cookies::clear_cookie(
                    &state.settings,
                    &format!("{PREFIX}{}", oldest.session.account_uuid),
                ));
                sessions::revoke(conn, &oldest.session.account_uuid, oldest.session.id).await?;
            }
            changes.push(profile_cookie(state, uuid, token));
        }
        Ok(Selection {
            session_id: session.id,
            cookies: changes,
        })
    }

    /// End this personal/work group's sign-ins on this browser. Resume the most
    /// recently used remaining independent account, if the browser has one.
    pub async fn sign_out(
        &self,
        conn: &mut PgConnection,
        state: &AppState,
        uuid: &str,
    ) -> ApiResult<Vec<Cookie<'static>>> {
        let mut changes = self.clear_stale(state);
        let mut next: Option<&Profile> = None;
        for p in &self.saved {
            if organizations::linked(conn, uuid, &p.session.account_uuid).await? {
                sessions::revoke(conn, &p.session.account_uuid, p.session.id).await?;
                changes.push(cookies::clear_cookie(
                    &state.settings,
                    &format!("{PREFIX}{}", p.session.account_uuid),
                ));
            } else if next.is_none_or(|n| n.session.last_seen_at < p.session.last_seen_at) {
                next = Some(p);
            }
        }
        changes.push(match next {
            Some(p) => cookies::session_cookie(&state.settings, &p.token),
            None => cookies::clear_cookie(&state.settings, SESSION_COOKIE),
        });
        Ok(changes)
    }
}

pub async fn choices(
    conn: &mut PgConnection,
    current: &str,
    saved: &[String],
    app: Option<&str>,
) -> ApiResult<Vec<Value>> {
    let mut seen = std::collections::HashSet::new();
    let mut choices = Vec::new();
    for uuid in std::iter::once(current).chain(saved.iter().map(String::as_str)) {
        if seen.contains(uuid) {
            continue;
        }
        let group = organizations::linked_accounts(conn, uuid, app).await?;
        if let Some(items) = group["accounts"].as_array() {
            for item in items {
                if let Some(id) = item["uuid"].as_str()
                    && seen.insert(id.to_owned())
                {
                    choices.push(item.clone());
                }
            }
        }
    }
    Ok(choices)
}
