//! The per-app sign-in configuration document (`app_signin_configs.config`).
//!
//! - [`SigninConfig::default`] is the documented default; every field has a serde default so a
//!   partial document loads.
//! - [`SigninConfig::from_stored`] loads a stored document leniently (never fails).
//! - [`SigninConfig::apply_patch`] deep-merges a PATCH body (objects merge, arrays and scalars
//!   replace, `null` resets a field to its default), rejects unknown keys, reports type errors
//!   with their path, normalizes and validates — returning [`FieldErrors`] keyed by path such as
//!   `branding.light.primary`.
//! - [`SigninConfig::effective`] applies the first-party rules for app `accounts`.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

use super::{ContactField, Method, text_enum};
use crate::config::Settings;
use crate::error::FieldErrors;

text_enum! {
    /// One-click (our credentials) or bring-your-own provider credentials.
    pub enum ProviderMode {
        Managed = "managed",
        Byo = "byo",
    }
}

text_enum! {
    /// Colour theme of the hosted pages.
    pub enum Theme {
        Auto = "auto",
        Light = "light",
        Dark = "dark",
    }
}

text_enum! {
    /// Font allowlist for branded pages.
    pub enum FontFamily {
        Geist = "Geist",
        Inter = "Inter",
        IbmPlexSans = "IBM Plex Sans",
        DmSans = "DM Sans",
        SpaceGrotesk = "Space Grotesk",
        SourceSerif4 = "Source Serif 4",
        Fraunces = "Fraunces",
        InstrumentSerif = "Instrument Serif",
        JetBrainsMono = "JetBrains Mono",
        System = "System",
    }
}

text_enum! {
    /// Corner geometry of controls and panels.
    pub enum CornerStyle {
        Squircle = "squircle",
        Rounded = "rounded",
        Sharp = "sharp",
    }
}

text_enum! {
    /// Button fill style.
    pub enum ButtonStyle {
        Solid = "solid",
        Soft = "soft",
        Outline = "outline",
    }
}

text_enum! {
    /// Page layout of the hosted sign-in.
    pub enum Layout {
        Card = "card",
        Split = "split",
        Minimal = "minimal",
    }
}

text_enum! {
    /// Page background treatment.
    pub enum BackgroundStyle {
        Plain = "plain",
        Dots = "dots",
        Grain = "grain",
        Gradient = "gradient",
        Image = "image",
    }
}

text_enum! {
    /// Spacing density.
    pub enum Density {
        Comfortable = "comfortable",
        Compact = "compact",
    }
}

/// Which sign-in methods are switched on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Methods {
    pub email: bool,
    pub phone: bool,
    pub google: bool,
    pub apple: bool,
}

impl Default for Methods {
    fn default() -> Self {
        Methods {
            email: true,
            phone: false,
            google: false,
            apple: false,
        }
    }
}

impl Methods {
    pub fn is_enabled(&self, m: Method) -> bool {
        match m {
            Method::Email => self.email,
            Method::Phone => self.phone,
            Method::Google => self.google,
            Method::Apple => self.apple,
        }
    }

    pub fn set(&mut self, m: Method, on: bool) {
        match m {
            Method::Email => self.email = on,
            Method::Phone => self.phone = on,
            Method::Google => self.google = on,
            Method::Apple => self.apple = on,
        }
    }

    pub fn any(&self) -> bool {
        self.email || self.phone || self.google || self.apple
    }
}

/// Google settings of an app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct GoogleConfig {
    pub mode: ProviderMode,
    /// BYO OAuth client id (required when `mode` is `byo`).
    pub client_id: Option<String>,
    /// Google `prompt`: `select_account`, `consent`, `none` or `consent select_account`.
    pub prompt: Option<String>,
    /// Google `hd` (Workspace domain) hint.
    pub hosted_domain: Option<String>,
}

impl Default for GoogleConfig {
    fn default() -> Self {
        GoogleConfig {
            mode: ProviderMode::Managed,
            client_id: None,
            prompt: Some("select_account".into()),
            hosted_domain: None,
        }
    }
}

/// Apple settings of an app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppleConfig {
    pub mode: ProviderMode,
    pub services_id: Option<String>,
    pub team_id: Option<String>,
    pub key_id: Option<String>,
}

impl Default for AppleConfig {
    fn default() -> Self {
        AppleConfig {
            mode: ProviderMode::Managed,
            services_id: None,
            team_id: None,
            key_id: None,
        }
    }
}

/// One theme's colours, each `#RRGGBB`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Palette {
    pub primary: String,
    pub primary_foreground: String,
    pub background: String,
    pub surface: String,
    pub foreground: String,
    pub muted: String,
    pub border: String,
    pub danger: String,
}

impl Palette {
    /// The Silicon Accounts light palette.
    pub fn default_light() -> Palette {
        Palette {
            primary: "#1F5FB8".into(),
            primary_foreground: "#FFFDF9".into(),
            background: "#FFFDF9".into(),
            surface: "#FFFFFF".into(),
            foreground: "#353432".into(),
            muted: "#6F6B66".into(),
            border: "#E8E3DA".into(),
            danger: "#B42318".into(),
        }
    }

    /// The Silicon Accounts dark palette. Filled buttons keep the brand blue `#1F5FB8` under
    /// `#FFFDF9` text (6.1:1, WCAG AA for text); the lighter `#5B8FE0` is only an ink for links
    /// and accents on dark surfaces and would put button text at 3.2:1.
    pub fn default_dark() -> Palette {
        Palette {
            primary: "#1F5FB8".into(),
            primary_foreground: "#FFFDF9".into(),
            background: "#2A2927".into(),
            surface: "#353432".into(),
            foreground: "#FFFDF9".into(),
            muted: "#B5B0A8".into(),
            border: "#4A4845".into(),
            danger: "#F97066".into(),
        }
    }

