//! Default profile photos from Iris.

use crate::models::AccountKind;

/// The default Iris profile photo for an account: `{iris}/pfp/carbon?id={uuid}` or
/// `{iris}/pfp/silicon?id={uuid}`.
pub fn default_pfp_url(iris_base_url: &str, kind: AccountKind, uuid: &str) -> String {
    let base = iris_base_url.trim_end_matches('/');
    format!(
        "{base}/pfp/{}?id={}",
        kind.as_str(),
        percent_encoding::utf8_percent_encode(uuid, percent_encoding::NON_ALPHANUMERIC)
    )
}

/// True when `url` is the Iris default photo (so "reset photo" and imports can tell them apart).
pub fn is_default_pfp(iris_base_url: &str, url: &str) -> bool {
    let base = iris_base_url.trim_end_matches('/');
    url.starts_with(&format!("{base}/pfp/carbon?id="))
        || url.starts_with(&format!("{base}/pfp/silicon?id="))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_urls() {
        assert_eq!(
            default_pfp_url(
                "https://iris.teamofsilicons.com/",
                AccountKind::Carbon,
                "a8K"
            ),
            "https://iris.teamofsilicons.com/pfp/carbon?id=a8K"
        );
        let s = default_pfp_url(
            "https://iris.teamofsilicons.com",
            AccountKind::Silicon,
            "Zz9",
        );
        assert_eq!(s, "https://iris.teamofsilicons.com/pfp/silicon?id=Zz9");
        assert!(is_default_pfp("https://iris.teamofsilicons.com", &s));
        assert!(!is_default_pfp(
            "https://iris.teamofsilicons.com",
            "https://cdn.example.com/me.png"
        ));
    }
}
