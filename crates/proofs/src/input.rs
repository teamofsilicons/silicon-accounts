//! Request bodies and their validation.
//!
//! Shape problems (wrong types, unknown or missing fields) are rejected by the JSON extractor
//! with 422 `validation_failed`; this module adds the proof rules (scope syntax and count,
//! token lifetime bounds, receiving-app syntax, one app per ATA proof), all reported together
//! in `details.fields` (`ata_single_app` has its own code).

use accounts_core::crypto::describe_token;
use accounts_core::{ApiError, FieldErrors};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::{
    DEFAULT_ACCESS_TTL_SECONDS, MAX_ACCESS_TTL_SECONDS, MAX_SCOPE_LEN, MAX_SCOPES,
    MIN_ACCESS_TTL_SECONDS,
};

/// `POST /v1/proofs/obo`. `Debug` never prints the subject token.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IssueOboBody {
    /// The account's access token, issued to the calling app.
    pub subject_token: String,
    /// The app the proof is for.
    pub receiving_app: String,
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    #[serde(default)]
    pub access_ttl_seconds: Option<i64>,
}

/// `POST /v1/proofs/ata` and `POST /v1/apps/{app_id}/proofs/ata`:
/// `{"receiving_app": "remind", "scopes"?, "access_ttl_seconds"?}`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IssueAtaBody {
    /// The one app that may verify the proof (required; see [`IssueAtaBody::receiving_app`]).
    #[serde(default)]
    pub receiving_app: Option<String>,
    /// Accepted only to refuse it precisely: an ATA proof is for exactly one app, so a body
    /// naming `audiences` (any length) gets 422 `ata_single_app` ([`ata_single_app`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audiences: Option<Value>,
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    #[serde(default)]
    pub access_ttl_seconds: Option<i64>,
}

impl IssueAtaBody {
    /// The receiving app: 422 `ata_single_app` when the body lists `audiences` (the pre-v2
    /// shape), else the normalized `receiving_app` (a missing or malformed one is added to
    /// `fields`). `endpoint` is the route the caller used, for the hint.
    pub fn receiving_app(
        &self,
        endpoint: &str,
        fields: &mut FieldErrors,
    ) -> Result<Option<String>, ApiError> {
        if let Some(audiences) = &self.audiences {
            return Err(ata_single_app(endpoint, audiences));
        }
        match self.receiving_app.as_deref() {
            None => {
                fields.add(
                    "receiving_app",
                    "is required: the one app that may verify the proof, e.g. \"remind\"",
                );
                Ok(None)
            }
            Some(raw) => Ok(app_ref(raw, "receiving_app", fields)),
        }
    }
}

/// 422 `ata_single_app`: the body named `audiences`. An ATA proof is always for exactly one
/// app (UNDERSTANDING.md); an app that talks to several apps asks for one proof per app.
pub fn ata_single_app(endpoint: &str, audiences: &Value) -> ApiError {
    let apps: Vec<String> = audiences
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| accounts_core::ids::validate_app_id(s).is_ok())
                .collect()
        })
        .unwrap_or_default();
    let example = apps.first().map_or("remind", String::as_str).to_string();
    let mut e = ApiError::unprocessable(
        "ata_single_app",
        "An ATA proof is for exactly one app; ask for one proof per app.",
    )
    .hint(format!(
        "Send {{\"receiving_app\": \"{example}\"}} to POST {endpoint} instead of \"audiences\", and call it once for every app that should verify a proof from you; each app verifies its own proof."
    ))
    .detail("field", "audiences");
    if !apps.is_empty() {
        e = e.detail("apps", apps);
    }
    e
}

/// `POST /v1/proofs/refresh`. `Debug` never prints the refresh token.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RefreshBody {
    pub proof_refresh_token: String,
    #[serde(default)]
    pub access_ttl_seconds: Option<i64>,
}