    fn fields(&self) -> [(&'static str, &String); 8] {
        [
            ("primary", &self.primary),
            ("primary_foreground", &self.primary_foreground),
            ("background", &self.background),
            ("surface", &self.surface),
            ("foreground", &self.foreground),
            ("muted", &self.muted),
            ("border", &self.border),
            ("danger", &self.danger),
        ]
    }

    fn fields_mut(&mut self) -> [&mut String; 8] {
        [
            &mut self.primary,
            &mut self.primary_foreground,
            &mut self.background,
            &mut self.surface,
            &mut self.foreground,
            &mut self.muted,
            &mut self.border,
            &mut self.danger,
        ]
    }
}

/// A palette where missing colours fall back to the right theme's defaults.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct PaletteRaw {
    primary: Option<String>,
    primary_foreground: Option<String>,
    background: Option<String>,
    surface: Option<String>,
    foreground: Option<String>,
    muted: Option<String>,
    border: Option<String>,
    danger: Option<String>,
}

impl PaletteRaw {
    fn fill(self, base: Palette) -> Palette {
        Palette {
            primary: self.primary.unwrap_or(base.primary),
            primary_foreground: self.primary_foreground.unwrap_or(base.primary_foreground),
            background: self.background.unwrap_or(base.background),
            surface: self.surface.unwrap_or(base.surface),
            foreground: self.foreground.unwrap_or(base.foreground),
            muted: self.muted.unwrap_or(base.muted),
            border: self.border.unwrap_or(base.border),
            danger: self.danger.unwrap_or(base.danger),
        }
    }
}

/// Branding variables of the hosted pages. "Powered by Silicon Accounts" is not configurable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "BrandingRaw")]
pub struct Branding {
    pub theme: Theme,
    pub logo_url: Option<String>,
    pub logo_dark_url: Option<String>,
    /// 16..=96 px.
    pub logo_height: u32,
    pub show_app_name: bool,
    pub font_family: FontFamily,
    /// `None` = `font_family`.
    pub heading_font_family: Option<FontFamily>,
    pub corner_style: CornerStyle,
    /// 0..=40 px.
    pub radius: u32,
    pub button_style: ButtonStyle,
    pub layout: Layout,
    pub background_style: BackgroundStyle,
    /// https only; required when `background_style` is `image`.
    pub background_image_url: Option<String>,
    pub density: Density,
    pub light: Palette,
    pub dark: Palette,
}

impl Default for Branding {
    fn default() -> Self {
        Branding {
            theme: Theme::Auto,
            logo_url: None,
            logo_dark_url: None,
            logo_height: 36,
            show_app_name: true,
            font_family: FontFamily::Geist,
            heading_font_family: None,
            corner_style: CornerStyle::Squircle,
            radius: 18,
            button_style: ButtonStyle::Solid,
            layout: Layout::Card,
            background_style: BackgroundStyle::Plain,
            background_image_url: None,
            density: Density::Comfortable,
            light: Palette::default_light(),
            dark: Palette::default_dark(),
        }
    }
}

#[derive(Deserialize)]
#[serde(default)]
struct BrandingRaw {
    theme: Theme,
    logo_url: Option<String>,
    logo_dark_url: Option<String>,
    logo_height: u32,
    show_app_name: bool,
    font_family: FontFamily,
    heading_font_family: Option<FontFamily>,
    corner_style: CornerStyle,
    radius: u32,
    button_style: ButtonStyle,
    layout: Layout,
    background_style: BackgroundStyle,
    background_image_url: Option<String>,
    density: Density,
    light: PaletteRaw,
    dark: PaletteRaw,
}

impl Default for BrandingRaw {
    fn default() -> Self {
        let b = Branding::default();
        BrandingRaw {
            theme: b.theme,
            logo_url: b.logo_url,
            logo_dark_url: b.logo_dark_url,
            logo_height: b.logo_height,
            show_app_name: b.show_app_name,
            font_family: b.font_family,
            heading_font_family: b.heading_font_family,
            corner_style: b.corner_style,
            radius: b.radius,
            button_style: b.button_style,
            layout: b.layout,
            background_style: b.background_style,
            background_image_url: b.background_image_url,
            density: b.density,
            light: PaletteRaw::default(),
            dark: PaletteRaw::default(),
        }
    }
}

impl From<BrandingRaw> for Branding {
    fn from(r: BrandingRaw) -> Self {
        Branding {
            theme: r.theme,
            logo_url: r.logo_url,
            logo_dark_url: r.logo_dark_url,
            logo_height: r.logo_height,
            show_app_name: r.show_app_name,
            font_family: r.font_family,
            heading_font_family: r.heading_font_family,
            corner_style: r.corner_style,
            radius: r.radius,
            button_style: r.button_style,
            layout: r.layout,
            background_style: r.background_style,
            background_image_url: r.background_image_url,
            density: r.density,
            light: r.light.fill(Palette::default_light()),
            dark: r.dark.fill(Palette::default_dark()),
        }
    }
}

/// Texts and links on the hosted pages.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SigninCopy {
    /// ≤ 80 characters.
    pub title: Option<String>,
    /// ≤ 200 characters.
    pub subtitle: Option<String>,
    pub terms_url: Option<String>,
    pub privacy_url: Option<String>,
    pub support_email: Option<String>,
}

/// An app's whole sign-in configuration (no secrets).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SigninConfig {
    pub methods: Methods,
    pub method_order: Vec<Method>,
    pub google: GoogleConfig,
    pub apple: AppleConfig,
    pub redirect_uris: Vec<String>,
    /// Origins that may embed the iframe (frame-ancestors) and use the SDK.
    pub allowed_origins: Vec<String>,
    pub required_fields: Vec<ContactField>,
    pub optional_fields: Vec<ContactField>,
    /// `[]` = any domain; else only these may sign in via email/Google/Apple.
    pub allowed_email_domains: Vec<String>,
    /// `false` = only existing (or imported) accounts may sign in.
    pub allow_signup: bool,
    /// Offer "Continue as …" from the browser session.
    pub remember_browser: bool,
    pub branding: Branding,
    pub copy: SigninCopy,
}

