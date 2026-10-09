//! The per-app sign-in configuration document (`app_signin_configs.config`).
//!
//! - [`SigninConfig::default`] is the documented default; every field has a serde default so a
//!   partial document loads.
//! - [`SigninConfig::from_stored`] loads a stored document leniently (never fails).
//! - [`SigninConfig::apply_patch`] deep-merges a PATCH body (objects merge, arrays and scalars
//!   replace, `null` resets a field to its default), rejects unknown keys, reports type errors
//!   with their path, normalizes and validates — returning [`FieldErrors`] keyed by path such as
//!   `branding.light.primary`.
//! - [`SigninConfig::effective`] applies the first-party rules for apps `silicon-accounts` and
//!   `developer`.
//!
//! ## Details and flows
//!
//! An app asks for details (`required_fields`, `optional_fields`: disjoint subsets of email,
//! phone, dob, timezone). Its optional `flow` decides on which pages they are asked: an ordered
//! list of steps, each with the details it shows (every requested detail on exactly one step),
//! its own title, subtitle, continue label and layout, plus `review` (a last page listing
//! everything that will be shared). `flow: null` (the default) is one step with every requested
//! detail and no review: that step is the what's-shared screen ([`SigninConfig::effective_flow`]).
//!
//! A PATCH that leaves `flow` out keeps the stored flow valid when the details change: a detail
//! that is no longer requested leaves its step (an emptied step is dropped, and a flow without
//! steps goes back to `null`), and a newly requested detail joins the last step. A PATCH that
//! sends `flow` is validated as sent. Sending a `flow` object while the stored flow is `null`
//! merges it into the default flow, so `{"flow":{"review":true}}` turns the review page on.