/// `POST /v1/proofs/verify`. `Debug` never prints the proof token.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifyBody {
    pub proof_token: String,
}

/// `POST /v1/proofs/revoke`: exactly one of the three. `Debug` never prints tokens.
#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RevokeBody {
    #[serde(default)]
    pub proof_id: Option<String>,
    #[serde(default)]
    pub proof_token: Option<String>,
    #[serde(default)]
    pub proof_refresh_token: Option<String>,
}

/// Which proof a revoke request names. `Debug` never prints tokens.
#[derive(Clone, PartialEq, Eq)]
pub enum ProofReference {
    Id(String),
    Token(String),
    RefreshToken(String),
}

/// Placeholder printed instead of a secret.
const REDACTED: &str = "(redacted)";

fn redact(o: &Option<String>) -> Option<&'static str> {
    o.as_ref().map(|_| REDACTED)
}

impl std::fmt::Debug for ProofReference {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProofReference::Id(id) => f.debug_tuple("Id").field(id).finish(),
            ProofReference::Token(_) => f.debug_tuple("Token").field(&REDACTED).finish(),
            ProofReference::RefreshToken(_) => {
                f.debug_tuple("RefreshToken").field(&REDACTED).finish()
            }
        }
    }
}

impl std::fmt::Debug for IssueOboBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssueOboBody")
            .field("subject_token", &REDACTED)
            .field("receiving_app", &self.receiving_app)
            .field("scopes", &self.scopes)
            .field("access_ttl_seconds", &self.access_ttl_seconds)
            .finish()
    }
}

impl std::fmt::Debug for RefreshBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RefreshBody")
            .field("proof_refresh_token", &REDACTED)
            .field("access_ttl_seconds", &self.access_ttl_seconds)
            .finish()
    }
}

impl std::fmt::Debug for VerifyBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("VerifyBody")
            .field("proof_token", &REDACTED)
            .finish()
    }
}

impl std::fmt::Debug for RevokeBody {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RevokeBody")
            .field("proof_id", &self.proof_id)
            .field("proof_token", &redact(&self.proof_token))
            .field("proof_refresh_token", &redact(&self.proof_refresh_token))
            .finish()
    }
}

impl RevokeBody {
    /// The single reference, or a 422 naming the problem.
    pub fn reference(self) -> Result<ProofReference, FieldErrors> {
        let mut present: Vec<ProofReference> = [
            self.proof_id.map(ProofReference::Id),
            self.proof_token.map(ProofReference::Token),
            self.proof_refresh_token.map(ProofReference::RefreshToken),
        ]
        .into_iter()
        .flatten()
        .collect();
        let mut fields = FieldErrors::new();
        match present.len() {
            1 => {
                let r = present.remove(0);
                let (field, value) = match &r {
                    ProofReference::Id(v) => ("proof_id", v),
                    ProofReference::Token(v) => ("proof_token", v),
                    ProofReference::RefreshToken(v) => ("proof_refresh_token", v),
                };
                if value.trim().is_empty() {
                    fields.add(field, "must not be empty");
                    return Err(fields);
                }
                Ok(r)
            }
            0 => {
                fields.add(
                    "body",
                    "name the proof to revoke with exactly one of proof_id, proof_token or proof_refresh_token",
                );
                Err(fields)
            }
            _ => {
                fields.add(
                    "body",
                    "send exactly one of proof_id, proof_token or proof_refresh_token, not several",
                );
                Err(fields)
            }
        }
    }
}

/// Characters that separate a credential from a label or wrapper around it (`Bearer sap_…`,
/// `Proof sap_…`, `token=sapr_…`, `"sap_…"`).
const SEPARATORS: &str = "=:,;\"'`()[]{}<>";