impl Default for SigninConfig {
    fn default() -> Self {
        SigninConfig {
            methods: Methods::default(),
            method_order: vec![Method::Google, Method::Apple, Method::Email, Method::Phone],
            google: GoogleConfig::default(),
            apple: AppleConfig::default(),
            redirect_uris: Vec::new(),
            allowed_origins: Vec::new(),
            required_fields: Vec::new(),
            optional_fields: Vec::new(),
            allowed_email_domains: Vec::new(),
            allow_signup: true,
            remember_browser: true,
            branding: Branding::default(),
            copy: SigninCopy::default(),
        }
    }
}

/// Which BYO secrets are stored for an app (they live outside the document, encrypted).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ConfigSecretsPresent {
    pub google_client_secret: bool,
    pub apple_private_key: bool,
}

/// Smallest contrast ratio accepted for text on the hosted pages: button text
/// (`primary_foreground` on `primary`) and page text (`foreground` on `background`), in both
/// themes. 4.5:1 is WCAG 2 level AA for normal-size text; the default palettes meet it
/// (6.1:1 or more).
pub const MIN_TEXT_CONTRAST: f64 = 4.5;

/// Maximum list sizes.
pub const MAX_REDIRECT_URIS: usize = 50;
pub const MAX_ALLOWED_ORIGINS: usize = 50;
pub const MAX_EMAIL_DOMAINS: usize = 100;

impl SigninConfig {
    /// Loads a stored document. Never fails: anything unreadable falls back to defaults (and is
    /// logged), because a stored document was validated when it was saved.
    pub fn from_stored(value: &Value) -> SigninConfig {
        match serde_json::from_value::<SigninConfig>(value.clone()) {
            Ok(mut c) => {
                c.normalize();
                c
            }
            Err(e) => {
                tracing::error!(error = %e, "stored sign-in config does not parse; using defaults");
                SigninConfig::default()
            }
        }
    }

    /// Parses a complete document strictly: unknown keys and type errors are reported with their
    /// path, then the document is normalized and validated.
    pub fn parse_strict(
        value: &Value,
        secrets: ConfigSecretsPresent,
    ) -> Result<SigninConfig, FieldErrors> {
        let mut errors = FieldErrors::new();
        let template = serde_json::to_value(SigninConfig::default()).unwrap_or(Value::Null);
        unknown_keys(value, &template, "", &mut errors);
        if !errors.is_empty() {
            return Err(errors);
        }
        let mut config: SigninConfig = match serde_path_to_error::deserialize(value.clone()) {
            Ok(c) => c,
            Err(e) => {
                let path = e.path().to_string();
                let path = if path == "." { String::new() } else { path };
                errors.add(path, clean_serde_message(&e.inner().to_string()));
                return Err(errors);
            }
        };
        config.normalize();
        config.validate(secrets)?;
        Ok(config)
    }

    /// Applies a PATCH body to this document (see module docs) and returns the validated result.
    pub fn apply_patch(
        &self,
        patch: &Value,
        secrets: ConfigSecretsPresent,
    ) -> Result<SigninConfig, FieldErrors> {
        let mut errors = FieldErrors::new();
        if !patch.is_object() {
            errors.add("", "the sign-in config patch must be a JSON object");
            return Err(errors);
        }
        let template = serde_json::to_value(SigninConfig::default()).unwrap_or(Value::Null);
        unknown_keys(patch, &template, "", &mut errors);
        if !errors.is_empty() {
            return Err(errors);
        }
        let mut current = serde_json::to_value(self).unwrap_or_else(|_| Value::Object(Map::new()));
        merge_patch(&mut current, patch);
        SigninConfig::parse_strict(&current, secrets)
    }

    /// Canonicalizes the document: trims, drops empty strings, uppercases colours, dedupes lists,
    /// lowercases domains and completes `method_order`.
    pub fn normalize(&mut self) {
        let mut seen = BTreeSet::new();
        self.method_order.retain(|m| seen.insert(*m));
        for m in [Method::Google, Method::Apple, Method::Email, Method::Phone] {
            if !self.method_order.contains(&m) {
                self.method_order.push(m);
            }
        }
        for v in [
            &mut self.google.client_id,
            &mut self.google.prompt,
            &mut self.google.hosted_domain,
            &mut self.apple.services_id,
            &mut self.apple.team_id,
            &mut self.apple.key_id,
            &mut self.branding.logo_url,
            &mut self.branding.logo_dark_url,
            &mut self.branding.background_image_url,
            &mut self.copy.title,
            &mut self.copy.subtitle,
            &mut self.copy.terms_url,
            &mut self.copy.privacy_url,
            &mut self.copy.support_email,
        ] {
            trim_opt(v);
        }
        if let Some(d) = &mut self.google.hosted_domain {
            *d = d.to_ascii_lowercase();
        }
        if let Some(e) = &mut self.copy.support_email {
            *e = e.to_ascii_lowercase();
        }
        dedupe_strings(&mut self.redirect_uris, |s| s.trim().to_string());
        dedupe_strings(&mut self.allowed_origins, |s| {
            s.trim().trim_end_matches('/').to_string()
        });
        dedupe_strings(&mut self.allowed_email_domains, |s| {
            s.trim().trim_start_matches('@').to_ascii_lowercase()
        });
        let mut seen = BTreeSet::new();
        self.required_fields.retain(|f| seen.insert(*f));
        let mut seen = BTreeSet::new();
        self.optional_fields.retain(|f| seen.insert(*f));
        for palette in [&mut self.branding.light, &mut self.branding.dark] {
            for c in palette.fields_mut() {
                let t = c.trim();
                // Only canonicalize valid colours so errors quote what the caller sent.
                *c = if is_hex_colour(t) {
                    t.to_ascii_uppercase()
                } else {
                    t.to_string()
                };
            }
        }
    }

