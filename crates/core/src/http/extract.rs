//! Input extractors whose rejections are [`ApiError`]s with precise messages.
//!
//! - [`Json<T>`]: body must be JSON (`Content-Type: application/json`; an empty body counts as
//!   `{}`). Syntax errors → 400 `invalid_json` (with line/column); wrong or missing fields → 422
//!   `validation_failed` with `details.fields` keyed by path. Also an `IntoResponse` for output.
//! - [`Query<T>`]: query string → 400 `invalid_query` naming the parameter.
//! - [`Path<T>`]: path parameters → 400 `invalid_path`.
//! - [`parse_form_or_json`]: for `/v1/oauth/*`, which accept form-urlencoded or JSON bodies.

use axum::body::Bytes;
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::header::CONTENT_TYPE;
use axum::http::request::Parts;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::error::{ApiError, FieldErrors};

/// JSON body extractor / JSON response (see module docs).
#[derive(Debug, Clone, Copy, Default)]
pub struct Json<T>(pub T);

fn is_json_content_type(headers: &HeaderMap) -> Option<bool> {
    let ct = headers.get(CONTENT_TYPE)?.to_str().ok()?;
    let mime = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    Some(
        mime == "application/json" || (mime.starts_with("application/") && mime.ends_with("+json")),
    )
}

/// Turns a serde_path_to_error JSON failure into the API error.
fn json_error(e: serde_path_to_error::Error<serde_json::Error>) -> ApiError {
    let inner = e.inner();
    use serde_json::error::Category;
    match inner.classify() {
        Category::Syntax | Category::Eof | Category::Io => ApiError::bad_request(
            "invalid_json",
            format!("The request body is not valid JSON: {inner}."),
        )
        .hint("Send a JSON object, for example {\"display_name\":\"Saket\"}."),
        Category::Data => {
            let mut path = e.path().to_string();
            if path == "." {
                path.clear();
            }
            let message = strip_position(&inner.to_string());
            // "missing field `x`" at the root is about field `x`.
            let field_path = match message
                .strip_prefix("missing field `")
                .and_then(|r| r.strip_suffix('`'))
            {
                Some(field) if path.is_empty() => field.to_string(),
                Some(field) => format!("{path}.{field}"),
                None if path.is_empty() => "body".to_string(),
                None => path,
            };
            let mut fields = FieldErrors::new();
            fields.add(field_path, message);
            ApiError::validation(fields)
        }
    }
}

fn strip_position(m: &str) -> String {
    match m.find(" at line ") {
        Some(i) => m[..i].to_string(),
        None => m.to_string(),
    }
}

/// Parses JSON bytes into `T` with the API's error mapping (empty = `{}`).
pub fn parse_json<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, ApiError> {
    let body: &[u8] = if bytes.iter().all(u8::is_ascii_whitespace) {
        b"{}"
    } else {
        bytes
    };
    let mut de = serde_json::Deserializer::from_slice(body);
    let value = serde_path_to_error::deserialize(&mut de).map_err(json_error)?;
    de.end().map_err(|e| {
        ApiError::bad_request(
            "invalid_json",
            format!("The request body has extra data after the JSON value: {e}."),
        )
    })?;
    Ok(value)
}

impl<T, S> FromRequest<S> for Json<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        let json_ct = is_json_content_type(req.headers());
        let content_type = req
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = Bytes::from_request(req, state).await.map_err(|rejection| {
            let status = rejection.status();
            if status == StatusCode::PAYLOAD_TOO_LARGE {
                ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "payload_too_large",
                    "The request body is too large.",
                )
                .hint("Bodies are limited to 64 KB (2 MB for photos, 50 MB for imports).")
            } else {
                ApiError::bad_request(
                    "invalid_body",
                    format!(
                        "The request body could not be read: {}.",
                        rejection.body_text()
                    ),
                )
            }
        })?;
        if !bytes.iter().all(u8::is_ascii_whitespace) && json_ct != Some(true) {
            return Err(ApiError::bad_request(
                "invalid_content_type",
                if content_type.is_empty() {
                    "The request has a body but no Content-Type; this endpoint takes JSON."
                        .to_string()
                } else {
                    format!("The request body is '{content_type}', but this endpoint takes JSON.")
                },
            )
            .hint("Send the body as JSON with the header Content-Type: application/json."));
        }
        parse_json(&bytes).map(Json)
    }
}

impl<T: Serialize> IntoResponse for Json<T> {
    fn into_response(self) -> Response {
        axum::Json(self.0).into_response()
    }
}

/// Query-string extractor (400 `invalid_query` naming the parameter).
#[derive(Debug, Clone, Copy, Default)]
pub struct Query<T>(pub T);

/// Parses a query string into `T` with the API's error mapping.
pub fn parse_query<T: DeserializeOwned>(query: &str) -> Result<T, ApiError> {
    let de = serde_urlencoded::Deserializer::new(url::form_urlencoded::parse(query.as_bytes()));
    serde_path_to_error::deserialize(de).map_err(|e| {
        let path = e.path().to_string();
        let message = e.inner().to_string();
        let message = match message
            .strip_prefix("missing field `")
            .and_then(|r| r.strip_suffix('`'))
        {
            Some(field) => format!("the query parameter '{field}' is required"),
            None if path.is_empty() || path == "." => message,
            None => format!("the query parameter '{path}' is invalid: {message}"),
        };
        ApiError::bad_request(
            "invalid_query",
            format!("The query string is invalid: {message}."),
        )
        .hint("Check the parameter names and values in the URL.")
    })
}