/// Describes what a value sent where a token or id belongs looks like, from the credential
/// prefixes it carries, without ever repeating it: `"empty"`, `"a proof refresh token"`, or
/// for `Bearer sap_…` `"a proof token with other text around it (…)"`. `None` when it carries
/// no known credential.
pub fn describe_input(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return Some("empty".into());
    }
    if let Some(what) = describe_token(t) {
        return Some(what.to_string());
    }
    t.split(|c: char| c.is_whitespace() || SEPARATORS.contains(c))
        .find_map(describe_token)
        .map(|what| {
            format!(
                "{what} with other text around it (send the value alone, without a label such as 'Bearer ' or 'Proof ')"
            )
        })
}

/// Whether a value that failed to parse as an id may be repeated in an error message: short and
/// made only of letters, digits and `-`, like a mistyped UUID. Anything else could be a
/// credential pasted into the wrong field (a token, a JWT, an STK with or without `stk-`), so
/// it is described instead of echoed.
pub fn echo_safe(raw: &str) -> bool {
    let bare_stk = (8..=32).contains(&raw.len()) && raw.chars().all(|c| c.is_ascii_hexdigit());
    (1..=40).contains(&raw.len())
        && raw.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !raw.contains("eyJ")
        && !raw.to_ascii_lowercase().contains("stk-")
        && !bare_stk
}

/// Validates app-defined scopes: at most 20 distinct strings of 1 to 100 characters of
/// `A-Z a-z 0-9 _ . : / -`. Duplicates are dropped (first occurrence kept, order preserved).
pub fn scopes(raw: Option<&[String]>, fields: &mut FieldErrors) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Some(raw) = raw else {
        return out;
    };
    for (i, scope) in raw.iter().enumerate() {
        if let Err(problem) = check_scope(scope) {
            fields.add(format!("scopes[{i}]"), problem);
            continue;
        }
        if !out.iter().any(|s| s == scope) {
            out.push(scope.clone());
        }
    }
    if out.len() > MAX_SCOPES {
        fields.add(
            "scopes",
            format!(
                "a proof carries at most {MAX_SCOPES} distinct scopes; this request has {}",
                out.len()
            ),
        );
    }
    out
}

fn check_scope(scope: &str) -> Result<(), String> {
    if scope.is_empty() {
        return Err("must not be empty; scopes are app-defined strings like files.write".into());
    }
    let len = scope.chars().count();
    if len > MAX_SCOPE_LEN {
        return Err(format!(
            "is {len} characters; a scope is at most {MAX_SCOPE_LEN}"
        ));
    }
    if let Some(c) = scope
        .chars()
        .find(|c| !(c.is_ascii_alphanumeric() || "_.:/-".contains(*c)))
    {
        return Err(format!(
            "'{scope}' contains {c:?}; scopes use only A-Z, a-z, 0-9, '_', '.', ':', '/' and '-'"
        ));
    }
    Ok(())
}

/// Validates the requested proof token lifetime (60..=1800 s, default 1800).
pub fn access_ttl(raw: Option<i64>, fields: &mut FieldErrors) -> i64 {
    match raw {
        None => DEFAULT_ACCESS_TTL_SECONDS,
        Some(v) if (MIN_ACCESS_TTL_SECONDS..=MAX_ACCESS_TTL_SECONDS).contains(&v) => v,
        Some(v) => {
            fields.add(
                "access_ttl_seconds",
                format!(
                    "must be between {MIN_ACCESS_TTL_SECONDS} and {MAX_ACCESS_TTL_SECONDS} seconds; got {v}"
                ),
            );
            DEFAULT_ACCESS_TTL_SECONDS
        }
    }
}