    /// Validates a normalized document. Errors are keyed by path.
    pub fn validate(&self, secrets: ConfigSecretsPresent) -> Result<(), FieldErrors> {
        let mut e = FieldErrors::new();

        if !self.methods.any() {
            e.add(
                "methods",
                "at least one sign-in method (email, phone, google or apple) must be enabled",
            );
        }

        // Google
        if let Some(p) = &self.google.prompt
            && ![
                "select_account",
                "consent",
                "none",
                "consent select_account",
                "select_account consent",
            ]
            .contains(&p.as_str())
        {
            e.add(
                "google.prompt",
                "must be select_account, consent, none or \"consent select_account\"",
            );
        }
        if let Some(d) = &self.google.hosted_domain
            && !is_valid_domain(d)
        {
            e.add(
                "google.hosted_domain",
                format!("'{d}' is not a domain name like example.com"),
            );
        }
        if self.google.mode == ProviderMode::Byo {
            match &self.google.client_id {
                None => e.add(
                    "google.client_id",
                    "is required when google.mode is byo (your Google OAuth client id)",
                ),
                Some(id) if id.len() > 255 => {
                    e.add("google.client_id", "must be at most 255 characters")
                }
                Some(_) => {}
            }
            if !secrets.google_client_secret {
                e.add(
                    "google.client_secret",
                    "is required when google.mode is byo; send it as {\"google\":{\"client_secret\":\"…\"}}",
                );
            }
        }

        // Apple
        if self.apple.mode == ProviderMode::Byo {
            match &self.apple.services_id {
                None => e.add("apple.services_id", "is required when apple.mode is byo (your Services ID, e.g. com.example.signin)"),
                Some(s) if s.len() > 255 => e.add("apple.services_id", "must be at most 255 characters"),
                Some(_) => {}
            }
            for (path, value) in [
                ("apple.team_id", &self.apple.team_id),
                ("apple.key_id", &self.apple.key_id),
            ] {
                match value {
                    None => e.add(path, "is required when apple.mode is byo (10 characters, from your Apple developer account)"),
                    Some(v) if v.len() != 10 || !v.chars().all(|c| c.is_ascii_alphanumeric()) => {
                        e.add(path, format!("'{v}' must be exactly 10 letters or digits"))
                    }
                    Some(_) => {}
                }
            }
            if !secrets.apple_private_key {
                e.add(
                    "apple.private_key",
                    "is required when apple.mode is byo; send the .p8 key as {\"apple\":{\"private_key\":\"-----BEGIN PRIVATE KEY-----…\"}}",
                );
            }
        }

        // Redirect URIs and origins
        if self.redirect_uris.len() > MAX_REDIRECT_URIS {
            e.add(
                "redirect_uris",
                format!("at most {MAX_REDIRECT_URIS} redirect URIs are allowed"),
            );
        }
        for (i, uri) in self.redirect_uris.iter().enumerate() {
            if let Err(msg) = validate_redirect_uri(uri) {
                e.add(format!("redirect_uris[{i}]"), msg);
            }
        }
        if self.allowed_origins.len() > MAX_ALLOWED_ORIGINS {
            e.add(
                "allowed_origins",
                format!("at most {MAX_ALLOWED_ORIGINS} origins are allowed"),
            );
        }
        for (i, o) in self.allowed_origins.iter().enumerate() {
            if let Err(msg) = validate_origin(o) {
                e.add(format!("allowed_origins[{i}]"), msg);
            }
        }

        // Fields
        for f in &self.optional_fields {
            if self.required_fields.contains(f) {
                e.add(
                    "optional_fields",
                    format!(
                        "'{f}' is also in required_fields; a field is either required or optional"
                    ),
                );
            }
        }

        // Domains
        if self.allowed_email_domains.len() > MAX_EMAIL_DOMAINS {
            e.add(
                "allowed_email_domains",
                format!("at most {MAX_EMAIL_DOMAINS} domains are allowed"),
            );
        }
        for (i, d) in self.allowed_email_domains.iter().enumerate() {
            if !is_valid_domain(d) {
                e.add(
                    format!("allowed_email_domains[{i}]"),
                    format!("'{d}' is not a domain name like example.com"),
                );
            }
        }

        validate_branding(&self.branding, &mut e);

        // Copy
        if let Some(t) = &self.copy.title {
            if t.chars().count() > 80 {
                e.add("copy.title", "must be at most 80 characters");
            }
            if t.chars().any(char::is_control) {
                e.add("copy.title", "must not contain control characters");
            }
        }
        if let Some(t) = &self.copy.subtitle {
            if t.chars().count() > 200 {
                e.add("copy.subtitle", "must be at most 200 characters");
            }
            if t.chars().any(char::is_control) {
                e.add("copy.subtitle", "must not contain control characters");
            }
        }
        for (path, v) in [
            ("copy.terms_url", &self.copy.terms_url),
            ("copy.privacy_url", &self.copy.privacy_url),
        ] {
            if let Some(u) = v
                && let Err(msg) = crate::normalize::validate_https_url(u)
            {
                e.add(path, msg);
            }
        }
        if let Some(email) = &self.copy.support_email
            && let Err(err) = crate::normalize::normalize_email(email)
        {
            e.add("copy.support_email", err.to_string());
        }

        e.into_ok()
    }

