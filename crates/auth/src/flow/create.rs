//! `POST /v1/flows`: the SPA at `/authorize` turns the app's authorize request into a flow.
//!
//! Errors about the app or the redirect URI are plain 400s (the hosted page shows them and
//! never redirects to an unregistered URI). Once the redirect URI is known to be the app's,
//! other request errors also carry `details.redirect_to`: the RFC 6749 error redirect the page
//! may offer ("back to the app").

use accounts_core::crypto::{pkce, prefix, random_token};
use accounts_core::http::cookies::flow_cookie;
use accounts_core::http::{ClientMeta, Json, check_origin};
use accounts_core::models::{AccountKind, Method, Scope};
use accounts_core::normalize::normalize_timezone;
use accounts_core::repo::rate_limit::{self, Limit};
use accounts_core::{ApiError, ApiResult, AppState};
use axum::extract::State;
use axum::http::{HeaderMap, Method as HttpMethod, StatusCode};
use serde::Deserialize;
use serde_json::json;

use super::browser;
use super::details::{self, Plan, Standing};
use super::model::{self, FlowError, Intent, NewFlow, Prompt, Step};
use super::next;
use super::signup;
use super::view::{self, ViewContext};
use super::{FlowApp, FlowResponse};
use crate::util::{telemetry, with_query};

/// Flows a single network may start per minute (abuse guard; generous for shared NATs).
pub const FLOW_CREATE_PER_IP: Limit = Limit::new(300, 60);

/// The authorize request as the SPA forwards it (query parameters as JSON). Unknown fields
/// are ignored; empty strings count as absent. `state` and `nonce` are kept exactly as sent
/// (they must come back byte for byte); everything else is trimmed.
///
/// `login_hint` is ignored entirely: an app can never hand Silicon Accounts a Carbon's email
/// or phone (UNDERSTANDING.md "Adding sign-in to an app"), so it is not prefilled, not stored,
/// not echoed and not forwarded to Google or Apple.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct CreateFlowBody {
    pub app_id: Option<String>,
    /// Alias of `app_id` (OAuth clients send `client_id`).
    pub client_id: Option<String>,
    pub redirect_uri: Option<String>,
    /// Accepted; only `code` is supported.
    pub response_type: Option<String>,
    pub state: Option<String>,
    pub code_challenge: Option<String>,
    pub code_challenge_method: Option<String>,
    pub scope: Option<String>,
    pub nonce: Option<String>,
    pub prompt: Option<String>,
    /// `signin` (default) or `signup`: which version of the pages to show.
    pub intent: Option<String>,
    /// A direct method button (`google`, `apple`, `email`, `phone`).
    pub method: Option<String>,
    /// The browser's `Intl` timezone (sign-up suggestion fallback).
    pub timezone: Option<String>,
}

