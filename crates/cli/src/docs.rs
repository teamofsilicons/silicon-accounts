//! Docs bundled into the binary (`accounts docs [topic]`), so they always match the CLI.

/// (topic, one-line summary, content)
pub const TOPICS: &[(&str, &str, &str)] = &[
    (
        "getting-started",
        "Sign in, check who you are, and the first commands to run",
        include_str!("../docs/getting-started.md"),
    ),
    (
        "silicons",
        "How a Silicon gets an account, signs in, and signs into apps",
        include_str!("../docs/silicons.md"),
    ),
    (
        "custodians",
        "Being a Silicon's custodian: accept, rotate STKs, transfer, delete",
        include_str!("../docs/custodians.md"),
    ),
    (
        "apps",
        "Add sign-in to an app: hosted pages, iframe, snippet, tokens, user base",
        include_str!("../docs/apps.md"),
    ),
    (
        "proofs",
        "OBO and ATA proofs: issue, verify, refresh, revoke",
        include_str!("../docs/proofs.md"),
    ),
    (
        "webhooks",
        "App and Silicon webhooks: events, signatures, retries, replay",
        include_str!("../docs/webhooks.md"),
    ),
    (
        "imports",
        "Bring an app's existing users: columns, matching, outcomes",
        include_str!("../docs/imports.md"),
    ),
    (
        "ids",
        "uuid vs c:id / si:id, id rules, reservations, membership ids",
        include_str!("../docs/ids.md"),
    ),
    (
        "troubleshooting",
        "Exit codes, error codes and how to fix the common ones",
        include_str!("../docs/troubleshooting.md"),
    ),
    (
        "links",
        "GitHub repo, online docs, the Rust package",
        include_str!("../docs/links.md"),
    ),
];

/// The content of a topic (accepts a few aliases).
pub fn find(topic: &str) -> Option<(&'static str, &'static str)> {
    let wanted = topic.trim().to_ascii_lowercase().replace([' ', '_'], "-");
    let wanted = match wanted.as_str() {
        "start" | "getting" | "intro" | "login" | "quickstart" => "getting-started",
        "silicon" | "stk" => "silicons",
        "custodian" | "transfer" => "custodians",
        "app" | "sign-in" | "signin" | "oauth" | "tokens" => "apps",
        "proof" | "obo" | "ata" => "proofs",
        "webhook" | "events" => "webhooks",
        "import" => "imports",
        "id" | "uuid" | "identifiers" => "ids",
        "errors" | "exit-codes" | "help" => "troubleshooting",
        "link" | "repo" | "github" | "crate" => "links",
        other => other,
    };
    TOPICS
        .iter()
        .find(|(name, _, _)| *name == wanted)
        .map(|(name, _, content)| (*name, *content))
}

/// The topic list as text.
pub fn index() -> String {
    let width = TOPICS.iter().map(|(n, _, _)| n.len()).max().unwrap_or(0);
    let mut text = String::from("Bundled docs (accounts docs <topic>):\n\n");
    for (name, summary, _) in TOPICS {
        text.push_str(&format!("  {name:<width$}  {summary}\n"));
    }
    text.push_str("\nOnline: https://account.teamofsilicons.com/docs\n");
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_topic_has_content_and_aliases_resolve() {
        for (name, summary, content) in TOPICS {
            assert!(!summary.is_empty());
            assert!(content.starts_with("# "), "{name} must start with a title");
            assert!(content.len() > 400, "{name} is too short");
            for banned in [
                "organisation",
                "organization",
                "frontend",
                "backend",
                " AI ",
                "human",
            ] {
                assert!(
                    !content.contains(banned),
                    "{name} uses banned vocabulary `{banned}`"
                );
            }
        }
        assert_eq!(find("silicon").map(|(n, _)| n), Some("silicons"));
        assert_eq!(find("OBO").map(|(n, _)| n), Some("proofs"));
        assert!(find("nope").is_none());
    }
}