    /// Applies first-party rules for app `accounts`: email + phone always on, Google/Apple only
    /// when managed credentials exist, no required fields, signup allowed, redirect URIs on the
    /// public URL.
    pub fn effective(mut self, settings: &Settings, app_id: &str) -> SigninConfig {
        if app_id == crate::FIRST_PARTY_APP_ID {
            self.methods = Methods {
                email: true,
                phone: true,
                google: settings.google.managed_configured(),
                apple: settings.apple.managed_configured(),
            };
            self.google.mode = ProviderMode::Managed;
            self.apple.mode = ProviderMode::Managed;
            self.redirect_uris = vec![format!("{}/", settings.public_url)];
            self.required_fields.clear();
            self.optional_fields.clear();
            self.allowed_email_domains.clear();
            self.allow_signup = true;
        }
        self
    }

    /// Enabled methods in configured order, dropping managed Google/Apple when the service has no
    /// managed credentials (the button would only fail).
    pub fn available_methods(&self, settings: &Settings) -> Vec<Method> {
        self.method_order
            .iter()
            .copied()
            .filter(|m| self.methods.is_enabled(*m))
            .filter(|m| match m {
                Method::Google => match self.google.mode {
                    ProviderMode::Managed => settings.google.managed_configured(),
                    ProviderMode::Byo => self.google.client_id.is_some(),
                },
                Method::Apple => match self.apple.mode {
                    ProviderMode::Managed => settings.apple.managed_configured(),
                    ProviderMode::Byo => self.apple.services_id.is_some(),
                },
                _ => true,
            })
            .collect()
    }

    /// True when the app requires this field.
    pub fn requires(&self, f: ContactField) -> bool {
        self.required_fields.contains(&f)
    }

    /// True when `uri` may receive the authorization result for this app.
    /// First-party (`accounts`): any URL on the public origin or an extra allowed origin.
    pub fn redirect_allowed(&self, settings: &Settings, app_id: &str, uri: &str) -> bool {
        if app_id == crate::FIRST_PARTY_APP_ID {
            first_party_redirect_allowed(settings, uri)
        } else {
            redirect_uri_matches(&self.redirect_uris, uri)
        }
    }

    /// True when an email domain may sign in to this app.
    pub fn email_domain_allowed(&self, email: &str) -> bool {
        if self.allowed_email_domains.is_empty() {
            return true;
        }
        let domain = email
            .rsplit_once('@')
            .map(|(_, d)| d.to_ascii_lowercase())
            .unwrap_or_default();
        self.allowed_email_domains.contains(&domain)
    }
}

impl FieldErrors {
    fn into_ok(self) -> Result<(), FieldErrors> {
        if self.is_empty() { Ok(()) } else { Err(self) }
    }
}

fn trim_opt(v: &mut Option<String>) {
    if let Some(s) = v {
        let t = s.trim();
        if t.is_empty() {
            *v = None;
        } else if t.len() != s.len() {
            *v = Some(t.to_string());
        }
    }
}

fn dedupe_strings(list: &mut Vec<String>, f: impl Fn(&str) -> String) {
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(list.len());
    for s in list.iter() {
        let n = f(s);
        if !n.is_empty() && seen.insert(n.clone()) {
            out.push(n);
        }
    }
    *list = out;
}

fn clean_serde_message(m: &str) -> String {
    // serde_json appends " at line X column Y" for text input; values have no position.
    match m.find(" at line ") {
        Some(i) => m[..i].to_string(),
        None => m.to_string(),
    }
}

/// Deep-merges `patch` into `target`: objects merge recursively, arrays and scalars replace, and
/// `null` removes the key (the field returns to its default).
pub fn merge_patch(target: &mut Value, patch: &Value) {
    match (target, patch) {
        (Value::Object(t), Value::Object(p)) => {
            for (k, v) in p {
                if v.is_null() {
                    t.remove(k);
                } else if let Some(existing) = t.get_mut(k) {
                    if existing.is_object() && v.is_object() {
                        merge_patch(existing, v);
                    } else {
                        *existing = v.clone();
                    }
                } else {
                    t.insert(k.clone(), v.clone());
                }
            }
        }
        (t, p) => *t = p.clone(),
    }
}

/// Reports every key of `value` that the template (a fully serialized default) does not have.
fn unknown_keys(value: &Value, template: &Value, path: &str, errors: &mut FieldErrors) {
    let (Value::Object(v), Value::Object(t)) = (value, template) else {
        return;
    };
    for (k, child) in v {
        let child_path = if path.is_empty() {
            k.clone()
        } else {
            format!("{path}.{k}")
        };
        match t.get(k) {
            None => {
                // BYO secrets ride along in PATCH bodies; the apps crate strips them before this.
                let allowed: Vec<&str> = t.keys().map(String::as_str).collect();
                errors.add(
                    child_path,
                    format!(
                        "unknown field; allowed fields here are {}",
                        allowed.join(", ")
                    ),
                );
            }
            Some(tchild) => unknown_keys(child, tchild, &child_path, errors),
        }
    }
}

fn validate_branding(b: &Branding, e: &mut FieldErrors) {
    if !(16..=96).contains(&b.logo_height) {
        e.add(
            "branding.logo_height",
            format!(
                "is {} but must be between 16 and 96 (pixels)",
                b.logo_height
            ),
        );
    }
    if b.radius > 40 {
        e.add(
            "branding.radius",
            format!("is {} but must be between 0 and 40 (pixels)", b.radius),
        );
    }
    for (path, v) in [
        ("branding.logo_url", &b.logo_url),
        ("branding.logo_dark_url", &b.logo_dark_url),
    ] {
        if let Some(u) = v
            && let Err(msg) = validate_logo_url(u)
        {
            e.add(path, msg);
        }
    }
    match (&b.background_style, &b.background_image_url) {
        (BackgroundStyle::Image, None) => e.add(
            "branding.background_image_url",
            "is required when branding.background_style is image (an https URL)",
        ),
        (_, Some(u)) => {
            if let Err(msg) = crate::normalize::validate_https_url(u) {
                e.add("branding.background_image_url", msg);
            }
        }
        _ => {}
    }
    for (theme, palette) in [("light", &b.light), ("dark", &b.dark)] {
        let mut colours_ok = true;
        for (name, value) in palette.fields() {
            if !is_hex_colour(value) {
                colours_ok = false;
                e.add(
                    format!("branding.{theme}.{name}"),
                    format!("'{value}' must be a #RRGGBB colour"),
                );
            }
        }
        if colours_ok {
            for (fg_name, fg, bg_name, bg, why) in [
                (
                    "primary_foreground",
                    &palette.primary_foreground,
                    "primary",
                    &palette.primary,
                    "button text must stay readable",
                ),
                (
                    "foreground",
                    &palette.foreground,
                    "background",
                    &palette.background,
                    "page text must stay readable",
                ),
            ] {
                if let Some(ratio) = contrast_ratio(fg, bg)
                    && ratio < MIN_TEXT_CONTRAST
                {
                    e.add(
                            format!("branding.{theme}.{fg_name}"),
                            format!(
                                "contrast between branding.{theme}.{fg_name} ({fg}) and branding.{theme}.{bg_name} ({bg}) is {:.2}:1; it must be at least 4.5:1 (WCAG AA for text) because {why}",
                                (ratio * 100.0).floor() / 100.0
                            ),
                        );
                }
            }
        }
    }
}