use std::collections::{BTreeMap, BTreeSet};

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
    /// The Silicon Accounts light palette: the account site's and the developer site's own
    /// colours (`web/styles/tokens.css`): a `#F7F8FA` page, `#292929` text, the brand blue
    /// `#1F5FB8` for buttons under white text (6.2:1), muted `#5C6370` (6.0:1 on the card, 5.6:1
    /// on the page). New apps store it; an app that kept the older warm default keeps it as stored
    /// ([`Palette::legacy_light`]), and the hosted pages paint that one in this look.
    pub fn default_light() -> Palette {
        Palette {
            primary: "#1F5FB8".into(),
            primary_foreground: "#FFFFFF".into(),
            background: "#F7F8FA".into(),
            surface: "#FFFFFF".into(),
            foreground: "#292929".into(),
            muted: "#5C6370".into(),
            border: "#E2E5EB".into(),
            danger: "#B42318".into(),
        }
    }

    /// The Silicon Accounts dark palette (`web/styles/tokens.css`): a `#02040A` page and a
    /// `#0B0F18` card, `#F7F8FA` text, filled buttons in the brand blue `#1F5FB8` under `#F7F8FA`
    /// text (5.8:1; the lighter `#5B8FE0` would put button text at 3.2:1, so it stays an ink for
    /// links), muted `#9BA4B4` (7.4:1 on the card), error text `#FF8A80` (8.6:1 on the card).
    pub fn default_dark() -> Palette {
        Palette {
            primary: "#1F5FB8".into(),
            primary_foreground: "#F7F8FA".into(),
            background: "#02040A".into(),
            surface: "#0B0F18".into(),
            foreground: "#F7F8FA".into(),
            muted: "#9BA4B4".into(),
            border: "#1F2635".into(),
            danger: "#FF8A80".into(),
        }
    }

    /// The light palette apps were given before the Silicon look (warm paper `#FFFDF9`, charcoal
    /// `#353432` text). Apps that kept it store it as it is (no migration); the hosted pages
    /// recognise it, all eight colours, and paint [`Palette::default_light`] instead
    /// (`web/lib/branding/defaults.ts` LEGACY_LIGHT).
    pub fn legacy_light() -> Palette {
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

    /// The dark palette apps were given before the Silicon look (`#2A2927` page, `#353432` card);
    /// see [`Palette::legacy_light`] (`web/lib/branding/defaults.ts` LEGACY_DARK).
    pub fn legacy_dark() -> Palette {
        Palette {
            primary: "#1F5FB8".into(),
            primary_foreground: "#FFFDF9".into(),
            background: "#2A2927".into(),
            surface: "#353432".into(),
            foreground: "#FFFDF9".into(),
            muted: "#B5B0A8".into(),
            border: "#4A4845".into(),
            danger: "#FF8A80".into(),
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
    /// The opening page shown before Google or Apple ("Opening Google to sign you in to
    /// Briefcase…"): ≤ 80 characters, may contain `{provider}` and `{app}`.
    pub opening_title: Option<String>,
    /// The sign-up version of `title` (`intent=signup`, e.g. "Create your Briefcase account"):
    /// ≤ 80 characters.
    pub signup_title: Option<String>,
    /// The sign-up version of `subtitle`: ≤ 200 characters.
    pub signup_subtitle: Option<String>,
}

/// Placeholders `copy.opening_title` may contain.
pub const OPENING_TITLE_PLACEHOLDERS: [&str; 2] = ["{provider}", "{app}"];

text_enum! {
    /// Whether an app requires a detail or only asks for it.
    pub enum FieldMode {
        /// Always shared; a missing email or phone must be added before continuing.
        Required = "required",
        /// A checkbox the Carbon ticks to share it (unticked until they do).
        Optional = "optional",
    }
}

/// The id of the single step of the default flow (`flow: null`).
pub const DEFAULT_FLOW_STEP_ID: &str = "details";

/// Most steps a flow can have.
pub const MAX_FLOW_STEPS: usize = 8;

/// One page of an app's sign-in flow: the details it asks for, with its own copy and layout.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FlowStepConfig {
    /// `[a-z0-9-]{1,40}`, unique in the flow (`contact`, `about-you`).
    pub id: String,
    /// The requested details shown on this page (each requested detail is on exactly one step).
    pub fields: Vec<ContactField>,
    /// ≤ 80 characters of plain text; `null` = the hosted page's own title.
    pub title: Option<String>,
    /// ≤ 200 characters of plain text.
    pub subtitle: Option<String>,
    /// The continue button's label, ≤ 30 characters of plain text (`Finish`).
    pub continue_label: Option<String>,
    /// `null` = `branding.layout`.
    pub layout: Option<Layout>,
}

/// Which pages a Carbon goes through while signing in, in what order, and which details are
/// asked on which page (UNDERSTANDING.md "Flows").
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FlowConfig {
    /// 1 to 8 steps.
    pub steps: Vec<FlowStepConfig>,
    /// Show a last page listing everything that will be shared before finishing.
    pub review: bool,
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
    /// Let the app's own command-line tool sign Carbons in with a code they approve on the
    /// account site (OAuth device authorization grant, RFC 8628), without a client secret.
    pub device_flow: bool,
    /// Treat the app's command-line and desktop tools as public clients (RFC 8252): they
    /// redeem authorization codes, short-lived tokens and refresh tokens with `client_id`
    /// alone, and every such code must come with PKCE S256. Loopback redirect URIs take any
    /// port either way.
    pub public_client: bool,
    pub branding: Branding,
    pub copy: SigninCopy,
    /// The pages that ask for the details; `null` = one page with every requested detail (see
    /// the module docs).
    pub flow: Option<FlowConfig>,
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
            device_flow: false,
            public_client: false,
            branding: Branding::default(),
            copy: SigninCopy::default(),
            flow: None,
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
        let mut config = SigninConfig::parse_document(value)?;
        config.normalize();
        config.validate(secrets)?;
        Ok(config)
    }

    /// Unknown keys and type errors (with their path), without normalizing or validating.
    fn parse_document(value: &Value) -> Result<SigninConfig, FieldErrors> {
        let mut errors = FieldErrors::new();
        unknown_keys(value, &config_template(), "", &mut errors);
        if !errors.is_empty() {
            return Err(errors);
        }
        match serde_path_to_error::deserialize(value.clone()) {
            Ok(c) => Ok(c),
            Err(e) => {
                let path = e.path().to_string();
                let path = if path == "." { String::new() } else { path };
                let message = plain_serde_message(&path, &e.inner().to_string());
                errors.add(path, message);
                Err(errors)
            }
        }
    }

    /// Applies a PATCH body to this document (see module docs) and returns the validated result.
    pub fn apply_patch(
        &self,
        patch: &Value,
        secrets: ConfigSecretsPresent,
    ) -> Result<SigninConfig, FieldErrors> {
        let mut errors = FieldErrors::new();
        let Value::Object(patch_map) = patch else {
            errors.add("", "the sign-in config patch must be a JSON object");
            return Err(errors);
        };
        unknown_keys(patch, &config_template(), "", &mut errors);
        if !errors.is_empty() {
            return Err(errors);
        }
        let mut current = serde_json::to_value(self).unwrap_or_else(|_| Value::Object(Map::new()));
        // Everything but the flow first: the default flow a `flow` object merges into is made
        // of the details as they are after this patch.
        let mut rest = patch_map.clone();
        let flow_patch = rest.remove("flow");
        merge_patch(&mut current, &Value::Object(rest));
        if let (Some(flow_patch), Value::Object(doc)) = (&flow_patch, &mut current) {
            match flow_patch {
                Value::Object(_) => {
                    let base = match doc.get("flow") {
                        Some(existing) if existing.is_object() => existing.clone(),
                        _ => default_flow_value(doc),
                    };
                    let mut merged = base;
                    merge_patch(&mut merged, flow_patch);
                    doc.insert("flow".into(), merged);
                }
                // `null` resets to the default flow; anything else is reported by the parser.
                other => {
                    doc.insert("flow".into(), other.clone());
                }
            }
        }
        let mut config = SigninConfig::parse_document(&current)?;
        config.normalize();
        if flow_patch.is_none() {
            // The stored flow follows the details this patch changed (see the module docs).
            config.reconcile_flow();
        }
        config.validate(secrets)?;
        Ok(config)
    }

    /// Every detail the app asks for: the required ones, then the optional ones.
    pub fn requested_fields(&self) -> Vec<ContactField> {
        let mut out: Vec<ContactField> = Vec::new();
        for f in self.required_fields.iter().chain(&self.optional_fields) {
            if !out.contains(f) {
                out.push(*f);
            }
        }
        out
    }

    /// How the app asks for `field`, if it does.
    pub fn mode_of(&self, field: ContactField) -> Option<FieldMode> {
        if self.required_fields.contains(&field) {
            Some(FieldMode::Required)
        } else if self.optional_fields.contains(&field) {
            Some(FieldMode::Optional)
        } else {
            None
        }
    }

    /// The default flow: one step with every requested detail (none for an app that asks for
    /// no details: its one step shows the profile), no review page.
    pub fn default_flow(&self) -> FlowConfig {
        FlowConfig {
            steps: vec![FlowStepConfig {
                id: DEFAULT_FLOW_STEP_ID.into(),
                fields: self.requested_fields(),
                ..Default::default()
            }],
            review: false,
        }
    }

    /// The flow the hosted pages walk: the configured one, kept consistent with the requested
    /// details (a stored document always is; this also covers documents written around the
    /// validation), or [`SigninConfig::default_flow`]. Always at least one step.
    pub fn effective_flow(&self) -> FlowConfig {
        let mut copy = self.clone();
        copy.reconcile_flow();
        match copy.flow {
            Some(flow) if !flow.steps.is_empty() => flow,
            _ => self.default_flow(),
        }
    }

    /// Keeps the flow consistent with the requested details: a detail that isn't requested any
    /// more leaves its step, a requested detail on no step joins the last step, an emptied step
    /// is dropped, and a flow left without steps becomes `null` (the default flow).
    pub fn reconcile_flow(&mut self) {
        let requested = self.requested_fields();
        let Some(flow) = &mut self.flow else {
            return;
        };
        let mut placed: BTreeSet<ContactField> = BTreeSet::new();
        for step in &mut flow.steps {
            step.fields
                .retain(|f| requested.contains(f) && placed.insert(*f));
        }
        let missing: Vec<ContactField> = requested
            .iter()
            .copied()
            .filter(|f| !placed.contains(f))
            .collect();
        if let Some(last) = flow.steps.last_mut() {
            last.fields.extend(missing);
        }
        flow.steps.retain(|s| !s.fields.is_empty());
        if flow.steps.is_empty() {
            self.flow = None;
        }
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
            &mut self.copy.opening_title,
            &mut self.copy.signup_title,
            &mut self.copy.signup_subtitle,
        ] {
            trim_opt(v);
        }
        if let Some(flow) = &mut self.flow {
            for step in &mut flow.steps {
                let trimmed = step.id.trim();
                if trimmed.len() != step.id.len() {
                    step.id = trimmed.to_string();
                }
                for v in [
                    &mut step.title,
                    &mut step.subtitle,
                    &mut step.continue_label,
                ] {
                    trim_opt(v);
                }
                // The same detail twice on one step is the same request.
                let mut seen = BTreeSet::new();
                step.fields.retain(|f| seen.insert(*f));
            }
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
        for (path, value, max) in [
            ("copy.title", &self.copy.title, 80),
            ("copy.subtitle", &self.copy.subtitle, 200),
            ("copy.opening_title", &self.copy.opening_title, 80),
            ("copy.signup_title", &self.copy.signup_title, 80),
            ("copy.signup_subtitle", &self.copy.signup_subtitle, 200),
        ] {
            validate_text(&mut e, path, value.as_deref(), max);
        }
        if let Some(t) = &self.copy.opening_title {
            for placeholder in placeholders(t) {
                if !OPENING_TITLE_PLACEHOLDERS.contains(&placeholder.as_str()) {
                    e.add(
                        "copy.opening_title",
                        format!(
                            "'{placeholder}' is not a placeholder of the opening page; use {{provider}} (Google or Apple) and {{app}} (the app's name), e.g. \"Opening {{provider}} to sign you in to {{app}}…\""
                        ),
                    );
                }
            }
        }

        validate_flow(self, &mut e);
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

    /// Applies the first-party rules for apps `silicon-accounts` (the account site and the CLI) and
    /// `developer` (developers.teamofsilicons.com): email + phone always on, Google/Apple only
    /// when managed credentials exist, no details asked (so no flow), signup allowed, and their
    /// fixed redirect URIs (any URL on the public origin for `silicon-accounts`; exactly
    /// `{developer_url}/auth/callback` for `developer`).
    pub fn effective(mut self, settings: &Settings, app_id: &str) -> SigninConfig {
        if crate::is_first_party_app_id(app_id) {
            self.methods = Methods {
                email: true,
                phone: true,
                google: settings.google.managed_configured(),
                apple: settings.apple.managed_configured(),
            };
            self.google.mode = ProviderMode::Managed;
            self.apple.mode = ProviderMode::Managed;
            self.redirect_uris = if app_id == crate::DEVELOPER_APP_ID {
                vec![settings.developer_callback_url()]
            } else {
                vec![format!("{}/", settings.public_url)]
            };
            self.required_fields.clear();
            self.optional_fields.clear();
            self.flow = None;
            self.allowed_email_domains.clear();
            self.allow_signup = true;
            // Their public clients and the CLI's device flow are built in, not settings.
            self.device_flow = false;
            self.public_client = false;
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
    /// First-party `silicon-accounts`: any URL on the public origin or an extra allowed origin.
    /// First-party `developer`: exactly `{developer_url}/auth/callback`.
    pub fn redirect_allowed(&self, settings: &Settings, app_id: &str, uri: &str) -> bool {
        if app_id == crate::FIRST_PARTY_APP_ID {
            first_party_redirect_allowed(settings, uri)
        } else if app_id == crate::DEVELOPER_APP_ID {
            settings.developer_redirect_allowed(uri)
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

/// Plain text shown on a hosted page: at most `max` characters, no control characters.
fn validate_text(e: &mut FieldErrors, path: &str, value: Option<&str>, max: usize) {
    let Some(t) = value else { return };
    if t.chars().count() > max {
        e.add(path, format!("must be at most {max} characters"));
    }
    if t.chars().any(char::is_control) {
        e.add(path, "must not contain control characters");
    }
}

/// Every `{…}` placeholder in a text, braces included.
fn placeholders(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find('{') {
        let after = &rest[start..];
        match after.find('}') {
            Some(end) => {
                out.push(after[..=end].to_string());
                rest = &after[end + 1..];
            }
            None => {
                out.push(after.to_string());
                break;
            }
        }
    }
    out
}

/// True for a flow step id: `[a-z0-9-]{1,40}`.
pub fn is_flow_step_id(id: &str) -> bool {
    (1..=40).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn validate_flow(c: &SigninConfig, e: &mut FieldErrors) {
    let Some(flow) = &c.flow else { return };
    let requested = c.requested_fields();
    if requested.is_empty() {
        e.add(
            "flow.steps",
            "can't be set: the app asks for no details (required_fields and optional_fields are empty), so there is nothing to put on a step; send \"flow\": null to keep the single what's-shared page that shows the profile",
        );
        return;
    }
    if !(1..=MAX_FLOW_STEPS).contains(&flow.steps.len()) {
        e.add(
            "flow.steps",
            format!(
                "has {} steps; a flow has 1 to {MAX_FLOW_STEPS} steps",
                flow.steps.len()
            ),
        );
    }
    let mut ids: Vec<&str> = Vec::new();
    let mut placed: BTreeMap<ContactField, usize> = BTreeMap::new();
    for (i, step) in flow.steps.iter().enumerate() {
        let at = |key: &str| format!("flow.steps[{i}].{key}");
        if step.id.is_empty() {
            e.add(
                at("id"),
                "is required: a short name for the step, 1 to 40 lowercase letters, digits or '-', like contact or about-you",
            );
        } else if !is_flow_step_id(&step.id) {
            e.add(
                at("id"),
                format!(
                    "'{}' must be 1 to 40 lowercase letters, digits or '-', like contact or about-you",
                    step.id
                ),
            );
        } else if let Some(j) = ids.iter().position(|id| *id == step.id) {
            e.add(
                at("id"),
                format!(
                    "'{}' is already the id of flow.steps[{j}]; step ids must be unique",
                    step.id
                ),
            );
        }
        ids.push(&step.id);
        if step.fields.is_empty() {
            e.add(
                at("fields"),
                "must list at least one of the app's details (email, phone, dob or timezone from required_fields or optional_fields)",
            );
        }
        for (k, field) in step.fields.iter().enumerate() {
            let path = format!("flow.steps[{i}].fields[{k}]");
            if !requested.contains(field) {
                e.add(
                    path,
                    format!(
                        "'{field}' is not one of the app's details; add it to required_fields or optional_fields first, or take it off this step"
                    ),
                );
            } else if let Some(j) = placed.get(field) {
                e.add(
                    path,
                    format!(
                        "'{field}' is already on flow.steps[{j}]; each detail is asked on exactly one step"
                    ),
                );
            } else {
                placed.insert(*field, i);
            }
        }
        validate_text(e, &at("title"), step.title.as_deref(), 80);
        validate_text(e, &at("subtitle"), step.subtitle.as_deref(), 200);
        validate_text(e, &at("continue_label"), step.continue_label.as_deref(), 30);
    }
    let unplaced: Vec<String> = requested
        .iter()
        .filter(|f| !placed.contains_key(f))
        .map(|f| format!("'{f}'"))
        .collect();
    if !unplaced.is_empty() && !flow.steps.is_empty() {
        e.add(
            "flow.steps",
            format!(
                "{} {} requested (required_fields or optional_fields) but on no step; every requested detail must be on exactly one step",
                unplaced.join(" and "),
                if unplaced.len() == 1 { "is" } else { "are" }
            ),
        );
    }
}

/// The fully serialized default document, with a sample flow step so unknown keys inside
/// `flow` are reported too.
fn config_template() -> Value {
    let mut template = serde_json::to_value(SigninConfig::default()).unwrap_or(Value::Null);
    if let Value::Object(map) = &mut template {
        let step = serde_json::to_value(FlowStepConfig::default()).unwrap_or(Value::Null);
        map.insert(
            "flow".into(),
            serde_json::json!({"steps": [step], "review": false}),
        );
    }
    template
}

/// The default flow (one step with every requested detail) of a document being merged, as
/// JSON. Details that don't parse are left out (the parser reports them).
fn default_flow_value(doc: &Map<String, Value>) -> Value {
    let fields = |key: &str| -> Vec<ContactField> {
        doc.get(key)
            .and_then(|v| serde_json::from_value::<Vec<ContactField>>(v.clone()).ok())
            .unwrap_or_default()
    };
    let draft = SigninConfig {
        required_fields: fields("required_fields"),
        optional_fields: fields("optional_fields"),
        ..SigninConfig::default()
    };
    serde_json::to_value(draft.default_flow()).unwrap_or(Value::Null)
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

/// serde's message about a value of the wrong type in plain words: `invalid type: floating
/// point `12.5`, expected u32` becomes `must be a whole number from 0 to 40 (pixels), not 12.5`.
/// Other messages (an enum's "'x' is not one of …") are kept as they are.
fn plain_serde_message(path: &str, raw: &str) -> String {
    let m = clean_serde_message(raw);
    let Some((got, expected)) = m
        .strip_prefix("invalid type: ")
        .or_else(|| m.strip_prefix("invalid value: "))
        .and_then(|rest| rest.rsplit_once(", expected "))
    else {
        return m;
    };
    let wanted = match expected.trim() {
        "u8" | "u16" | "u32" | "u64" | "u128" | "usize" | "i8" | "i16" | "i32" | "i64" | "i128"
        | "isize" => match whole_number_range(path) {
            Some(range) => format!("a whole number {range}"),
            None => "a whole number".to_string(),
        },
        "f32" | "f64" => "a number".to_string(),
        "a string" | "a borrowed string" | "string" => "text (a JSON string)".to_string(),
        "a boolean" | "bool" => "true or false".to_string(),
        "a sequence" => "a list (a JSON array)".to_string(),
        "a map" => "an object".to_string(),
        e if e.starts_with("struct ") || e.starts_with("a map") => "an object".to_string(),
        e => e.to_string(),
    };
    format!("must be {wanted}, not {}", describe_unexpected(got))
}

/// serde's description of the value it got (`floating point `12.5``, `string "big"`, `map`),
/// as the JSON a person wrote.
fn describe_unexpected(got: &str) -> String {
    let got = got.trim();
    for prefix in ["floating point ", "integer ", "boolean ", "char "] {
        if let Some(value) = got.strip_prefix(prefix) {
            return value.trim_matches('`').to_string();
        }
    }
    if let Some(quoted) = got.strip_prefix("string ") {
        return quoted.to_string();
    }
    match got {
        "map" => "an object".to_string(),
        "sequence" => "a list".to_string(),
        "unit value" | "null" => "null".to_string(),
        other => other.to_string(),
    }
}

/// The range [`SigninConfig`]'s validation allows for a numeric field, as people say it.
fn whole_number_range(path: &str) -> Option<&'static str> {
    match path {
        "branding.radius" => Some("from 0 to 40 (pixels)"),
        "branding.logo_height" => Some("from 16 to 96 (pixels)"),
        _ => None,
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
/// Array items are checked against the template array's first item (`flow.steps[2].colour`).
fn unknown_keys(value: &Value, template: &Value, path: &str, errors: &mut FieldErrors) {
    if let (Value::Array(items), Value::Array(t)) = (value, template)
        && let Some(item_template) = t.first()
    {
        for (i, item) in items.iter().enumerate() {
            unknown_keys(item, item_template, &format!("{path}[{i}]"), errors);
        }
        return;
    }
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
    // One real host. The url crate parses CSP wildcard syntax (`https://*`, `https://*.x.com`)
    // as a host named `*`, and an origin is copied into the embed's `frame-ancestors`, where `*`
    // would let any site frame the sign-in buttons.
    let one_host = match u.host() {
        Some(url::Host::Ipv4(_) | url::Host::Ipv6(_)) => true,
        Some(url::Host::Domain(d)) => d == "localhost" || is_valid_domain(d),
        None => false,
    };
    if !one_host {
        return Err(format!(
            "'{origin}' must name one host, like https://app.example.com or http://127.0.0.1:3000: wildcards (*) are not allowed, and each part of the host name may use only a-z, 0-9 and -"
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
        assert_eq!(c.branding.dark.background, "#02040A");
        assert_eq!(c.branding.light.background, "#F7F8FA");
        assert!(c.methods.email);
    }

    #[test]
    fn new_apps_get_the_silicon_palettes() {
        let c = SigninConfig::default();
        assert_eq!(c.branding.light, Palette::default_light());
        assert_eq!(c.branding.dark, Palette::default_dark());
        let light = &c.branding.light;
        assert_eq!(
            (
                light.background.as_str(),
                light.foreground.as_str(),
                light.primary.as_str()
            ),
            ("#F7F8FA", "#292929", "#1F5FB8")
        );
        let dark = &c.branding.dark;
        assert_eq!(
            (
                dark.background.as_str(),
                dark.foreground.as_str(),
                dark.primary.as_str()
            ),
            ("#02040A", "#F7F8FA", "#1F5FB8")
        );
        // What a new app stores is the new look, all eight colours.
        let stored = serde_json::to_value(&c).expect("serializes");
        assert_eq!(stored["branding"]["light"]["background"], "#F7F8FA");
        assert_eq!(stored["branding"]["dark"]["surface"], "#0B0F18");
    }

    #[test]
    fn stored_palettes_never_change_with_the_defaults() {
        // An app that kept the older warm defaults stored all eight colours of them: reading it,
        // and saving an unrelated change on top, keep them exactly (no migration of stored configs).
        let mut stored = serde_json::to_value(SigninConfig::default()).expect("serializes");
        stored["branding"]["light"] = serde_json::to_value(Palette::legacy_light()).expect("light");
        stored["branding"]["dark"] = serde_json::to_value(Palette::legacy_dark()).expect("dark");
        let c = SigninConfig::from_stored(&stored);
        assert_eq!(c.branding.light, Palette::legacy_light());
        assert_eq!(c.branding.dark, Palette::legacy_dark());
        let saved = c
            .apply_patch(&json!({"branding": {"radius": 24}}), no_secrets())
            .expect("an unrelated change saves");
        assert_eq!(saved.branding.radius, 24);
        assert_eq!(saved.branding.light, Palette::legacy_light());
        assert_eq!(saved.branding.dark, Palette::legacy_dark());
        // An app's own colours stay too.
        let own = c
            .apply_patch(
                &json!({"branding": {"light": {"primary": "#17775C"}}}),
                no_secrets(),
            )
            .expect("its own primary");
        assert_eq!(own.branding.light.primary, "#17775C");
        assert_eq!(own.branding.light.background, "#FFFDF9");
        // Resetting a palette (null) gives the new look.
        let reset = c
            .apply_patch(&json!({"branding": {"light": null}}), no_secrets())
            .expect("reset");
        assert_eq!(reset.branding.light, Palette::default_light());
        assert_eq!(reset.branding.dark, Palette::legacy_dark());
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
                &json!({"branding": {"dark": {"primary": "#5B8FE0", "primary_foreground": "#FFFDF9"}}}),
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
                // Error text and muted text sit on the card and on the page.
                (&p.danger, &p.surface),
                (&p.danger, &p.background),
                (&p.muted, &p.surface),
                (&p.muted, &p.background),
            ] {
                let ratio = contrast_ratio(fg, bg).expect("hex colours");
                assert!(
                    ratio >= MIN_TEXT_CONTRAST,
                    "{theme}: {fg} on {bg} is {ratio:.2}:1"
                );
            }
        }
        // Filled buttons are the brand blue in both themes.
        assert_eq!(Palette::default_light().primary, "#1F5FB8");
        assert_eq!(Palette::default_dark().primary, "#1F5FB8");
        assert_eq!(Palette::default_dark().primary_foreground, "#F7F8FA");
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

    fn with_details(required: &[&str], optional: &[&str]) -> SigninConfig {
        SigninConfig::default()
            .apply_patch(
                &json!({"required_fields": required, "optional_fields": optional}),
                no_secrets(),
            )
            .expect("details")
    }

    #[test]
    fn flows_are_validated_with_paths() {
        let base = with_details(&["email", "phone"], &["dob"]);
        let ok = base
            .apply_patch(
                &json!({"flow": {"steps": [
                    {"id": "contact", "fields": ["email", "phone"], "title": " How can we reach you? "},
                    {"id": "about-you", "fields": ["dob"], "continue_label": "Finish", "layout": "split"}
                ], "review": true}}),
                no_secrets(),
            )
            .expect("valid flow");
        let flow = ok.flow.as_ref().expect("flow");
        assert!(flow.review);
        assert_eq!(
            flow.steps[0].title.as_deref(),
            Some("How can we reach you?")
        );
        assert_eq!(flow.steps[1].layout, Some(Layout::Split));

        let err = base
            .apply_patch(
                &json!({"flow": {"steps": [
                    {"id": "Contact!", "fields": ["email", "timezone"]},
                    {"id": "b", "fields": ["email"], "colour": "red"}
                ]}}),
                no_secrets(),
            )
            .expect_err("unknown key");
        assert!(
            err.get("flow.steps[1].colour")
                .is_some_and(|m| m.contains("unknown field")),
            "{err:?}"
        );

        let err = base
            .apply_patch(
                &json!({"flow": {"steps": [
                    {"id": "Contact!", "fields": ["email", "timezone"], "title": "x".repeat(81)},
                    {"id": "b", "fields": ["email"], "continue_label": "y".repeat(31)},
                    {"id": "b", "fields": []}
                ]}}),
                no_secrets(),
            )
            .expect_err("invalid flow");
        assert!(err.get("flow.steps[0].id").is_some(), "{err:?}");
        assert!(
            err.get("flow.steps[0].fields[1]")
                .is_some_and(|m| m.contains("'timezone' is not one of the app's details")),
            "{err:?}"
        );
        assert!(err.get("flow.steps[0].title").is_some(), "{err:?}");
        assert!(
            err.get("flow.steps[1].fields[0]")
                .is_some_and(|m| m.contains("already on flow.steps[0]")),
            "{err:?}"
        );
        assert!(err.get("flow.steps[1].continue_label").is_some(), "{err:?}");
        assert!(
            err.get("flow.steps[2].id")
                .is_some_and(|m| m.contains("already the id of flow.steps[1]")),
            "{err:?}"
        );
        assert!(err.get("flow.steps[2].fields").is_some(), "{err:?}");
        assert!(
            err.get("flow.steps")
                .is_some_and(|m| m.contains("'phone' and 'dob'")),
            "{err:?}"
        );

        let err = base
            .apply_patch(&json!({"flow": {"steps": []}}), no_secrets())
            .expect_err("no steps");
        assert!(err.get("flow.steps").is_some_and(|m| m.contains("1 to 8")));
        let nine: Vec<Value> = (0..9)
            .map(|i| json!({"id": format!("s{i}"), "fields": ["email"]}))
            .collect();
        let err = base
            .apply_patch(&json!({"flow": {"steps": nine}}), no_secrets())
            .expect_err("nine steps");
        assert!(
            err.get("flow.steps")
                .is_some_and(|m| m.contains("has 9 steps"))
        );
        let err = base
            .apply_patch(
                &json!({"flow": {"steps": [{"id": "a", "fields": ["email", "phone", "dob"], "layout": "grid"}]}}),
                no_secrets(),
            )
            .expect_err("layout");
        assert!(err.get("flow.steps[0].layout").is_some(), "{err:?}");
    }

    #[test]
    fn a_flow_object_merges_into_the_default_flow() {
        let base = with_details(&["email"], &["timezone"]);
        assert_eq!(base.flow, None);
        assert_eq!(base.effective_flow(), base.default_flow());
        assert_eq!(
            base.default_flow().steps[0].fields,
            vec![ContactField::Email, ContactField::Timezone]
        );
        let c = base
            .apply_patch(&json!({"flow": {"review": true}}), no_secrets())
            .expect("review on the default flow");
        let flow = c.flow.clone().expect("flow");
        assert!(flow.review);
        assert_eq!(flow.steps.len(), 1);
        assert_eq!(flow.steps[0].id, DEFAULT_FLOW_STEP_ID);
        // Step fields replace (arrays replace); review stays.
        let c = c
            .apply_patch(
                &json!({"flow": {"steps": [{"id": "one", "fields": ["timezone"]}, {"id": "two", "fields": ["email"], "title": "Last"}]}}),
                no_secrets(),
            )
            .expect("two steps");
        assert!(
            c.flow
                .as_ref()
                .is_some_and(|f| f.review && f.steps.len() == 2)
        );
        // null resets to the default flow.
        let reset = c
            .apply_patch(&json!({"flow": null}), no_secrets())
            .expect("reset");
        assert_eq!(reset.flow, None);
        // An app with no details has no flow to configure.
        let err = SigninConfig::default()
            .apply_patch(&json!({"flow": {"review": true}}), no_secrets())
            .expect_err("nothing to ask");
        assert!(
            err.get("flow.steps")
                .is_some_and(|m| m.contains("asks for no details")),
            "{err:?}"
        );
    }

    #[test]
    fn changing_the_details_keeps_the_stored_flow_valid() {
        let c = with_details(&["email", "phone"], &["dob", "timezone"])
            .apply_patch(
                &json!({"flow": {"steps": [
                    {"id": "contact", "fields": ["email", "phone"]},
                    {"id": "about-you", "fields": ["dob", "timezone"], "title": "About you"}
                ], "review": true}}),
                no_secrets(),
            )
            .expect("flow");
        // Removing phone takes it off its step; removing dob and timezone drops their step.
        let fewer = c
            .apply_patch(
                &json!({"required_fields": ["email"], "optional_fields": []}),
                no_secrets(),
            )
            .expect("fewer details");
        let flow = fewer.flow.as_ref().expect("flow kept");
        assert_eq!(flow.steps.len(), 1);
        assert_eq!(flow.steps[0].id, "contact");
        assert_eq!(flow.steps[0].fields, vec![ContactField::Email]);
        assert!(flow.review);
        // A newly requested detail joins the last step.
        let more = c
            .apply_patch(
                &json!({"optional_fields": ["dob"], "required_fields": ["email", "phone", "timezone"]}),
                no_secrets(),
            )
            .expect("moved between lists");
        assert_eq!(
            more.flow, c.flow,
            "moving a detail between lists keeps its step"
        );
        // No details at all: back to the default flow.
        let none = c
            .apply_patch(
                &json!({"required_fields": [], "optional_fields": []}),
                no_secrets(),
            )
            .expect("no details");
        assert_eq!(none.flow, None);
        // Swapping the only detail keeps the step.
        let one = with_details(&["email"], &[])
            .apply_patch(
                &json!({"flow": {"steps": [{"id": "contact", "fields": ["email"], "title": "Reach"}]}}),
                no_secrets(),
            )
            .expect("one step")
            .apply_patch(&json!({"required_fields": ["phone"]}), no_secrets())
            .expect("swap");
        let step = &one.flow.as_ref().expect("flow").steps[0];
        assert_eq!(
            (step.id.as_str(), step.fields.clone(), step.title.as_deref()),
            ("contact", vec![ContactField::Phone], Some("Reach"))
        );
        // A patch that sends the flow is validated as sent.
        let err = c
            .apply_patch(
                &json!({"optional_fields": [], "flow": {"steps": [{"id": "contact", "fields": ["email", "phone", "dob"]}]}}),
                no_secrets(),
            )
            .expect_err("explicit flow");
        assert!(err.get("flow.steps[0].fields[2]").is_some(), "{err:?}");
    }

    #[test]
    fn copy_additions_are_validated() {
        let c = SigninConfig::default()
            .apply_patch(
                &json!({"copy": {"opening_title": "Opening {provider} for {app}…", "signup_title": "Create your account", "signup_subtitle": "It takes a minute."}}),
                no_secrets(),
            )
            .expect("valid copy");
        assert_eq!(
            c.copy.opening_title.as_deref(),
            Some("Opening {provider} for {app}…")
        );
        let err = SigninConfig::default()
            .apply_patch(
                &json!({"copy": {"opening_title": "Opening {service}", "signup_title": "x".repeat(81), "signup_subtitle": "a\u{7}b"}}),
                no_secrets(),
            )
            .expect_err("invalid copy");
        assert!(
            err.get("copy.opening_title")
                .is_some_and(|m| m.contains("'{service}'")),
            "{err:?}"
        );
        assert!(err.get("copy.signup_title").is_some());
        assert!(err.get("copy.signup_subtitle").is_some());
        assert_eq!(
            placeholders("a {b} c {d"),
            vec!["{b}".to_string(), "{d".to_string()]
        );
        // Documents stored before these existed still load.
        let old = SigninConfig::from_stored(&json!({"copy": {"title": "Hi"}}));
        assert_eq!(old.copy.title.as_deref(), Some("Hi"));
        assert_eq!(old.copy.opening_title, None);
        assert_eq!(old.flow, None);
    }

    #[test]
    fn the_effective_flow_tolerates_documents_written_around_validation() {
        let mut c = with_details(&["email"], &["timezone"]);
        c.flow = Some(FlowConfig {
            steps: vec![
                FlowStepConfig {
                    id: "a".into(),
                    fields: vec![ContactField::Phone, ContactField::Email],
                    ..Default::default()
                },
                FlowStepConfig {
                    id: "b".into(),
                    fields: vec![ContactField::Email],
                    ..Default::default()
                },
            ],
            review: true,
        });
        let flow = c.effective_flow();
        // phone isn't requested and email is already on step a; timezone joins the last step.
        assert_eq!(flow.steps.len(), 2);
        assert_eq!(flow.steps[0].fields, vec![ContactField::Email]);
        assert_eq!(flow.steps[1].fields, vec![ContactField::Timezone]);
        assert!(flow.review);
        c.flow = Some(FlowConfig {
            steps: vec![FlowStepConfig {
                id: "a".into(),
                fields: vec![ContactField::Dob],
                ..Default::default()
            }],
            review: false,
        });
        assert_eq!(
            c.effective_flow().steps[0].fields,
            vec![ContactField::Email, ContactField::Timezone],
            "a step left with only details the app doesn't ask for still gets the requested ones"
        );
        let none = SigninConfig::default().effective_flow();
        assert_eq!(none.steps.len(), 1);
        assert!(none.steps[0].fields.is_empty(), "the profile-only step");
    }

    #[test]
    fn first_party_effective_config() {
        let mut settings = Settings::for_tests();
        let c = SigninConfig::default().effective(&settings, "silicon-accounts");
        assert!(c.methods.email && c.methods.phone && !c.methods.google && !c.methods.apple);
        assert_eq!(
            c.available_methods(&settings),
            vec![Method::Email, Method::Phone]
        );
        settings.google.client_id = Some("id".into());
        settings.google.client_secret = Some(secrecy::SecretString::from("secret"));
        let c = SigninConfig::default().effective(&settings, "silicon-accounts");
        assert_eq!(
            c.available_methods(&settings),
            vec![Method::Google, Method::Email, Method::Phone]
        );
        // Managed Google without managed credentials is hidden for other apps too.
        let other = SigninConfig::default()
            .apply_patch(&json!({"methods": {"apple": true}}), no_secrets())
            .expect("valid");
        assert_eq!(other.available_methods(&settings), vec![Method::Email]);

        // The developer site: same rules, details never asked, one exact redirect URI.
        let stored = with_details(&["email"], &["timezone"])
            .apply_patch(&json!({"flow": {"review": true}}), no_secrets())
            .expect("flow");
        let dev = stored.effective(&settings, crate::DEVELOPER_APP_ID);
        assert!(dev.methods.email && dev.methods.phone);
        assert!(dev.required_fields.is_empty() && dev.optional_fields.is_empty());
        assert_eq!(dev.flow, None);
        let callback = settings.developer_callback_url();
        assert_eq!(dev.redirect_uris, vec![callback.clone()]);
        assert!(dev.redirect_allowed(&settings, crate::DEVELOPER_APP_ID, &callback));
        assert!(!dev.redirect_allowed(
            &settings,
            crate::DEVELOPER_APP_ID,
            &format!("{callback}?x=1")
        ));
        assert!(!dev.redirect_allowed(
            &settings,
            crate::DEVELOPER_APP_ID,
            &format!("{}/", settings.public_url)
        ));
    }

    #[test]
    fn origins_need_one_real_host() {
        for ok in [
            "https://app.example.com",
            "https://App.Example.com",
            "https://app.example.com:8443",
            "https://xn--bcher-kva.example",
            "http://localhost:3000",
            "http://127.0.0.1:8593",
            "http://[::1]:3000",
            "https://203.0.113.7",
        ] {
            assert_eq!(validate_origin(ok), Ok(()), "{ok}");
        }
        for wild in [
            "https://*",
            "https://*:443",
            "https://*.quill.example",
            "https://app.*.example",
            "https://a_b.example.com",
            "https://-app.example.com",
        ] {
            let msg = validate_origin(wild).expect_err(wild);
            assert!(msg.contains("must name one host"), "{wild}: {msg}");
        }
        // The other refusals keep their own messages.
        assert!(validate_origin("https://app.example.com/x").is_err());
        assert!(validate_origin("http://app.example.com").is_err());
        assert!(validate_origin("javascript:alert(1)").is_err());
    }

    #[test]
    fn type_mistakes_read_as_plain_words() {
        let mistake = |patch: Value, path: &str| -> String {
            let err = SigninConfig::default()
                .apply_patch(&patch, no_secrets())
                .expect_err("invalid");
            err.get(path)
                .unwrap_or_else(|| panic!("no error at {path}: {err:?}"))
                .to_string()
        };
        assert_eq!(
            mistake(json!({"branding": {"radius": 12.5}}), "branding.radius"),
            "must be a whole number from 0 to 40 (pixels), not 12.5"
        );
        assert_eq!(
            mistake(json!({"branding": {"radius": "big"}}), "branding.radius"),
            "must be a whole number from 0 to 40 (pixels), not \"big\""
        );
        assert_eq!(
            mistake(
                json!({"branding": {"logo_height": -4}}),
                "branding.logo_height"
            ),
            "must be a whole number from 16 to 96 (pixels), not -4"
        );
        assert_eq!(
            mistake(
                json!({"branding": {"show_app_name": "yes"}}),
                "branding.show_app_name"
            ),
            "must be true or false, not \"yes\""
        );
        let font = mistake(
            json!({"branding": {"font_family": "Comic Sans"}}),
            "branding.font_family",
        );
        assert!(font.starts_with("'Comic Sans' is not one of "), "{font}");
        assert!(!font.contains('`') && !font.contains("expected"), "{font}");
        assert_eq!(
            plain_serde_message("x", "invalid type: map, expected a string"),
            "must be text (a JSON string), not an object"
        );
        assert_eq!(
            plain_serde_message("x", "invalid type: sequence, expected a boolean"),
            "must be true or false, not a list"
        );
        assert_eq!(
            plain_serde_message("x", "missing field `y`"),
            "missing field `y`"
        );
    }
}