fn clean(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// A value the app gets back unchanged (`state` in the redirect, `nonce` in the id_token):
/// never trimmed (RFC 6749 §4.1.2 wants the exact `state`; OIDC clients compare the nonce byte
/// for byte). Only an empty string counts as absent.
fn exact(v: &Option<String>) -> Option<&str> {
    v.as_deref().filter(|s| !s.is_empty())
}

/// An error after the redirect URI was validated: also carries the RFC 6749 error redirect.
fn request_error(
    code: &'static str,
    oauth_error: &str,
    message: String,
    hint: &str,
    redirect_uri: &str,
    state: Option<&str>,
) -> ApiError {
    let redirect = with_query(
        redirect_uri,
        &[
            ("error", Some(oauth_error)),
            ("error_description", Some(&message)),
            ("state", state),
        ],
    );
    ApiError::bad_request(code, message)
        .hint(hint)
        .detail("redirect_to", redirect)
}

/// `POST /v1/flows` (public; same-origin): validates the authorize request, creates the flow
/// (60 minutes), sets the `sa_flow` binding cookie and returns `201 {"flow": FlowView}`.
pub async fn create_flow(
    State(state): State<AppState>,
    meta: ClientMeta,
    headers: HeaderMap,
    Json(body): Json<CreateFlowBody>,
) -> ApiResult<FlowResponse> {
    check_origin(&state.settings, &headers, &HttpMethod::POST)?;

    // The app.
    let app_id = match (clean(&body.app_id), clean(&body.client_id)) {
        (Some(a), Some(c)) if a != c => {
            return Err(ApiError::invalid_request(format!(
                "app_id '{a}' and client_id '{c}' disagree; send one of them (client_id is an alias of app_id)."
            )));
        }
        (Some(a), _) | (None, Some(a)) => a.to_string(),
        (None, None) => {
            return Err(ApiError::invalid_request(
                "app_id is required: the authorize URL must name the app (client_id is accepted as an alias).",
            )
            .hint("Start the sign-in from the app, e.g. /authorize?app_id=<app_id>&redirect_uri=<url>&state=<random>."));
        }
    };
    let mut tx = state.db.begin().await?;
    let fa = match FlowApp::load(&mut tx, &state.settings, &app_id).await {
        Ok(fa) => fa,
        Err(e) if e.code == "unknown_app" => {
            return Err(ApiError::bad_request(
                "unknown_app",
                format!("No app with app_id '{app_id}' exists in Silicon Accounts."),
            )
            .hint("Check the app_id in the sign-in link; apps are created in Silicon Apps."));
        }
        Err(e) => return Err(e),
    };
    if !fa.app.is_active() {
        return Err(ApiError::bad_request(
            "app_disabled",
            format!("The app '{app_id}' is disabled, so nobody can sign in to it right now."),
        )
        .hint("Ask the app's owner to re-enable it in Silicon Apps."));
    }

    // The redirect URI.
    let Some(redirect_uri) = clean(&body.redirect_uri).map(str::to_string) else {
        return Err(ApiError::invalid_request(
            "redirect_uri is required: the app must say where to send the result.",
        )
        .hint(
            "Add redirect_uri=<one of the app's registered redirect URIs> to the authorize URL.",
        ));
    };
    // RFC 6749 §3.1.2: a redirection URI never has a fragment. Registered URIs can't carry one
    // (the sign-in setup refuses them), but the loopback rule matches on host, path and query
    // only, so check the URI itself: the result would otherwise go to `…?code=…&state=…#…`.
    if redirect_uri.contains('#') {
        return Err(ApiError::bad_request(
            "redirect_uri_not_registered",
            format!(
                "redirect_uri '{redirect_uri}' is not registered for the app '{app_id}': it has a #fragment, and a redirect URI must never have one (RFC 6749 §3.1.2), so no registered URI can match it."
            ),
        )
        .hint("Send the registered redirect URI without the #… part; keep client-side state in the state parameter instead.")
        .detail("app_id", app_id.as_str()));
    }
    if !fa
        .config
        .redirect_allowed(&state.settings, &app_id, &redirect_uri)
    {
        let rule = if app_id == accounts_core::DEVELOPER_APP_ID {
            format!(
                "the developer site only redirects to {}",
                state.settings.developer_callback_url()
            )
        } else if fa.first_party() {
            format!(
                "the first-party app only redirects to {} (or an ACCOUNTS_EXTRA_ALLOWED_ORIGINS origin)",
                state.settings.public_origin
            )
        } else {
            "it must equal one of the app's registered redirect_uris exactly (http://localhost and http://127.0.0.1 match on any port when registered with that host)".to_string()
        };
        // First-party apps have no sign-in setup anyone can change: their redirect rule comes
        // from accounts-api's own settings.
        let hint = if app_id == accounts_core::DEVELOPER_APP_ID {
            format!(
                "The developer platform signs in only through {}. If the developer platform runs at another address, set ACCOUNTS_DEVELOPER_URL on accounts-api to its origin.",
                state.settings.developer_callback_url()
            )
        } else if fa.first_party() {
            format!(
                "Send redirect_uri on {}, or add the origin to ACCOUNTS_EXTRA_ALLOWED_ORIGINS on accounts-api.",
                state.settings.public_origin
            )
        } else {
            format!(
                "Register it in the app's sign-in setup (on developer.teamofsilicons.com, or PATCH /v1/apps/{app_id}/signin-config with redirect_uris), or use a registered URI."
            )
        };
        return Err(ApiError::bad_request(
            "redirect_uri_not_registered",
            format!(
                "redirect_uri '{redirect_uri}' is not registered for the app '{app_id}': {rule}."
            ),
        )
        .hint(hint)
        .detail("app_id", app_id.as_str()));
    }

    // Everything else (errors also carry the redirect back to the app).
    let state_param = exact(&body.state).map(str::to_string);
    let st = state_param.as_deref();
    if let Some(rt) = clean(&body.response_type)
        && rt != "code"
    {
        return Err(request_error(
            "unsupported_response_type",
            "unsupported_response_type",
            format!(
                "response_type '{rt}' is not supported; Silicon Accounts only issues authorization codes (response_type=code)."
            ),
            "Use response_type=code (or leave it out) and exchange the code at POST /v1/oauth/token.",
            &redirect_uri,
            st,
        ));
    }
    if st.is_some_and(|s| s.len() > 1024) {
        return Err(request_error(
            "invalid_request",
            "invalid_request",
            "state is longer than 1024 characters.".into(),
            "Send a shorter state (a random 32-byte value is plenty).",
            &redirect_uri,
            st,
        ));
    }
    if st.is_some_and(|s| s.chars().any(char::is_control)) {
        return Err(request_error(
            "invalid_request",
            "invalid_request",
            "state contains control characters; it must be printable text (RFC 6749 Appendix A.5)."
                .into(),
            "Send a random value such as base64url or hex text as state.",
            &redirect_uri,
            st,
        ));
    }
    let requested_scopes = match clean(&body.scope) {
        None => vec![Scope::Profile],
        Some(s) => Scope::parse_list(s).map_err(|m| {
            request_error(
                "invalid_scope",
                "invalid_scope",
                format!("The scope parameter is invalid: {m}."),
                "Request only supported scopes, e.g. scope=openid email.",
                &redirect_uri,
                st,
            )
        })?,
    };
    let prompt = Prompt::parse(clean(&body.prompt)).map_err(|m| {
        request_error(
            "invalid_request",
            "invalid_request",
            format!("The prompt parameter is invalid: {m}."),
            "Use prompt=login, consent, select_account or none (or leave it out).",
            &redirect_uri,
            st,
        )
    })?;
    let code_challenge = clean(&body.code_challenge).map(str::to_string);
    let challenge_method = clean(&body.code_challenge_method);
    let code_challenge_method = match (&code_challenge, challenge_method) {
        (None, Some(_)) => {
            return Err(request_error(
                "invalid_request",
                "invalid_request",
                "code_challenge_method was sent without a code_challenge.".into(),
                "Send code_challenge (base64url SHA-256 of your code_verifier) with code_challenge_method=S256.",
                &redirect_uri,
                st,
            ));
        }
        (None, None) => None,
        (Some(c), m) => {
            let method = pkce::validate_method(m).map_err(|msg| {
                request_error(
                    "invalid_request",
                    "invalid_request",
                    format!("{msg}."),
                    "Use code_challenge_method=S256.",
                    &redirect_uri,
                    st,
                )
            })?;
            let valid_chars = c
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || "-._~".contains(ch));
            if !(43..=128).contains(&c.len()) || !valid_chars {
                return Err(request_error(
                    "invalid_request",
                    "invalid_request",
                    format!(
                        "code_challenge must be 43 to 128 characters of A-Z, a-z, 0-9, '-', '.', '_' and '~' (RFC 7636); got {} characters.",
                        c.len()
                    ),
                    "For S256 send base64url(SHA-256(code_verifier)) without padding (43 characters).",
                    &redirect_uri,
                    st,
                ));
            }
            Some(method.to_string())
        }
    };
    let nonce = exact(&body.nonce).map(str::to_string);
    if nonce.as_deref().is_some_and(|n| n.len() > 512) {
        return Err(request_error(
            "invalid_request",
            "invalid_request",
            "nonce is longer than 512 characters.".into(),
            "Send a shorter nonce (a random 32-byte value is plenty).",
            &redirect_uri,
            st,
        ));
    }
    if nonce
        .as_deref()
        .is_some_and(|n| n.chars().any(char::is_control))
    {
        return Err(request_error(
            "invalid_request",
            "invalid_request",
            "nonce contains control characters; it must be printable text.".into(),
            "Send a random value such as base64url or hex text as nonce.",
            &redirect_uri,
            st,
        ));
    }
    let intent = match clean(&body.intent) {
        None => Intent::Signin,
        Some(raw) => Intent::parse(raw).ok_or_else(|| {
            request_error(
                "invalid_request",
                "invalid_request",
                format!("intent '{raw}' is not supported; use intent=signin or intent=signup."),
                "Leave intent out for the sign-in pages, or send intent=signup for the sign-up version.",
                &redirect_uri,
                st,
            )
        })?,
    };
    let method_hint = match clean(&body.method) {
        None => None,
        Some(m) => {
            let parsed = Method::parse(m);
            let available = fa.config.available_methods(&state.settings);
            match parsed {
                Some(method) if available.contains(&method) => Some(method),
                _ => {
                    let list = available.iter().map(Method::as_str).collect::<Vec<_>>();
                    return Err(request_error(
                        "method_not_enabled",
                        "invalid_request",
                        format!(
                            "method '{m}' is not a sign-in method of {}; it offers {}.",
                            fa.app.name,
                            if list.is_empty() {
                                "none".to_string()
                            } else {
                                list.join(", ")
                            }
                        ),
                        "Leave method out, or use one of the app's methods.",
                        &redirect_uri,
                        st,
                    )
                    .detail("methods", list));
                }
            }
        }
    };

    rate_limit::enforce(
        &mut tx,
        &rate_limit::bucket("flow_create:ip", meta.ip_or_unknown()),
        FLOW_CREATE_PER_IP,
        "sign-ins started from this network",
    )
    .await?;

    // Binding: reuse the browser's flow cookie so several open sign-ins stay bound.
    let binding = model::binding_cookie(&headers, &state.settings)
        .filter(|t| t.len() == prefix::FLOW.len() + 43)
        .unwrap_or_else(|| random_token(prefix::FLOW));
    let id = model::new_flow_id();
    let mut flow = model::insert(
        &mut tx,
        &NewFlow {
            id: &id,
            binding_hash: &state.keys.pepper.hash(&binding),
            app_id: &app_id,
            redirect_uri: &redirect_uri,
            state: st,
            code_challenge: code_challenge.as_deref(),
            code_challenge_method: code_challenge_method.as_deref(),
            nonce: nonce.as_deref(),
            requested_scopes: &requested_scopes,
            prompt,
            method_hint,
        },
    )
    .await?;
    flow.extras.intent = intent;
    flow.extras.browser_timezone = clean(&body.timezone).and_then(|t| normalize_timezone(t).ok());

    let current = browser::current(&mut tx, &state, &headers).await?;
    let usable_browser = current
        .as_ref()
        .filter(|b| b.is_active_carbon() && fa.config.remember_browser && !prompt.login);
    if prompt.none {
        // Given the browser's account as it is: when it can't be used, the error says why.
        silent_sign_in(&mut tx, &state, &meta, &mut flow, &fa, current.as_ref()).await?;
    } else if usable_browser.is_none()
        && let Some(session) = signup::from_cookie(&mut tx, &state, &headers).await?
        && signup::may_resume(&session, &fa, &state.settings)
    {
        // A sign-up verified in this browser in the last 48 hours continues here.
        flow.step = Step::Signup;
        flow.signup_session_id = Some(session.id);
        flow.extras.auth_method = Some(session.method().to_string());
    }
    model::save(&mut tx, &flow).await?;
    let view = view::build(
        &mut tx,
        &ViewContext {
            state: &state,
            meta: &meta,
            browser: current.as_ref(),
        },
        &flow,
        &fa,
    )
    .await?;
    tx.commit().await?;
    telemetry(
        &state,
        "flow.created",
        Some(0.1),
        json!({
            "app_id": app_id,
            "step": flow.step.as_str(),
            "prompt": prompt.to_stored(),
            "pkce": code_challenge_method,
            "openid": flow.wants_openid(),
            "method_hint": method_hint.map(|m| m.as_str()),
            "intent": intent.as_str(),
        }),
    );
    Ok(FlowResponse {
        status: StatusCode::CREATED,
        view,
        cookies: vec![flow_cookie(&state.settings, &binding)],
    })
}