/// True for `#RRGGBB` (case-insensitive).
pub fn is_hex_colour(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn channel(hex: &str) -> Option<f64> {
    let v = u8::from_str_radix(hex, 16).ok()? as f64 / 255.0;
    Some(if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    })
}

fn luminance(colour: &str) -> Option<f64> {
    if !is_hex_colour(colour) {
        return None;
    }
    let r = channel(&colour[1..3])?;
    let g = channel(&colour[3..5])?;
    let b = channel(&colour[5..7])?;
    Some(0.2126 * r + 0.7152 * g + 0.0722 * b)
}

/// WCAG 2 contrast ratio between two `#RRGGBB` colours (1.0 ..= 21.0).
pub fn contrast_ratio(a: &str, b: &str) -> Option<f64> {
    let (la, lb) = (luminance(a)?, luminance(b)?);
    let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
    Some((hi + 0.05) / (lo + 0.05))
}

/// True for a syntactically valid lowercase domain name with a dot.
pub fn is_valid_domain(d: &str) -> bool {
    if d.is_empty() || d.len() > 253 || !d.contains('.') {
        return false;
    }
    d.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    })
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// Validates a registered redirect URI: https; http only on localhost, 127.0.0.1 or `[::1]`; or a
/// private-use scheme with a dot (RFC 8252, e.g. `com.example.app:/callback`). No fragments.
pub fn validate_redirect_uri(uri: &str) -> Result<(), String> {
    if uri.len() > 2048 {
        return Err("must be at most 2048 characters".into());
    }
    let u = Url::parse(uri).map_err(|_| {
        format!("'{uri}' is not an absolute URL like https://app.example.com/callback")
    })?;
    if u.fragment().is_some() {
        return Err(format!("'{uri}' must not contain a #fragment"));
    }
    match u.scheme() {
        "https" => {
            if u.host_str().is_none() {
                return Err(format!("'{uri}' has no host"));
            }
        }
        "http" => {
            if !u.host_str().is_some_and(is_loopback_host) {
                return Err(format!(
                    "'{uri}' uses http; only https is allowed, except http://localhost and http://127.0.0.1 for local development"
                ));
            }
        }
        "javascript" | "data" | "file" | "vbscript" | "blob" | "about" | "ftp" | "ws" | "wss" => {
            return Err(format!(
                "'{uri}' uses the {} scheme, which can't receive a sign-in result",
                u.scheme()
            ));
        }
        s if s.contains('.') => {}
        s => {
            return Err(format!(
                "'{uri}' uses the '{s}' scheme; use https, or a reverse-domain scheme like com.example.app:/callback for native apps"
            ));
        }
    }
    if u.username() != "" || u.password().is_some() {
        return Err(format!("'{uri}' must not contain credentials"));
    }
    Ok(())
}

/// Validates an allowed origin: `https://host[:port]` (or http on localhost), no path.
pub fn validate_origin(origin: &str) -> Result<(), String> {
    let u = Url::parse(origin)
        .map_err(|_| format!("'{origin}' is not an origin like https://app.example.com"))?;
    if u.path() != "/" || u.query().is_some() || u.fragment().is_some() {
        return Err(format!(
            "'{origin}' must be just scheme://host[:port], without a path"
        ));
    }
    match u.scheme() {
        "https" => Ok(()),
        "http" if u.host_str().is_some_and(is_loopback_host) => Ok(()),
        "http" => Err(format!(
            "'{origin}' uses http; only https is allowed (http only for localhost/127.0.0.1)"
        )),
        s => Err(format!(
            "'{origin}' uses the '{s}' scheme; origins must be https"
        )),
    }
}

/// Logo URLs: https, or an inline `data:image/...` URI of at most 128 KB.
fn validate_logo_url(u: &str) -> Result<(), String> {
    if let Some(rest) = u.strip_prefix("data:") {
        let ok_type = [
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
            "image/svg+xml",
        ]
        .iter()
        .any(|t| rest.starts_with(t));
        if !ok_type {
            return Err("data URIs must be data:image/png, jpeg, webp, gif or svg+xml".into());
        }
        if u.len() > 128 * 1024 {
            return Err(
                "inline data URIs must be at most 128 KB; host the logo and use an https URL"
                    .into(),
            );
        }
        return Ok(());
    }
    crate::normalize::validate_https_url(u).map(|_| ())
}