/// Normalizes one app id reference (trim, lowercase) and checks its syntax.
pub fn app_ref(raw: &str, field: &str, fields: &mut FieldErrors) -> Option<String> {
    let id = raw.trim().to_ascii_lowercase();
    if id.is_empty() {
        fields.add(field, "must name an app, e.g. briefcase");
        return None;
    }
    match accounts_core::ids::validate_app_id(&id) {
        Ok(()) => Some(id),
        Err(m) => {
            fields.add(field, m);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn scope_rules() {
        let mut f = FieldErrors::new();
        let s = scopes(
            Some(&strings(&["files.write", "a:b/c-d_e", "files.write"])),
            &mut f,
        );
        assert!(f.is_empty(), "{f:?}");
        assert_eq!(s, strings(&["files.write", "a:b/c-d_e"]));

        let mut f = FieldErrors::new();
        scopes(
            Some(&strings(&["ok", "files write", "", &"x".repeat(101)])),
            &mut f,
        );
        assert!(
            f.get("scopes[1]").is_some_and(|m| m.contains("' '")),
            "{f:?}"
        );
        assert!(f.get("scopes[2]").is_some_and(|m| m.contains("empty")));
        assert!(
            f.get("scopes[3]")
                .is_some_and(|m| m.contains("101 characters"))
        );
        assert!(f.get("scopes[0]").is_none());

        let mut f = FieldErrors::new();
        let many: Vec<String> = (0..21).map(|i| format!("s{i}")).collect();
        scopes(Some(&many), &mut f);
        assert!(f.get("scopes").is_some_and(|m| m.contains("at most 20")));

        let mut f = FieldErrors::new();
        assert!(scopes(None, &mut f).is_empty());
        let x100 = "x".repeat(100);
        assert_eq!(
            scopes(Some(std::slice::from_ref(&x100)), &mut f),
            vec![x100]
        );
        assert!(f.is_empty());
    }

    #[test]
    fn ttl_rules() {
        let mut f = FieldErrors::new();
        assert_eq!(access_ttl(None, &mut f), 1800);
        assert_eq!(access_ttl(Some(60), &mut f), 60);
        assert_eq!(access_ttl(Some(1800), &mut f), 1800);
        assert!(f.is_empty());
        access_ttl(Some(59), &mut f);
        assert!(
            f.get("access_ttl_seconds")
                .is_some_and(|m| m.contains("got 59"))
        );
        let mut f = FieldErrors::new();
        access_ttl(Some(1801), &mut f);
        assert!(!f.is_empty());
    }

    #[test]
    fn ata_is_for_exactly_one_app() {
        let body = |v: serde_json::Value| -> IssueAtaBody {
            serde_json::from_value(v).expect("body parses")
        };
        let mut f = FieldErrors::new();
        assert_eq!(
            body(serde_json::json!({"receiving_app": " Remind"}))
                .receiving_app("/v1/proofs/ata", &mut f)
                .expect("ok"),
            Some("remind".to_string())
        );
        assert!(f.is_empty());

        let mut f = FieldErrors::new();
        assert_eq!(
            body(serde_json::json!({}))
                .receiving_app("/v1/proofs/ata", &mut f)
                .expect("no error"),
            None
        );
        assert!(
            f.get("receiving_app")
                .is_some_and(|m| m.contains("required"))
        );

        let mut f = FieldErrors::new();
        body(serde_json::json!({"receiving_app": "Not An App!"}))
            .receiving_app("/v1/proofs/ata", &mut f)
            .expect("no error");
        assert!(
            f.get("receiving_app")
                .is_some_and(|m| m.contains("not an app id"))
        );

        for audiences in [
            serde_json::json!(["remind", "waveform"]),
            serde_json::json!(["remind"]),
            serde_json::json!([]),
            serde_json::json!("remind"),
        ] {
            let mut f = FieldErrors::new();
            let e = body(serde_json::json!({"audiences": audiences, "receiving_app": "remind"}))
                .receiving_app("/v1/apps/commit/proofs/ata", &mut f)
                .expect_err("audiences are refused");
            assert_eq!(e.code, "ata_single_app");
            assert_eq!(e.status.as_u16(), 422);
            assert!(e.message.contains("exactly one app"), "{}", e.message);
            assert!(
                e.hint
                    .as_deref()
                    .is_some_and(|h| h.contains("POST /v1/apps/commit/proofs/ata")),
                "{:?}",
                e.hint
            );
        }
    }

    #[test]
    fn debug_never_prints_tokens() {
        let body = RevokeBody {
            proof_token: Some("sap_secretvalue".into()),
            ..Default::default()
        };
        assert!(!format!("{body:?}").contains("secretvalue"));
        let r = ProofReference::RefreshToken("sapr_secretvalue".into());
        assert!(!format!("{r:?}").contains("secretvalue"));
        let v = VerifyBody {
            proof_token: "sap_secretvalue".into(),
        };
        assert!(!format!("{v:?}").contains("secretvalue"));
        let o = IssueOboBody {
            subject_token: "eyJsecretvalue".into(),
            receiving_app: "briefcase".into(),
            scopes: None,
            access_ttl_seconds: None,
        };
        let printed = format!("{o:?}");
        assert!(!printed.contains("secretvalue") && printed.contains("briefcase"));
    }

    #[test]
    fn inputs_are_described_never_echoed() {
        let token = "sap_mqI4l7ytzQ6MKoosLLMHK52TUUOC1j_0nAIY1YnAdbc";
        assert_eq!(describe_input(token).as_deref(), Some("a proof token"));
        assert_eq!(describe_input("  ").as_deref(), Some("empty"));
        for wrapped in [
            format!("Bearer {token}"),
            format!("Proof {token}"),
            format!("token={token}"),
            format!("\"{token}\""),
            format!("proof: {token}, more"),
        ] {
            let d = describe_input(&wrapped).expect("described");
            assert!(d.starts_with("a proof token with other text"), "{d}");
            assert!(!d.contains(&token[4..]), "never echoes the token");
            assert!(!echo_safe(&wrapped));
        }
        assert!(
            describe_input("Bearer sapr_abc")
                .is_some_and(|d| d.starts_with("a proof refresh token with"))
        );
        assert!(describe_input("Bearer eyJhbGciOi.x.y").is_some_and(|d| d.contains("JWT")));
        assert_eq!(describe_input("nope"), None);
        assert_eq!(describe_input("01928c7e-3b7a-7c4e-9a51-2f3d4c5b6a7"), None);

        // Echoed: short id-like values.
        assert!(echo_safe("nope"));
        assert!(echo_safe("undefined"));
        assert!(echo_safe("01928c7e-3b7a-7c4e-9a51-2f3d4c5b6a7"));
        // Not echoed: anything that could be a credential.
        assert!(!echo_safe(token));
        assert!(
            !echo_safe(&token[4..]),
            "a token body without its prefix (43 chars)"
        );
        assert!(!echo_safe("stk-0123456789ab"));
        assert!(!echo_safe("xSTK-0123456789ab"));
        assert!(!echo_safe("0123456789ab"), "a bare STK");
        assert!(!echo_safe("eyJhbGciOi"));
        assert!(!echo_safe("with space"));
        assert!(!echo_safe(""));
        assert!(!echo_safe(&"a".repeat(41)));
    }

    #[test]
    fn revoke_reference() {
        let r = RevokeBody {
            proof_id: Some("x".into()),
            ..Default::default()
        };
        assert_eq!(r.reference(), Ok(ProofReference::Id("x".into())));
        assert!(RevokeBody::default().reference().is_err());
        let both = RevokeBody {
            proof_id: Some("x".into()),
            proof_token: Some("sap_y".into()),
            ..Default::default()
        };
        assert!(
            both.reference()
                .expect_err("two")
                .get("body")
                .is_some_and(|m| m.contains("exactly one"))
        );
        let empty = RevokeBody {
            proof_token: Some(" ".into()),
            ..Default::default()
        };
        assert!(
            empty
                .reference()
                .expect_err("empty")
                .get("proof_token")
                .is_some()
        );
    }
}