/// `prompt=none`: complete with the browser's account when nothing needs the Carbon, else end
/// the flow with the OIDC error (`login_required`, `interaction_required`, `consent_required`).
/// `browser` is the browser's account whatever it is: `login_required` says why it can't be used
/// (nobody signed in, a Silicon, an account that can't sign in, or an app that asks every Carbon
/// to sign in again).
async fn silent_sign_in(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    meta: &ClientMeta,
    flow: &mut model::Flow,
    fa: &FlowApp,
    browser: Option<&browser::BrowserAccount>,
) -> ApiResult<()> {
    let sign_in_hint =
        "Send the browser to /authorize without prompt=none so the Carbon can sign in.";
    let Some(b) = browser else {
        return next::fail(
            state,
            flow,
            FlowError::new(
                "login_required",
                "No Carbon is signed in to Silicon Accounts in this browser, and prompt=none forbids showing the sign-in page.",
                sign_in_hint,
            ),
        );
    };
    if b.account.kind != AccountKind::Carbon {
        return next::fail(
            state,
            flow,
            FlowError::new(
                "login_required",
                format!(
                    "This browser is signed in to Silicon Accounts as {}, a Silicon; Silicons never use the sign-in pages, so prompt=none can't sign a Carbon in silently.",
                    b.account.display_id()
                ),
                "Send the browser to /authorize without prompt=none so a Carbon can sign in. A Silicon signs in to apps with `accounts login --app <app_id>`.",
            ),
        );
    }
    if !b.is_active_carbon() {
        return next::fail(
            state,
            flow,
            FlowError::new(
                "login_required",
                format!(
                    "The account signed in to this browser ({}) is {} and can't sign in, and prompt=none forbids showing the sign-in page.",
                    b.account.display_id(),
                    b.account.status
                ),
                sign_in_hint,
            ),
        );
    }
    if !fa.config.remember_browser {
        return next::fail(
            state,
            flow,
            FlowError::new(
                "login_required",
                format!(
                    "{} asks every Carbon to sign in again (remember_browser is off), so prompt=none can't sign in silently with the account signed in to this browser.",
                    fa.app.name
                ),
                "Send the browser to /authorize without prompt=none so the Carbon signs in again, or turn remember_browser on in the app's sign-in setup.",
            ),
        );
    }
    if !next::account_domain_allowed(conn, &fa.config, &b.account).await? {
        return next::fail(
            state,
            flow,
            FlowError::new(
                "interaction_required",
                format!(
                    "The signed-in account has no verified email at {}, which {} requires.",
                    fa.config.allowed_email_domains.join(", "),
                    fa.app.name
                ),
                "Send the browser to /authorize without prompt=none so the Carbon can pick another account.",
            ),
        );
    }
    if !fa.first_party() {
        let standing = Standing::load(conn, &fa.app.app_id, &b.account).await?;
        if !details::missing_required_fields(&fa.config, &standing).is_empty() {
            return next::fail(
                state,
                flow,
                FlowError::new(
                    "interaction_required",
                    format!(
                        "The signed-in account is missing details {} requires.",
                        fa.app.name
                    ),
                    "Send the browser to /authorize without prompt=none so the Carbon can add them.",
                ),
            );
        }
        if details::any_page(&Plan::of(flow, &fa.config), &standing, flow) {
            return next::fail(
                state,
                flow,
                FlowError::new(
                    "consent_required",
                    format!(
                        "The signed-in account hasn't agreed to share what {} asks for.",
                        fa.app.name
                    ),
                    "Send the browser to /authorize without prompt=none so the Carbon can see what is shared.",
                ),
            );
        }
    }
    flow.account_uuid = Some(b.account.uuid.clone());
    flow.extras.auth_method = Some(accounts_core::repo::audit::method::SESSION.to_string());
    flow.extras.browser_session_id = Some(b.session_id);
    next::complete(conn, state, meta, flow, fa, &b.account, next::Grant::Auto).await
}