/// True when `candidate` exactly matches a registered redirect URI (after trimming). Loopback
/// URIs (`http://localhost`, `http://127.0.0.1`) match on any port, but only when registered with
/// that same host.
pub fn redirect_uri_matches(registered: &[String], candidate: &str) -> bool {
    let candidate = candidate.trim();
    if registered.iter().any(|r| r.trim() == candidate) {
        return true;
    }
    let Ok(c) = Url::parse(candidate) else {
        return false;
    };
    if c.scheme() != "http" || !c.host_str().is_some_and(is_loopback_host) {
        return false;
    }
    registered.iter().any(|r| {
        let Ok(r) = Url::parse(r.trim()) else {
            return false;
        };
        r.scheme() == "http"
            && r.host_str().is_some_and(is_loopback_host)
            && r.host_str() == c.host_str()
            && r.path() == c.path()
            && r.query() == c.query()
    })
}

/// First-party redirect rule: the URI's origin must be the public origin or an extra allowed
/// origin (compared as parsed origins, so `http://localhost:8590.evil.test` never matches).
pub fn first_party_redirect_allowed(settings: &Settings, uri: &str) -> bool {
    let Ok(u) = Url::parse(uri.trim()) else {
        return false;
    };
    if u.fragment().is_some() {
        return false;
    }
    match crate::config::origin_of(uri) {
        Some(origin) => settings
            .allowed_origins()
            .any(|a| a.eq_ignore_ascii_case(&origin)),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn no_secrets() -> ConfigSecretsPresent {
        ConfigSecretsPresent::default()
    }

    #[test]
    fn default_document_is_valid_and_round_trips() {
        let c = SigninConfig::default();
        c.validate(no_secrets()).expect("default config is valid");
        let v = serde_json::to_value(&c).expect("json");
        assert_eq!(v["branding"]["light"]["primary"], "#1F5FB8");
        assert_eq!(v["copy"]["title"], Value::Null);
        let back = SigninConfig::parse_strict(&v, no_secrets()).expect("parses");
        assert_eq!(back, c);
    }

    #[test]
    fn partial_documents_fill_the_right_palette_defaults() {
        let c = SigninConfig::from_stored(&json!({"branding": {"dark": {"primary": "#112233"}}}));
        assert_eq!(c.branding.dark.primary, "#112233");
        assert_eq!(c.branding.dark.background, "#2A2927");
        assert_eq!(c.branding.light.background, "#FFFDF9");
        assert!(c.methods.email);
    }

    #[test]
    fn patch_merges_and_validates_with_paths() {
        let base = SigninConfig::default();
        let patched = base
            .apply_patch(
                &json!({"methods": {"google": true}, "branding": {"radius": 28, "light": {"primary": "#0a0a0a"}}}),
                no_secrets(),
            )
            .expect("valid patch");
        assert!(patched.methods.google && patched.methods.email);
        assert_eq!(patched.branding.radius, 28);
        assert_eq!(patched.branding.light.primary, "#0A0A0A");

        let err = base
            .apply_patch(&json!({"branding": {"colour": "red"}}), no_secrets())
            .expect_err("unknown");
        assert!(
            err.get("branding.colour")
                .is_some_and(|m| m.contains("unknown field"))
        );

        let err = base
            .apply_patch(&json!({"branding": {"radius": "big"}}), no_secrets())
            .expect_err("type");
        assert!(err.get("branding.radius").is_some(), "{err:?}");

        let err = base
            .apply_patch(
                &json!({"branding": {"light": {"primary": "blue"}}, "redirect_uris": ["ftp://x"]}),
                no_secrets(),
            )
            .expect_err("invalid");
        assert_eq!(
            err.get("branding.light.primary"),
            Some("'blue' must be a #RRGGBB colour")
        );
        assert!(err.get("redirect_uris[0]").is_some());

        let err = base
            .apply_patch(&json!({"branding": {"theme": "neon"}}), no_secrets())
            .expect_err("enum");
        assert!(
            err.get("branding.theme")
                .is_some_and(|m| m.contains("auto, light, dark")),
            "{err:?}"
        );
    }

    #[test]
    fn null_resets_to_default() {
        let base = SigninConfig::default()
            .apply_patch(
                &json!({"branding": {"radius": 30, "logo_url": "https://cdn.example.com/l.png"}}),
                no_secrets(),
            )
            .expect("valid");
        let reset = base
            .apply_patch(
                &json!({"branding": {"radius": null, "logo_url": null}}),
                no_secrets(),
            )
            .expect("valid");
        assert_eq!(reset.branding.radius, 18);
        assert_eq!(reset.branding.logo_url, None);
    }

    #[test]
    fn contrast_is_enforced_with_measured_ratio() {
        assert!(contrast_ratio("#FFFFFF", "#000000").is_some_and(|r| (r - 21.0).abs() < 0.01));
        let err = SigninConfig::default()
            .apply_patch(&json!({"branding": {"light": {"primary": "#FFFFFF", "primary_foreground": "#EEEEEE"}}}), no_secrets())
            .expect_err("low contrast");
        let msg = err
            .get("branding.light.primary_foreground")
            .expect("contrast error");
        assert!(
            msg.contains(":1") && msg.contains("at least 4.5:1"),
            "{msg}"
        );

        // The old default dark pair (#FFFDF9 on #5B8FE0) is 3.2:1: readable for large text only,
        // so it is refused now, with the measured ratio.
        let err = SigninConfig::default()
            .apply_patch(
                &json!({"branding": {"dark": {"primary": "#5B8FE0"}}}),
                no_secrets(),
            )
            .expect_err("3.2:1 button text");
        let msg = err
            .get("branding.dark.primary_foreground")
            .expect("contrast error");
        assert!(msg.contains("is 3.20:1"), "{msg}");
        // Page text is held to the same bar.
        let err = SigninConfig::default()
            .apply_patch(
                &json!({"branding": {"light": {"foreground": "#8A8580"}}}),
                no_secrets(),
            )
            .expect_err("pale page text");
        assert!(err.get("branding.light.foreground").is_some(), "{err:?}");
        // Just above the bar passes.
        assert!(
            SigninConfig::default()
                .apply_patch(
                    &json!({"branding": {"light": {"primary": "#E5007E", "primary_foreground": "#FFFFFF"}}}),
                    no_secrets(),
                )
                .is_ok()
        );
    }

    #[test]
    fn default_palettes_meet_wcag_aa_for_text() {
        for (theme, p) in [
            ("light", Palette::default_light()),
            ("dark", Palette::default_dark()),
        ] {
            for (fg, bg) in [
                (&p.primary_foreground, &p.primary),
                (&p.foreground, &p.background),
                (&p.foreground, &p.surface),
            ] {
                let ratio = contrast_ratio(fg, bg).expect("hex colours");
                assert!(
                    ratio >= MIN_TEXT_CONTRAST,
                    "{theme}: {fg} on {bg} is {ratio:.2}:1"
                );
            }
        }
        // Filled buttons are the brand blue in both themes.
        assert_eq!(Palette::default_dark().primary, "#1F5FB8");
        assert_eq!(Palette::default_dark().primary_foreground, "#FFFDF9");
        // A stored document without a dark palette gets the new default.
        let c = SigninConfig::from_stored(&json!({"branding": {}}));
        assert_eq!(c.branding.dark.primary, "#1F5FB8");
    }

    #[test]
    fn byo_requires_ids_and_secrets() {
        let err = SigninConfig::default()
            .apply_patch(
                &json!({"methods": {"google": true}, "google": {"mode": "byo"}}),
                no_secrets(),
            )
            .expect_err("byo");
        assert!(err.get("google.client_id").is_some());
        assert!(err.get("google.client_secret").is_some());
        let ok = SigninConfig::default().apply_patch(
            &json!({"google": {"mode": "byo", "client_id": "123.apps.googleusercontent.com"}}),
            ConfigSecretsPresent {
                google_client_secret: true,
                apple_private_key: false,
            },
        );
        assert!(ok.is_ok());
        let err = SigninConfig::default()
            .apply_patch(&json!({"apple": {"mode": "byo", "services_id": "com.x", "team_id": "short", "key_id": "ABCDEFGHIJ"}}), no_secrets())
            .expect_err("apple");
        assert!(err.get("apple.team_id").is_some());
        assert!(err.get("apple.private_key").is_some());
        assert!(err.get("apple.key_id").is_none());
    }

    #[test]
    fn fields_and_methods_rules() {
        let err = SigninConfig::default()
            .apply_patch(&json!({"methods": {"email": false}}), no_secrets())
            .expect_err("no methods");
        assert!(err.get("methods").is_some());
        let err = SigninConfig::default()
            .apply_patch(
                &json!({"required_fields": ["email"], "optional_fields": ["email", "timezone"]}),
                no_secrets(),
            )
            .expect_err("overlap");
        assert!(err.get("optional_fields").is_some());
        let c = SigninConfig::default()
            .apply_patch(&json!({"method_order": ["email", "email"], "allowed_email_domains": ["@University.TEST"]}), no_secrets())
            .expect("valid");
        assert_eq!(
            c.method_order,
            vec![Method::Email, Method::Google, Method::Apple, Method::Phone]
        );
        assert_eq!(c.allowed_email_domains, vec!["university.test"]);
        assert!(c.email_domain_allowed("a@university.test"));
        assert!(!c.email_domain_allowed("a@gmail.com"));
    }

    #[test]
    fn redirect_matching_rules() {
        let reg = vec![
            "https://app.example.com/cb".to_string(),
            "http://localhost/cb".to_string(),
        ];
        assert!(redirect_uri_matches(&reg, "https://app.example.com/cb"));
        assert!(!redirect_uri_matches(&reg, "https://app.example.com/cb2"));
        assert!(!redirect_uri_matches(
            &reg,
            "https://app.example.com/cb?x=1"
        ));
        assert!(redirect_uri_matches(&reg, "http://localhost:3000/cb"));
        assert!(
            !redirect_uri_matches(&reg, "http://127.0.0.1:3000/cb"),
            "host must match the registered loopback host"
        );
        assert!(!redirect_uri_matches(&reg, "http://localhost:3000/other"));
        assert!(validate_redirect_uri("com.example.app:/callback").is_ok());
        assert!(validate_redirect_uri("javascript:alert(1)").is_err());
        assert!(validate_redirect_uri("http://example.com/cb").is_err());
        assert!(validate_redirect_uri("https://example.com/cb#frag").is_err());

        let mut settings = Settings::for_tests();
        settings.extra_allowed_origins = vec!["http://localhost:5190".into()];
        assert!(first_party_redirect_allowed(
            &settings,
            "http://localhost:8590/"
        ));
        assert!(first_party_redirect_allowed(
            &settings,
            "http://localhost:5190/apps?x=1"
        ));
        assert!(!first_party_redirect_allowed(
            &settings,
            "http://localhost:8590.evil.test/"
        ));
        assert!(!first_party_redirect_allowed(
            &settings,
            "https://evil.test/http://localhost:8590/"
        ));
    }

    #[test]
    fn first_party_effective_config() {
        let mut settings = Settings::for_tests();
        let c = SigninConfig::default().effective(&settings, "accounts");
        assert!(c.methods.email && c.methods.phone && !c.methods.google && !c.methods.apple);
        assert_eq!(
            c.available_methods(&settings),
            vec![Method::Email, Method::Phone]
        );
        settings.google.client_id = Some("id".into());
        settings.google.client_secret = Some(secrecy::SecretString::from("secret"));
        let c = SigninConfig::default().effective(&settings, "accounts");
        assert_eq!(
            c.available_methods(&settings),
            vec![Method::Google, Method::Email, Method::Phone]
        );
        // Managed Google without managed credentials is hidden for other apps too.
        let other = SigninConfig::default()
            .apply_patch(&json!({"methods": {"apple": true}}), no_secrets())
            .expect("valid");
        assert_eq!(other.available_methods(&settings), vec![Method::Email]);
    }
}
