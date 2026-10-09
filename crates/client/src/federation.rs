//! Workload identity federation: sign a Silicon in from CI with the job's own OIDC token, so
//! the job stores no secret. The Silicon's custodian (or the Silicon) first trusts the issuer
//! for tokens whose claims match ([`crate::AccountSession::add_federation`]); the job then
//! reads its token ([`TokenSource`], [`github_actions_id_token`]) and exchanges it
//! ([`crate::AccountsClient::exchange_federated_token`]) for a sign-in that ends with that
//! token (at least 30 minutes, at most 12 hours).

use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::secret::Secret;

/// The token-exchange grant type (RFC 8693).
pub const TOKEN_EXCHANGE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
/// `subject_token_type` of an outside OIDC token.
pub const JWT_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:jwt";
/// GitHub Actions' OIDC issuer.
pub const GITHUB_ACTIONS_ISSUER: &str = "https://token.actions.githubusercontent.com";
/// GitLab.com's OIDC issuer.
pub const GITLAB_ISSUER: &str = "https://gitlab.com";
/// The variables GitHub Actions sets in a job with `permissions: id-token: write`.
pub const GITHUB_REQUEST_URL_VAR: &str = "ACTIONS_ID_TOKEN_REQUEST_URL";
/// See [`GITHUB_REQUEST_URL_VAR`].
pub const GITHUB_REQUEST_TOKEN_VAR: &str = "ACTIONS_ID_TOKEN_REQUEST_TOKEN";

/// Where an outside OIDC token comes from. Every source but [`TokenSource::Literal`] can be
/// read again later for a fresh token (a CI job's token expires in minutes).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenSource {
    /// The token itself.
    Literal(Secret),
    /// A file holding it (`@path`), such as a Kubernetes projected token.
    File(PathBuf),
    /// An environment variable holding it (`env:NAME`), such as a GitLab `id_tokens` variable.
    Env(String),
    /// GitHub Actions' token endpoint, asked for this audience.
    GithubActions {
        /// The `aud` to ask for (the trust's audience).
        audience: String,
    },
}

impl TokenSource {
    /// `@path` reads a file, `env:NAME` an environment variable; anything else is the token.
    pub fn parse(spec: &str) -> TokenSource {
        let spec = spec.trim();
        if let Some(path) = spec.strip_prefix('@') {
            TokenSource::File(PathBuf::from(path))
        } else if let Some(name) = spec.strip_prefix("env:") {
            TokenSource::Env(name.trim().to_owned())
        } else {
            TokenSource::Literal(Secret::new(spec))
        }
    }

    /// True when [`TokenSource::read`] can get a fresh token again later.
    pub fn is_rereadable(&self) -> bool {
        !matches!(self, TokenSource::Literal(_))
    }

    /// What the source is, without the token (for messages and for storing how to sign in
    /// again): `github-actions`, `env:NAME`, `@path` or `token`.
    pub fn describe(&self) -> String {
        match self {
            TokenSource::Literal(_) => "token".to_owned(),
            TokenSource::File(p) => format!("@{}", p.display()),
            TokenSource::Env(name) => format!("env:{name}"),
            TokenSource::GithubActions { .. } => "github-actions".to_owned(),
        }
    }

    /// Reads the token.
    pub async fn read(&self) -> Result<Secret> {
        let token = match self {
            TokenSource::Literal(t) => t.clone(),
            TokenSource::File(path) => {
                let text = tokio::fs::read_to_string(path).await.map_err(|e| {
                    Error::invalid_input(
                        format!(
                            "Could not read the OIDC token file {}: {e}.",
                            path.display()
                        ),
                        "Pass @<path> to a file that holds the token (and nothing else).",
                    )
                })?;
                Secret::new(text.trim())
            }
            TokenSource::Env(name) => {
                let value = std::env::var(name).unwrap_or_default();
                if value.trim().is_empty() {
                    return Err(Error::invalid_input(
                        format!("The environment variable {name} is empty or not set."),
                        "On GitLab, declare it under id_tokens: in the job (with aud: the trust's audience).",
                    ));
                }
                Secret::new(value.trim())
            }
            TokenSource::GithubActions { audience } => github_actions_id_token(audience).await?,
        };
        if token.expose().split('.').count() != 3 {
            return Err(Error::invalid_input(
                format!(
                    "The OIDC token from {} isn't a JWT (three base64url parts separated by dots).",
                    self.describe()
                ),
                "Pass the id token your CI gives the job, not a file name or a variable name by itself (use @path or env:NAME for those).",
            ));
        }
        Ok(token)
    }
}

#[derive(Deserialize)]
struct GithubTokenResponse {
    value: Option<String>,
}

/// Asks GitHub Actions for the job's OIDC token with this `audience`. The job needs
/// `permissions: id-token: write`, which sets `ACTIONS_ID_TOKEN_REQUEST_URL` and
/// `ACTIONS_ID_TOKEN_REQUEST_TOKEN`.
pub async fn github_actions_id_token(audience: &str) -> Result<Secret> {
    let missing = || {
        Error::invalid_input(
            format!(
                "{GITHUB_REQUEST_URL_VAR} and {GITHUB_REQUEST_TOKEN_VAR} are not set, so this isn't a GitHub Actions job that may ask for an OIDC token."
            ),
            "Give the job `permissions: id-token: write` (and contents: read) in the workflow.",
        )
    };
    let url = std::env::var(GITHUB_REQUEST_URL_VAR)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(missing)?;
    let bearer = std::env::var(GITHUB_REQUEST_TOKEN_VAR)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(missing)?;
    let mut url = url::Url::parse(url.trim()).map_err(|_| {
        Error::invalid_input(
            format!("{GITHUB_REQUEST_URL_VAR} is not a URL."),
            "Leave the variable as GitHub Actions sets it.",
        )
    })?;
    if !audience.trim().is_empty() {
        url.query_pairs_mut()
            .append_pair("audience", audience.trim());
    }
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| {
            Error::invalid_input(format!("Could not start an HTTP client: {e}."), "Retry.")
        })?;
    let response = http
        .get(url)
        .header("authorization", format!("bearer {}", bearer.trim()))
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| Error::Http {
            message: "Could not reach GitHub Actions' OIDC token endpoint.".to_owned(),
            hint: "Retry the step; the endpoint is only reachable from inside the running job."
                .to_owned(),
            source: e,
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(Error::decode(
            format!("GitHub Actions' OIDC token endpoint answered {status}."),
            "Check the job has `permissions: id-token: write`; forks' pull requests can't get tokens.",
        ));
    }
    let body: GithubTokenResponse = response.json().await.map_err(|_| {
        Error::decode(
            "GitHub Actions' OIDC token endpoint didn't answer {\"value\": \"<token>\"}.",
            "Retry the step.",
        )
    })?;
    body.value
        .filter(|v| !v.trim().is_empty())
        .map(Secret::new)
        .ok_or_else(|| {
            Error::decode(
                "GitHub Actions' OIDC token endpoint answered without a token.",
                "Retry the step.",
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_parse() {
        assert_eq!(
            TokenSource::parse("@/var/run/token"),
            TokenSource::File("/var/run/token".into())
        );
        assert_eq!(
            TokenSource::parse("env:SILICON_ID_TOKEN"),
            TokenSource::Env("SILICON_ID_TOKEN".into())
        );
        let literal = TokenSource::parse("eyJ.a.b");
        assert!(!literal.is_rereadable());
        assert_eq!(literal.describe(), "token");
        assert!(!format!("{literal:?}").contains("eyJ.a.b"));
    }
}
