//! Client metadata: IP, user agent, IP-derived timezone and Origin.

use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};

use axum::extract::{ConnectInfo, FromRef, FromRequestParts};
use axum::http::request::Parts;

use crate::config::Settings;
use crate::state::AppState;

/// Who is calling. `ip` comes from the socket (serve with
/// `into_make_service_with_connect_info::<SocketAddr>()`), or from the right-most
/// `X-Forwarded-For` entry when ACCOUNTS_TRUST_FORWARDED_FOR is true (the address the load
/// balancer appended; earlier entries can be forged by the client).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClientMeta {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    /// First valid IANA timezone from ACCOUNTS_IP_TIMEZONE_HEADERS.
    pub ip_timezone: Option<String>,
    pub origin: Option<String>,
}

impl ClientMeta {
    /// Extracts metadata from request parts.
    pub fn from_parts(parts: &Parts, settings: &Settings) -> ClientMeta {
        let headers = &parts.headers;
        let forwarded = if settings.trust_forwarded_for {
            headers
                .get_all("x-forwarded-for")
                .iter()
                .filter_map(|v| v.to_str().ok())
                .flat_map(|v| v.split(','))
                .map(str::trim)
                .rfind(|v| !v.is_empty())
                .and_then(|v| v.parse::<IpAddr>().ok())
                .map(|ip| ip.to_string())
        } else {
            None
        };
        let socket = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip().to_string());
        let ip_timezone = settings.ip_timezone_headers.iter().find_map(|h| {
            headers
                .get(h.as_str())
                .and_then(|v| v.to_str().ok())
                .and_then(|v| crate::normalize::normalize_timezone(v).ok())
        });
        ClientMeta {
            ip: forwarded.or(socket),
            user_agent: headers
                .get(axum::http::header::USER_AGENT)
                .and_then(|v| v.to_str().ok())
                .map(|v| v.chars().take(400).collect()),
            ip_timezone,
            origin: headers
                .get(axum::http::header::ORIGIN)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string),
        }
    }

    /// The IP or `"unknown"` (for rate-limit buckets).
    pub fn ip_or_unknown(&self) -> &str {
        self.ip.as_deref().unwrap_or("unknown")
    }
}

impl<S> FromRequestParts<S> for ClientMeta
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let state = AppState::from_ref(state);
        Ok(ClientMeta::from_parts(parts, &state.settings))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;

    fn parts(headers: &[(&str, &str)]) -> Parts {
        let mut b = Request::builder().uri("/x");
        for (k, v) in headers {
            b = b.header(*k, *v);
        }
        let (mut p, _) = b.body(()).expect("request").into_parts();
        p.extensions
            .insert(ConnectInfo(SocketAddr::from(([10, 0, 0, 9], 4000))));
        p
    }

    #[test]
    fn ip_from_socket_unless_forwarding_is_trusted() {
        let mut s = Settings::for_tests();
        let p = parts(&[
            ("x-forwarded-for", "6.6.6.6, 203.0.113.7"),
            ("user-agent", "curl/8"),
        ]);
        let m = ClientMeta::from_parts(&p, &s);
        assert_eq!(m.ip.as_deref(), Some("10.0.0.9"));
        assert_eq!(m.user_agent.as_deref(), Some("curl/8"));
        s.trust_forwarded_for = true;
        assert_eq!(
            ClientMeta::from_parts(&p, &s).ip.as_deref(),
            Some("203.0.113.7")
        );
    }

    #[test]
    fn timezone_from_headers() {
        let s = Settings::for_tests();
        let p = parts(&[
            ("cloudfront-viewer-time-zone", "Mars/Base"),
            ("x-vercel-ip-timezone", "asia/kolkata"),
        ]);
        assert_eq!(
            ClientMeta::from_parts(&p, &s).ip_timezone.as_deref(),
            Some("Asia/Kolkata")
        );
    }
}
