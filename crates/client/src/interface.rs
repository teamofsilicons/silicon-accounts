//! Public or confidential Interface sign-in with S256 PKCE and durable operation keys.
use crate::client::{Auth, Request};
use crate::types::{AccountForApp, AccountKind};
use crate::{AccountsClient, Result, Secret};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use url::Url;

/// A Carbon or Silicon signed in to an Interface.
#[derive(Debug, Clone, Deserialize)]
pub struct InterfaceAccount {
    /// Immutable account identifier.
    pub uuid: String,
    /// Current public account ID.
    pub id: Option<String>,
    /// Carbon or Silicon.
    pub kind: AccountKind,
    /// Display name.
    pub display_name: String,
    /// Email when separately approved for the Interface.
    pub email: Option<String>,
    /// Phone when separately approved for the Interface.
    pub phone: Option<String>,
    /// Date of birth when separately approved for the Interface.
    pub dob: Option<String>,
    /// Timezone when separately approved for the Interface.
    pub timezone: Option<String>,
}
/// An access credential for a single app. The Interface does not receive the app's refresh token.
#[derive(Debug, Clone, Deserialize)]
pub struct InterfaceAppAccess {
    /// App-audience bearer token.
    pub access_token: Secret,
    /// Token type, normally `Bearer`.
    pub token_type: String,
    /// Lifetime in seconds.
    pub expires_in: i64,
    /// Access-token expiry (RFC 3339).
    pub access_token_expires_at: String,
    /// Account details granted to this app.
    pub scope: String,
    /// Scoped account view.
    pub account: AccountForApp,
}
/// Interface session credentials and separately scoped app access tokens.
#[derive(Debug, Clone, Deserialize)]
pub struct InterfaceTokens {
    /// Registered Interface ID.
    pub interface_id: String,
    /// Stable session ID.
    pub session_id: String,
    /// Absolute session expiry (RFC 3339).
    pub expires_at: String,
    /// Account that approved this session.
    pub account: InterfaceAccount,
    /// Rotating credential; save the new value before another refresh.
    pub refresh_token: Secret,
    /// App access credentials keyed by app ID.
    pub apps: BTreeMap<String, InterfaceAppAccess>,
}
/// One active Interface session visible to its account.
#[derive(Debug, Clone, Deserialize)]
pub struct InterfaceSessionInfo {
    /// Session identifier.
    pub session_id: String,
    /// Registered Interface ID.
    pub interface_id: String,
    /// Current Interface name.
    pub name: String,
    /// Optional Interface logo.
    pub logo_url: Option<String>,
    /// Apps approved for this session.
    pub apps: Vec<String>,
    /// Creation time (RFC 3339).
    pub created_at: String,
    /// Expiry time (RFC 3339).
    pub expires_at: String,
}

/// Result of inspecting an Interface refresh credential.
#[derive(Debug, Clone, Deserialize)]
pub struct InterfaceIntrospection {
    /// Whether the current refresh credential still represents an active session.
    pub active: bool,
    /// Interface ID when active.
    pub interface_id: Option<String>,
    /// Session ID when active.
    pub session_id: Option<String>,
    /// Session expiry (RFC 3339) when active.
    pub expires_at: Option<String>,
    /// Signed-in account when active.
    pub account: Option<InterfaceAccount>,
}
/// A verified self-hosted sign-in flow. Keep its capability in the confidential backend.
#[derive(Debug, Clone, Deserialize)]
pub struct VerifiedInterfaceFlow {
    /// Opaque backend-only flow capability.
    pub capability: Secret,
    /// Current Accounts sign-in step and safe display data.
    pub flow: Value,
}

/// Result of an action on a verified self-hosted sign-in.
#[derive(Debug, Clone, Deserialize)]
pub struct VerifiedInterfaceAction {
    /// Updated Accounts sign-in step, when applicable.
    pub flow: Option<Value>,
    /// App review shown after account verification.
    pub review: Option<Value>,
    /// Registered callback containing the Interface authorization code after a decision.
    pub redirect_to: Option<Secret>,
}