impl<T, S> FromRequestParts<S> for Query<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parse_query(parts.uri.query().unwrap_or("")).map(Query)
    }
}

/// Path-parameter extractor (400 `invalid_path`).
#[derive(Debug, Clone, Copy, Default)]
pub struct Path<T>(pub T);

impl<T, S> FromRequestParts<S> for Path<T>
where
    T: DeserializeOwned + Send,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        match axum::extract::Path::<T>::from_request_parts(parts, state).await {
            Ok(axum::extract::Path(v)) => Ok(Path(v)),
            Err(rejection) => Err(ApiError::bad_request(
                "invalid_path",
                format!("The URL path is invalid: {}.", rejection.body_text()),
            )
            .hint("Check the ids in the URL.")),
        }
    }
}

/// Parses a form-urlencoded or JSON body (by Content-Type; form when absent) into `T`.
/// Returns a plain message for the caller to wrap (e.g. `OAuthError::invalid_request`).
pub fn parse_form_or_json<T: DeserializeOwned>(
    headers: &HeaderMap,
    body: &[u8],
) -> Result<T, String> {
    if is_json_content_type(headers) == Some(true) {
        let mut de = serde_json::Deserializer::from_slice(body);
        serde_path_to_error::deserialize(&mut de).map_err(|e| {
            let path = e.path().to_string();
            let msg = strip_position(&e.inner().to_string());
            if path.is_empty() || path == "." {
                format!("the JSON body is invalid: {msg}")
            } else {
                format!("'{path}' is invalid: {msg}")
            }
        })
    } else {
        let de = serde_urlencoded::Deserializer::new(url::form_urlencoded::parse(body));
        serde_path_to_error::deserialize(de).map_err(|e| {
            let msg = e.inner().to_string();
            match msg
                .strip_prefix("missing field `")
                .and_then(|r| r.strip_suffix('`'))
            {
                Some(field) => format!("the parameter '{field}' is required"),
                None => format!("the form body is invalid: {msg}"),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use serde::Deserialize;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Body1 {
        display_name: String,
        #[serde(default)]
        timezone: Option<String>,
        nested: Option<Inner>,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    struct Inner {
        radius: u32,
    }

    async fn extract(ct: Option<&str>, body: &'static str) -> Result<Json<Body1>, ApiError> {
        let mut b = Request::builder().method("POST").uri("/x");
        if let Some(ct) = ct {
            b = b.header(CONTENT_TYPE, ct);
        }
        let req = b.body(Body::from(body)).expect("request");
        Json::<Body1>::from_request(req, &()).await
    }

    #[tokio::test]
    async fn json_errors_are_precise() {
        let ok = extract(Some("application/json"), r#"{"display_name":"Saket"}"#)
            .await
            .expect("ok");
        assert_eq!(ok.0.display_name, "Saket");

        let e = extract(Some("application/json"), r#"{"display_name":"#)
            .await
            .expect_err("syntax");
        assert_eq!(e.code, "invalid_json");
        assert_eq!(e.status, StatusCode::BAD_REQUEST);

        let e = extract(Some("application/json"), r#"{"timezone":"UTC"}"#)
            .await
            .expect_err("missing");
        assert_eq!(e.code, "validation_failed");
        assert_eq!(
            e.details["fields"]["display_name"],
            "missing field `display_name`"
        );

        let e = extract(
            Some("application/json"),
            r#"{"display_name":"x","nested":{"radius":"big"}}"#,
        )
        .await
        .expect_err("type");
        assert!(
            e.details["fields"]["nested.radius"]
                .as_str()
                .is_some_and(|m| m.contains("invalid type")),
            "{:?}",
            e.details
        );

        let e = extract(Some("text/plain"), r#"{"display_name":"x"}"#)
            .await
            .expect_err("content type");
        assert_eq!(e.code, "invalid_content_type");

        let e = extract(None, "")
            .await
            .expect_err("empty body is {} and display_name is missing");
        assert_eq!(e.code, "validation_failed");
    }

    #[test]
    fn query_errors_name_the_parameter() {
        #[derive(Debug, Deserialize)]
        struct Q {
            id: String,
            #[allow(dead_code)]
            limit: Option<u32>,
        }
        let q: Q = parse_query("id=c%3Asaket&limit=5").expect("ok");
        assert_eq!(q.id, "c:saket");
        let e = parse_query::<Q>("limit=5").expect_err("missing");
        assert!(e.message.contains("'id' is required"), "{}", e.message);
        let e = parse_query::<Q>("id=x&limit=lots").expect_err("type");
        assert!(e.message.contains("'limit'"), "{}", e.message);
    }

    #[test]
    fn form_or_json() {
        #[derive(Debug, Deserialize)]
        struct T {
            grant_type: String,
        }
        let mut h = HeaderMap::new();
        let t: T = parse_form_or_json(&h, b"grant_type=refresh_token").expect("form");
        assert_eq!(t.grant_type, "refresh_token");
        h.insert(CONTENT_TYPE, "application/json".parse().expect("hv"));
        let t: T = parse_form_or_json(&h, br#"{"grant_type":"slt"}"#).expect("json");
        assert_eq!(t.grant_type, "slt");
        let e = parse_form_or_json::<T>(&HeaderMap::new(), b"code=x").expect_err("missing");
        assert!(e.contains("'grant_type' is required"));
    }
}
