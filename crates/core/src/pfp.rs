//! Profile photos: the default ones from Iris, and the photos this service serves
//! (`{PUBLIC_URL}/v1/photos/{photo_id}`, uploaded with `POST /v1/me/photo`).
//!
//! Which uploaded photo an account may show, and deleting uploads nobody shows any more, are in
//! `repo::photos`.

use uuid::Uuid;

use crate::config::Settings;
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

/// The URL prefix of photos served by this service: `{PUBLIC_URL}/v1/photos/`.
pub fn photo_url_prefix(settings: &Settings) -> String {
    format!("{}/v1/photos/", settings.public_url)
}

/// The URL of an uploaded photo, exactly as `POST /v1/me/photo` returns it.
pub fn photo_url(settings: &Settings, photo_id: Uuid) -> String {
    format!("{}{}", photo_url_prefix(settings), photo_id.hyphenated())
}

/// What a `pfp_url` says about this service's own photos.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PhotoRef {
    /// Not a URL under `{PUBLIC_URL}/v1/photos/`.
    External,
    /// Exactly `{PUBLIC_URL}/v1/photos/{id}` with the id lowercase and hyphenated: the form
    /// `POST /v1/me/photo` returns, and the only form photo pruning recognizes.
    Exact(Uuid),
    /// Under the photos prefix but not in that exact form; the message says why and names the
    /// exact URL to use when there is one.
    Inexact(String),
}

/// Classifies a `pfp_url`. Other spellings of a photo URL (a `?query`, a `#fragment`, an extra
/// path, an upper-case or unhyphenated id) would still load the photo, but pruning compares
/// URLs exactly and would delete the photo they point at, so they are refused.
pub fn photo_ref(settings: &Settings, url: &str) -> PhotoRef {
    let prefix = photo_url_prefix(settings);
    let Some(rest) = url.strip_prefix(&prefix) else {
        return PhotoRef::External;
    };
    let (id_part, extra) = match rest.find(['?', '#', '/']) {
        Some(i) => rest.split_at(i),
        None => (rest, ""),
    };
    match Uuid::try_parse(id_part) {
        Ok(id) => {
            let exact = id.hyphenated().to_string();
            if extra.is_empty() && id_part == exact {
                PhotoRef::Exact(id)
            } else {
                PhotoRef::Inexact(format!(
                    "{} is not written the way photo URLs are issued; use {prefix}{exact} exactly (a lowercase photo id with no query string, #fragment or extra path)",
                    clip(url, 160)
                ))
            }
        }
        Err(_) => PhotoRef::Inexact(format!(
            "{} doesn't name a photo: photo URLs are {prefix}{{photo_id}}, exactly as POST /v1/me/photo returns them",
            clip(url, 160)
        )),
    }
}

/// Shortens echoed input so messages stay readable.
fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}…")
    }
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

    #[test]
    fn photo_urls_must_be_written_exactly() {
        let s = Settings::for_tests();
        let prefix = photo_url_prefix(&s);
        let id = Uuid::now_v7();
        let exact = photo_url(&s, id);
        assert_eq!(exact, format!("{prefix}{id}"));
        assert_eq!(photo_ref(&s, &exact), PhotoRef::Exact(id));
        assert_eq!(
            photo_ref(&s, "https://cdn.example.com/me.png"),
            PhotoRef::External
        );
        for variant in [
            format!("{exact}?v=2"),
            format!("{exact}#x"),
            format!("{exact}/"),
            format!("{prefix}{}", id.to_string().to_uppercase()),
            format!("{prefix}{}", id.simple()),
            format!("{prefix}{}", id.urn()),
        ] {
            match photo_ref(&s, &variant) {
                PhotoRef::Inexact(m) => assert!(m.contains(&exact), "{variant}: {m}"),
                other => panic!("{variant} was taken as {other:?}"),
            }
        }
        for junk in [
            format!("{prefix}nope"),
            prefix.clone(),
            format!("{prefix}?x"),
        ] {
            match photo_ref(&s, &junk) {
                PhotoRef::Inexact(m) => assert!(m.contains("doesn't name a photo"), "{m}"),
                other => panic!("{junk} was taken as {other:?}"),
            }
        }
    }
}