/// An Interface client. A public client has no secret and always uses S256 PKCE.
pub struct InterfaceClient<'a> {
    client: &'a AccountsClient,
    id: String,
    secret: Option<Secret>,
}
impl std::fmt::Debug for InterfaceClient<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InterfaceClient")
            .field("id", &self.id)
            .field("confidential", &self.secret.is_some())
            .finish()
    }
}
impl AccountsClient {
    /// Create an Interface client; never embed a client secret in a public app.
    pub fn as_interface(
        &self,
        id: impl Into<String>,
        secret: Option<String>,
    ) -> InterfaceClient<'_> {
        InterfaceClient {
            client: self,
            id: id.into(),
            secret: secret.map(Secret::new),
        }
    }
}
impl InterfaceClient<'_> {
    /// Hosted authorization URL. Keep the verifier private and verify state on callback.
    pub fn authorize_url(&self, redirect_uri: &str, state: &str, challenge: &str) -> Url {
        let mut url = self.client.endpoint(&["interface-authorize"]);
        url.query_pairs_mut()
            .append_pair("interface_id", &self.id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("state", state)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256");
        url
    }
    async fn request<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &Value,
        key: Option<&str>,
    ) -> Result<T> {
        let request = Request::new(
            Method::POST,
            self.client.endpoint(&["v1", "interface-auth", path]),
            Auth::None,
        )
        .idempotency_key(key)?
        .json(body)?;
        self.client.execute(request).await?.json()
    }
    fn secret(&self) -> Option<&str> {
        self.secret.as_ref().map(Secret::expose)
    }
    /// Exchange an authorization code. Persist the same operation key for uncertain retries.
    pub async fn exchange_code(
        &self,
        code: &str,
        redirect_uri: &str,
        verifier: &str,
        operation_key: &str,
    ) -> Result<InterfaceTokens> {
        self.request("token",&json!({"interface_id":self.id,"client_secret":self.secret(),"grant_type":"authorization_code","code":code,"redirect_uri":redirect_uri,"code_verifier":verifier}),Some(operation_key)).await
    }
    /// Rotate the Interface session. Reuse the operation key after an uncertain response.
    /// A trusted Interface may request an additional app with `app_id`.
    pub async fn refresh(
        &self,
        refresh_token: &str,
        operation_key: &str,
        app_id: Option<&str>,
    ) -> Result<InterfaceTokens> {
        self.request("token",&json!({"interface_id":self.id,"client_secret":self.secret(),"grant_type":"refresh_token","refresh_token":refresh_token,"app_id":app_id}),Some(operation_key)).await
    }
    /// Start verified self-hosted sign-in from a confidential backend. The origin and callback
    /// must be registered, and the client must hold the Interface secret.
    pub async fn verified_start(
        &self,
        origin: &str,
        redirect_uri: &str,
        state: &str,
        challenge: &str,
    ) -> Result<VerifiedInterfaceFlow> {
        let secret = self.secret().ok_or_else(|| {
            crate::Error::invalid_input(
                "A verified Interface backend requires its secret.",
                "Configure the secret on the backend, never in browser code.",
            )
        })?;
        let body = json!({"interface_id":self.id,"interface_origin":origin,"redirect_uri":redirect_uri,"state":state,"code_challenge":challenge,"code_challenge_method":"S256"});
        let request = Request::new(
            Method::POST,
            self.client
                .endpoint(&["v1", "verified-interface-auth", "start"]),
            Auth::Bearer(secret),
        )
        .json(&body)?;
        self.client.execute(request).await?.json()
    }

    /// Continue a verified flow. `action` is get, email, phone, resend, verify, signup,
    /// select_account, review or decision; send the corresponding JSON payload.
    pub async fn verified_action(
        &self,
        origin: &str,
        capability: &str,
        action: &str,
        payload: &Value,
    ) -> Result<VerifiedInterfaceAction> {
        let secret = self.secret().ok_or_else(|| {
            crate::Error::invalid_input(
                "A verified Interface backend requires its secret.",
                "Configure the secret on the backend, never in browser code.",
            )
        })?;
        let body = json!({"interface_id":self.id,"interface_origin":origin,"capability":capability,"action":action,"payload":payload});
        let request = Request::new(
            Method::POST,
            self.client
                .endpoint(&["v1", "verified-interface-auth", "action"]),
            Auth::Bearer(secret),
        )
        .json(&body)?;
        self.client.execute(request).await?.json()
    }

    /// Check whether a current Interface refresh credential is active.
    pub async fn introspect(&self, refresh_token: &str) -> Result<InterfaceIntrospection> {
        self.request("introspect",&json!({"interface_id":self.id,"client_secret":self.secret(),"refresh_token":refresh_token}),None).await
    }
    /// End this Interface session and its app-token families.
    pub async fn revoke(&self, refresh_token: &str) -> Result<()> {
        let _:Value=self.request("revoke",&json!({"interface_id":self.id,"client_secret":self.secret(),"refresh_token":refresh_token}),None).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn url_is_scoped_and_secret_debug_is_redacted() {
        let accounts = AccountsClient::new("https://accounts.teamofsilicons.com").unwrap();
        let client = accounts.as_interface("potato", Some("never-print-this".into()));
        let url = client.authorize_url("https://potato.test/callback", "state-1", "challenge-1");
        assert_eq!(url.path(), "/interface-authorize");
        assert!(
            url.query_pairs()
                .any(|(k, v)| k == "code_challenge_method" && v == "S256")
        );
        assert!(!format!("{client:?}").contains("never-print-this"));
    }
}
