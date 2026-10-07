/**
 * Every request and response shape of the Silicon Accounts HTTP API, as the account site sees it. Field names are the
 * wire names (snake_case). These follow what the Rust server really sends (crates/*, checked against the integration
 * notes and the client contract journey), which wins over the spec where they differ; differences from the first
 * (SolidJS) client are noted where they matter.
 *
 * Conventions: timestamps are RFC 3339 UTC strings with milliseconds ("2026-10-06T12:00:00.000Z"), dates are
 * "YYYY-MM-DD", ids are `c:handle` / `si:handle`, account uuids are short base62 strings ("a8K"), and membership ids
 * are `{app_id}:{uuid}`. Lists come back as `Page<T>` (`{items, next_cursor}`).
 */

/* ------------------------------------------------------------------------------------------------------------------ */
/* Scalars and enums                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

/** RFC 3339 UTC timestamp with milliseconds. */
export type Timestamp = string;
/** A calendar date, `YYYY-MM-DD`. */
export type DateString = string;
/** `c:handle` for Carbons, `si:handle` for Silicons. */
export type AccountId = string;

/** Open string unions: the listed values are the known ones; the server may add more without breaking the types. */
type Open<T extends string> = T | (string & {});

export type AccountKind = "carbon" | "silicon";
export type AccountStatus = "active" | "unclaimed" | "pending_custodian" | "deleted";
export type AppStatus = "active" | "disabled";
export type AppSource = "first_party" | "fake" | "silicon_apps";
export type MembershipStatus = "active" | "access_removed" | "imported";
export type MembershipSource = "signin" | "slt" | "import";
export type TokenOrigin = "authorization_code" | "slt" | "silicon_login" | "device" | "cli_code";
export type VerifiedVia = "code" | "google" | "apple";
export type Provider = "google" | "apple";
/** Carbon sign-in methods an app can enable. */
export type SigninMethod = "google" | "apple" | "email" | "phone";
/** Account details an app can require or optionally ask for. */
export type ContactField = "email" | "phone" | "dob" | "timezone";
/** OAuth scopes. `profile` is always granted; `openid` adds an id_token; `offline_access` is accepted and ignored. */
export type Scope = "profile" | "email" | "phone" | "dob" | "timezone" | "openid" | "offline_access";
export type OtpChannel = "email" | "phone";

/** One page of a list endpoint. Pass `next_cursor` back as `cursor` for the next page; null on the last page. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** Paging parameters accepted by every list endpoint (`limit` 1..200, default 50). */
export interface PageQuery {
  limit?: number;
  cursor?: string | null;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Errors                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The body of every non-OAuth error: `{"error": {...}}`. */
export interface ApiErrorBody {
  error: {
    code: string;
    /** Exactly what went wrong and why. */
    message: string;
    /** What to do next. */
    hint?: string | null;
    /**
     * Machine-readable extras: `fields` (422), `retry_after_seconds` / `locked_until` (429/423),
     * `remaining_attempts`, `suggestions`, `redirect_to` (flow creation), `request_id` (500)…
     */
    details?: Record<string, unknown>;
  };
}

/** RFC 6749 error body used by /v1/oauth/token, /revoke and /introspect. */
export interface OAuthErrorBody {
  error: string;
  error_description?: string;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Accounts                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Public-ish identity used in lookups, custodian references and lists. `id` is null once an account is deleted. */
export interface AccountSummary {
  uuid: string;
  kind: AccountKind;
  id: AccountId | null;
  display_name: string;
  pfp_url: string;
  status: AccountStatus;
  /** Present on `GET /v1/accounts/{uuid}` for Silicons. */
  custodian?: AccountSummary | null;
}

/** A Silicon's custodian as apps see it. */
export interface CustodianRef {
  uuid: string;
  id: AccountId | null;
}

/** An email in `Me.emails`. `GET /v1/me/emails` items also carry `created_at`. */
export interface EmailView {
  email: string;
  is_primary: boolean;
  verified_at: Timestamp | null;
  verified_via: VerifiedVia | null;
  /** On the `/v1/me/emails` list (not inside Me). */
  created_at?: Timestamp;
}

/** A phone in `Me.phones`. `GET /v1/me/phones` items also carry `verified_via` and `created_at`. */
export interface PhoneView {
  /** E.164, for example "+919876543210". */
  phone: string;
  is_primary: boolean;
  verified_at: Timestamp | null;
  /** On the `/v1/me/phones` list (not inside Me). */
  verified_via?: VerifiedVia | null;
  created_at?: Timestamp;
}

/** A linked Google or Apple identity. */
export interface IdentityView {
  provider: Provider;
  /** The provider's subject (needed to unlink). */
  subject: string;
  email: string | null;
  created_at: Timestamp;
  last_used_at: Timestamp | null;
}

interface MeBase {
  uuid: string;
  kind: AccountKind;
  id: AccountId | null;
  display_name: string;
  pfp_url: string;
  dob: DateString;
  /** IANA time zone, for example "Asia/Kolkata". */
  timezone: string;
  status: AccountStatus;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: number;
}

/** `GET /v1/me` for a Carbon. */
export interface CarbonMe extends MeBase {
  kind: "carbon";
  emails: EmailView[];
  phones: PhoneView[];
  identities: IdentityView[];
  /** How many Silicons this Carbon is custodian of. */
  custodian_of: number;
}

/** `GET /v1/me` for a Silicon (also the Silicon view the custodian endpoints return). */
export interface SiliconMe extends MeBase {
  kind: "silicon";
  custodian: AccountSummary | null;
  webhook_url: string | null;
  stk_rotated_at: Timestamp | null;
}

/** The full own view of the signed-in account. Narrow on `kind`. */
export type Me = CarbonMe | SiliconMe;

/** What an app sees about an account; the granted scopes decide which contact fields are present. */
export interface AccountForApp {
  uuid: string;
  membership_id: string;
  kind: AccountKind;
  id: AccountId | null;
  display_name: string;
  pfp_url: string;
  /** Scope `email`, Carbons only (primary email). */
  email?: string;
  email_verified?: boolean;
  /** Scope `phone`, Carbons only (primary phone). */
  phone?: string;
  phone_verified?: boolean;
  /** Scope `dob`. */
  dob?: DateString;
  /** Scope `timezone`. */
  timezone?: string;
  /** Silicons only, always. */
  custodian?: CustodianRef;
  updated_at: Timestamp;
  version: number;
}

/** `PATCH /v1/me`. Unknown or read-only fields answer 422 naming the right endpoint. */
export interface ProfileUpdate {
  display_name?: string;
  timezone?: string;
  /** Carbons only: a Silicon's date of birth is the day it was created (422 `dob_immutable`). */
  dob?: DateString;
  /** https URL, your own upload exactly as POST /v1/me/photo returned it, or null to go back to the default photo. */
  pfp_url?: string | null;
}

/** `GET /v1/ids/available?id=`. Invalid ids answer 200 with reason "invalid" and a precise message. */
export interface IdAvailability {
  id: string;
  available: boolean;
  reason: "taken" | "reserved" | "reserved_word" | "invalid" | null;
  /** Says exactly why (or that it is free). */
  message: string;
  /** True when the id is the caller's own reserved id and can be taken back. */
  reclaimable: boolean;
  /** Free ids close to the one asked for, when it can't be taken. */
  suggestions?: string[];
}

/** The stored photo of an upload. */
export interface PhotoInfo {
  id: string;
  content_type: string;
  bytes: number;
  width: number;
  height: number;
}

/** `POST /v1/me/photo` (201): the new photo URL, the stored photo and the refreshed Me view. */
export interface PhotoUploaded {
  pfp_url: string;
  photo: PhotoInfo;
  me: Me;
}

/** `POST /v1/flows/{id}/signup/photo` (201): the photo picked at sign-up, kept with the sign-up until it finishes. */
export interface SignupPhoto {
  pfp_url: string;
  photo: PhotoInfo;
}

/** `POST /v1/me/silicons/{uuid}/photo` (201): a custodian's upload for one of its Silicons. */
export interface SiliconPhotoUploaded {
  pfp_url: string;
  photo: PhotoInfo;
  silicon: ManagedSilicon;
}

/** `POST /v1/me/emails` | `/v1/me/phones` (201): a code was sent; verify it with the challenge id. */
export interface ContactChallenge {
  challenge_id: string;
  channel: OtpChannel;
  /** Masked destination, for example "s***@gmail.com". */
  destination: string;
  expires_at: Timestamp;
  /** When "Resend" becomes useful (UI hint). */
  resend_available_at: Timestamp;
}

/** An app the account has signed into (`GET /v1/me/apps`). The first-party app `accounts` is never listed. */
export interface MyApp {
  app: AppSummary;
  membership_id: string;
  status: MembershipStatus;
  /** How the membership started. */
  source: MembershipSource;
  granted_scopes: Scope[];
  first_signed_in_at: Timestamp | null;
  last_signed_in_at: Timestamp | null;
  /** Live token families the app holds for this account. */
  active_sessions: number;
  /** When the account removed the app's access (status `access_removed`). */
  access_removed_at: Timestamp | null;
}

/** A browser session or a first-party (CLI / Silicon) sign-in (`GET /v1/me/sessions`). */
export interface SessionInfo {
  id: string;
  kind: "browser" | "cli";
  /** How it was created: browser, device, cli_code, silicon_login… */
  origin: Open<"browser" | "device" | "cli_code" | "silicon_login">;
  label: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Timestamp;
  last_seen_at: Timestamp | null;
  /** When it ends unless used or revoked. */
  expires_at: Timestamp | null;
  /** The session this request was made with. */
  current: boolean;
}

export type HistoryKind = "signin" | "id_change" | "custodian" | "proof" | "app_access" | "security";

/**
 * One entry of `GET /v1/me/history`. `meta` depends on the row it came from:
 * signin `{method, outcome, ip, user_agent}`; id_change `{old_id, new_id, changed_by}`; custodian
 * `{kind, silicon, from, to}`; app_access `{membership_id, source}`; audit rows `{action, actor_kind, actor_id,
 * target_kind, target_id, ip, details}`. Accounts in meta are uuids or summaries, never trust them as display text.
 */
export interface HistoryItem {
  id: string;
  kind: HistoryKind;
  at: Timestamp;
  title: string;
  detail: string | null;
  app: AppSummary | null;
  meta: Record<string, unknown>;
}

export interface HistoryQuery extends PageQuery {
  kind?: HistoryKind;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Meta and discovery                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface Meta {
  name: string;
  version: string;
  environment: "development" | "test" | "production";
  /** Browser-facing origin of the site and API (the OIDC issuer). */
  public_url: string;
  /** Where apps are created ("Make a new app" opens it). */
  silicon_apps_url: string;
  /** Whether managed ("one click") Google and Apple credentials are configured. */
  providers: { google: boolean; apple: boolean };
  delivery: "local" | "providers";
  /**
   * Where the docs live. The server always sends it (ACCOUNTS_DOCS_URL, by default this site's /docs at
   * https://accounts.teamofsilicons.com/docs): the landing page links it (as a local link when it is this site's /docs).
   */
  docs_url?: string | null;
  /**
   * The developer site (ACCOUNTS_DEVELOPER_URL; https://developer.teamofsilicons.com, http://localhost:8600 in
   * development), where apps' sign-in is set up. The dock's Developer item and /developer[/*] lead there. Optional for
   * servers before it existed (the site then uses the production address).
   */
  developer_url?: string | null;
}

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  revocation_endpoint: string;
  introspection_endpoint: string;
  device_authorization_endpoint: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  id_token_signing_alg_values_supported: string[];
  scopes_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  claims_supported: string[];
  [extra: string]: unknown;
}

export interface Jwk {
  kty: string;
  crv?: string;
  x?: string;
  kid?: string;
  use?: string;
  alg?: string;
}

export interface Jwks {
  keys: Jwk[];
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Apps, sign-in configuration and branding                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface AppSummary {
  app_id: string;
  name: string;
  logo_url: string | null;
  logo_dark_url?: string | null;
  homepage_url: string | null;
}

export type ThemeMode = "auto" | "light" | "dark";
/** The branding font allowlist. */
export type BrandFont =
  | "Geist"
  | "Inter"
  | "IBM Plex Sans"
  | "DM Sans"
  | "Space Grotesk"
  | "Source Serif 4"
  | "Fraunces"
  | "Instrument Serif"
  | "JetBrains Mono"
  | "System";
export type CornerStyle = "squircle" | "rounded" | "sharp";
export type ButtonStyle = "solid" | "soft" | "outline";
export type BrandLayout = "card" | "split" | "minimal";
export type BackgroundStyle = "plain" | "dots" | "grain" | "gradient" | "image";
export type Density = "comfortable" | "compact";

/** One theme's colours, each `#RRGGBB`. */
export interface Palette {
  primary: string;
  primary_foreground: string;
  background: string;
  surface: string;
  foreground: string;
  muted: string;
  border: string;
  danger: string;
}

/** Branding variables of the hosted pages. "Powered by Silicon Accounts" is not configurable. */
export interface Branding {
  theme: ThemeMode;
  logo_url: string | null;
  logo_dark_url: string | null;
  /** 16..96 px. */
  logo_height: number;
  show_app_name: boolean;
  font_family: BrandFont;
  /** null = font_family. */
  heading_font_family: BrandFont | null;
  corner_style: CornerStyle;
  /** 0..40 px; controls use it, panels scale from it. */
  radius: number;
  button_style: ButtonStyle;
  layout: BrandLayout;
  background_style: BackgroundStyle;
  /** https only; required when background_style is "image". */
  background_image_url: string | null;
  density: Density;
  light: Palette;
  dark: Palette;
}

/** Texts and links on the hosted pages (every one optional: null keeps the page's own words). */
export interface SigninCopy {
  /** The sign-in page's title (intent=signin), ≤ 80 characters. */
  title: string | null;
  /** ≤ 200 characters. */
  subtitle: string | null;
  terms_url: string | null;
  privacy_url: string | null;
  support_email: string | null;
  /**
   * The Opening page's title, ≤ 80 characters; `{provider}` (Google or Apple) and `{app}` (the app's name) are filled
   * in. Default "Opening {provider} to sign you in to {app}…". Optional for servers before v2.
   */
  opening_title?: string | null;
  /** The sign-up page's title (intent=signup), ≤ 80 characters. Default "Create your {app} account". */
  signup_title?: string | null;
  /** The sign-up page's subtitle, ≤ 200 characters. */
  signup_subtitle?: string | null;
}

export interface GoogleConfig {
  mode: "managed" | "byo";
  /** BYO OAuth client id (required when mode is byo). */
  client_id: string | null;
  /** select_account | consent | none | "consent select_account". */
  prompt: string | null;
  /** Google `hd` (Workspace domain) hint. */
  hosted_domain: string | null;
}

export interface AppleConfig {
  mode: "managed" | "byo";
  services_id: string | null;
  team_id: string | null;
  key_id: string | null;
}

/** An app's whole sign-in configuration (no secrets). */
export interface SigninConfig {
  methods: { email: boolean; phone: boolean; google: boolean; apple: boolean };
  method_order: SigninMethod[];
  google: GoogleConfig;
  apple: AppleConfig;
  redirect_uris: string[];
  /** Origins that may embed the iframe (frame-ancestors). The SDK's own buttons work on any site. */
  allowed_origins: string[];
  required_fields: ContactField[];
  optional_fields: ContactField[];
  /** [] = any domain; else only these may sign in via email/Google/Apple. */
  allowed_email_domains: string[];
  /** false = only existing (or imported) accounts may sign in. */
  allow_signup: boolean;
  /** Offer "Continue as …" from the browser session. */
  remember_browser: boolean;
  branding: Branding;
  copy: SigninCopy;
  /**
   * Which details the Carbon sees on which page, in what order (null: one page with every requested detail, which is
   * the what's-shared screen, and no review). Optional for servers before v2.
   */
  flow?: SigninFlow | null;
}

/** One page of an app's flow: which requested details it asks, with its own words and layout. */
export interface SigninFlowStep {
  /** `[a-z0-9-]{1,40}`, unique in the flow. */
  id: string;
  /** At least one; every requested detail appears in exactly one step. */
  fields: ContactField[];
  /** ≤ 80 characters; null keeps the page's own title. */
  title: string | null;
  /** ≤ 200 characters. */
  subtitle: string | null;
  /** ≤ 30 characters ("Continue" / "Share and continue" when null). */
  continue_label: string | null;
  /** null = the branding's layout. */
  layout: BrandLayout | null;
}

/** An app's flow: 1..8 steps of details, then an optional review page of everything shared. */
export interface SigninFlow {
  steps: SigninFlowStep[];
  review: boolean;
}

/** The configuration as `GET /v1/apps/{app_id}` shows it: secrets are never returned, only whether they are set. */
export interface SigninConfigView extends Omit<SigninConfig, "google" | "apple"> {
  google: GoogleConfig & { client_secret_set: boolean };
  apple: AppleConfig & { private_key_set: boolean };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object | null ? DeepPartial<NonNullable<T[K]>> | null : T[K] | null };

/**
 * `PATCH /v1/apps/{app_id}/signin-config` body: a partial SigninConfig (objects merge, arrays replace, null resets a
 * field to its default) plus optional BYO secrets and an optimistic-concurrency version. ≤ 512 KB.
 */
export type SigninConfigPatch = DeepPartial<Omit<SigninConfig, "google" | "apple" | "flow">> & {
  /** The whole flow (its steps array replaces the stored one), or null for the default. */
  flow?: SigninFlow | null;
  google?: DeepPartial<GoogleConfig> & { client_secret?: string };
  apple?: DeepPartial<AppleConfig> & { private_key?: string };
  /** 409 `config_version_conflict` when the stored version moved on. */
  expected_version?: number;
};

/** `GET /v1/apps/{app_id}/public` (CORS *): what the hosted pages, iframe and SDK need. */
export interface AppPublic {
  app_id: string;
  name: string;
  logo_url: string | null;
  logo_dark_url: string | null;
  homepage_url: string | null;
  methods: SigninMethod[];
  branding: Branding;
  copy: SigninCopy;
  /**
   * Origins allowed to frame the embed (the app's sign-in setup). Being added to this endpoint by the server; when it
   * is missing, treat it as "none configured".
   */
  allowed_origins?: string[];
}

/** `GET /v1/me/owned-apps` items. */
export interface OwnedApp {
  app_id: string;
  name: string;
  logo_url: string | null;
  status: AppStatus;
  source: AppSource;
  /** Live members: active or imported memberships of accounts that are not deleted. */
  users: number;
  created_at: Timestamp;
}

/** `GET /v1/apps/{app_id}` (app or its owner). */
export interface AppDetail {
  app_id: string;
  name: string;
  description: string | null;
  logo_url: string | null;
  logo_dark_url: string | null;
  homepage_url: string | null;
  owner: AccountSummary | null;
  status: AppStatus;
  source: AppSource;
  created_at: Timestamp;
  updated_at: Timestamp;
  signin_config: SigninConfigView;
  /** 0 when never configured. */
  config_version: number;
  webhook: { url: string | null; secret_set: boolean };
  stats: { users: number; active_last_30d: number; imported_unclaimed: number };
}

/** `GET /v1/apps/{app_id}/signin-config/history` items. */
export interface ConfigHistoryItem {
  version: number;
  /** Who saved it, as stored: an account uuid, or a marker such as "app" or "silicon_apps". */
  actor: string | null;
  /** The account behind `actor`, when it is one. */
  actor_account: AccountSummary | null;
  /** Redacted diff of what changed (paths to before/after values; secrets never appear). */
  changes: unknown;
  at: Timestamp;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* User base and imports                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

export type AppUserStatus = MembershipStatus | "deleted";

/** One row of an app's user base. Contact fields appear only within granted scopes (or as imported for `imported`). */
export interface AppUser {
  membership_id: string;
  uuid: string;
  kind: AccountKind;
  id: AccountId | null;
  display_name: string;
  pfp_url: string;
  email?: string | null;
  phone?: string | null;
  dob?: DateString | null;
  timezone?: string | null;
  status: AppUserStatus;
  /** The account's own status (a deleted account stays in the user base as history). */
  account_status: AccountStatus;
  source: MembershipSource;
  external_id: string | null;
  granted_scopes: Scope[];
  first_signed_in_at: Timestamp | null;
  last_signed_in_at: Timestamp | null;
  created_at: Timestamp;
}

/** One sign-in in a user's detail (no IP or user agent: those stay with the account). */
export interface SigninHistoryEntry {
  at: Timestamp;
  method: string | null;
  outcome: string | null;
}

export interface AppUserDetail extends AppUser {
  /** The last 20 sign-ins. */
  history: SigninHistoryEntry[];
}

export interface AppUsersQuery extends PageQuery {
  /** Matches id, display name, email, phone and external_id. */
  q?: string;
  status?: AppUserStatus;
  kind?: AccountKind;
  source?: MembershipSource;
}

/** The only columns an import may carry. */
export interface ImportRow {
  external_id?: string;
  email?: string;
  /** Array, or a `;`-separated string. */
  emails?: string[] | string;
  phone?: string;
  phones?: string[] | string;
  display_name?: string;
  /** Alias of display_name. */
  name?: string;
  /** Desired handle without prefix, or `c:…`. */
  username?: string;
  dob?: string;
  timezone?: string;
  pfp_url?: string;
  /** Informational only; never trusted. */
  email_verified?: boolean | string;
}

export const IMPORT_COLUMNS = [
  "external_id", "email", "emails", "phone", "phones", "display_name", "name", "username", "dob", "timezone", "pfp_url", "email_verified",
] as const;

export interface ImportOptions {
  /** ISO country for local-format phone numbers, e.g. "US". */
  default_country?: string;
  ignore_unknown_columns?: boolean;
  dry_run?: boolean;
  update_existing?: boolean;
}

export type ImportJobStatus = Open<"queued" | "running" | "completed" | "failed">;

export interface ImportJob {
  id: string;
  app_id: string;
  status: ImportJobStatus;
  format: "json" | "csv";
  total_rows: number;
  processed_rows: number;
  counts: { created: number; matched: number; updated: number; skipped: number; error: number; warnings: number };
  options: ImportOptions;
  dry_run: boolean;
  /** The account (uuid) or app that started it. */
  created_by: string | null;
  created_at: Timestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
  error: string | null;
}

export type ImportOutcome = "created" | "matched" | "updated" | "skipped" | "error";

export interface ImportRowMessage {
  level: "error" | "warning" | "info";
  /** For example `id_conflict`, `invalid_phone`, `duplicate_in_file`, `ambiguous_match`. */
  code: string;
  message: string;
  field: string | null;
}

export interface ImportRowResult {
  row_number: number;
  outcome: ImportOutcome;
  account_uuid: string | null;
  id: AccountId | null;
  messages: ImportRowMessage[];
  input: Record<string, unknown>;
}

export interface ImportRowsQuery extends PageQuery {
  outcome?: ImportOutcome;
  /** Rows that carry a message of this level. */
  level?: ImportRowMessage["level"];
  /** Rows that carry a message with this code. */
  code?: string;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Webhooks                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export type DeliveryStatus = "pending" | "delivered" | "failed";

/** `GET /v1/apps/{app_id}/webhook/deliveries` items. */
export interface WebhookDelivery {
  id: string;
  event_id: string;
  type: string;
  /** The account the event is about (null for `ping`). */
  account_uuid: string | null;
  /** Where it is (or was last) sent. */
  url: string;
  status: DeliveryStatus;
  /** How many attempts so far (a count; the detail view lists them). */
  attempts: number;
  /** HTTP status of the last attempt. */
  last_status: number | null;
  last_error: string | null;
  /** Only pending deliveries have a next attempt. */
  next_attempt_at: Timestamp | null;
  last_attempt_at: Timestamp | null;
  delivered_at: Timestamp | null;
  created_at: Timestamp;
  manual_replays: number;
}

export interface WebhookAttempt {
  attempted_at: Timestamp;
  status_code: number | null;
  error: string | null;
  duration_ms: number;
}

/**
 * `GET /v1/apps/{app_id}/webhook/deliveries/{id}`: the same flat object as a list item, except that `attempts` is the
 * list of attempts and `attempt_count` the count, plus the payload (redacted to who it was about when the app lost
 * access to the account; such a delivery can't be replayed).
 */
export interface WebhookDeliveryDetail extends Omit<WebhookDelivery, "attempts"> {
  attempts: WebhookAttempt[];
  attempt_count: number;
  payload: WebhookEvent | Record<string, unknown> | null;
  payload_redacted: boolean;
  payload_redacted_reason?: string;
}

export interface DeliveriesQuery extends PageQuery {
  status?: DeliveryStatus;
}

export type ReplayRequest = { delivery_ids: string[] } | { status: "failed"; since?: Timestamp };

export interface ReplaySkip {
  delivery_id: string;
  event_id?: string;
  type?: string;
  reason: string;
  message: string;
}

/** `POST /v1/apps/{app_id}/webhook/replay`. */
export interface ReplayResult {
  /** Ids of the deliveries queued again (to the current URL, signed with the current secret). */
  replayed: string[];
  /** Deliveries not replayed, with why (for example the account no longer has access). */
  skipped: ReplaySkip[];
  /** Replayable failed deliveries still waiting (call again until 0). */
  remaining: number;
  /** Failed deliveries that will never be sent. */
  not_replayable: number;
  url: string;
}

/** `POST /v1/apps/{app_id}/webhook/test` (202). */
export interface WebhookTestQueued {
  event_id: string;
  delivery_id: string;
  type: "ping";
}

/** `POST /v1/me/webhook/test` (202), a Silicon's own webhook. */
export interface SiliconWebhookTestQueued extends WebhookTestQueued {
  url: string;
  /** Older pings that were still waiting and were dropped for this one. */
  superseded_pings: number;
}

/** The body Silicon Accounts POSTs to a webhook (headers carry X-Accounts-Signature: v1=<hex>). */
export interface WebhookEvent {
  event_id: string;
  type: string;
  occurred_at: Timestamp;
  app_id: string | null;
  silicon: string | null;
  data: Record<string, unknown>;
}

export const APP_EVENT_TYPES = [
  "account.id_changed", "account.updated", "account.deleted", "membership.signed_out", "membership.access_removed",
  "silicon.custodian_changed", "ping",
] as const;

export const SILICON_EVENT_TYPES = [
  "silicon.created", "silicon.custodian.accepted", "silicon.custodian.declined", "silicon.custodian.expired",
  "silicon.updated", "silicon.id_changed", "silicon.stk_rotated", "silicon.custodian.changed", "ping",
] as const;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Hosted sign-in flow                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

/** `failed` is used for prompt=none: its redirect_to carries the error and the page should go there. */
export type FlowStep = "choose_method" | "verify_code" | "signup" | "requirements" | "consent" | "complete" | "failed";

export type FlowPrompt = "login" | "consent" | "select_account" | "none";

/** `POST /v1/flows` body: the /authorize query, as JSON. state and nonce are byte-exact. */
export interface FlowCreate {
  app_id?: string;
  /** Alias of app_id. */
  client_id?: string;
  redirect_uri: string;
  /** Only `code`. */
  response_type?: string;
  state?: string;
  code_challenge?: string;
  /** Missing means S256. */
  code_challenge_method?: "S256" | "plain";
  /** Space-separated, for example "openid email". */
  scope?: string;
  nonce?: string;
  prompt?: FlowPrompt;
  login_hint?: string;
  /** Jump straight to one enabled method. */
  method?: SigninMethod;
  /** The browser's IANA time zone (Intl), the fallback for the sign-up suggestion. */
  timezone?: string;
}

export interface FlowChallenge {
  channel: OtpChannel;
  /** Masked, for example "s***@gmail.com". */
  destination: string;
  expires_at: Timestamp;
  /** When "Resend" becomes useful (UI hint). */
  resend_available_at: Timestamp;
}

export interface FlowSignup {
  display_name: string;
  id: AccountId;
  timezone: string;
  dob: DateString;
  /** The suggested photo (Iris default), or null for the default. */
  pfp_url: string | null;
  email: string | null;
  phone: string | null;
  provider: Provider | null;
  /** The photo Google reported, offered as an option. */
  provider_pfp_url: string | null;
  /** True when an imported account is finishing its setup. */
  finishing_import: boolean;
  /**
   * When finishing an import: the app whose import created the account (it may be another app than the one being
   * signed into); null for a new account or when no import is on record. Optional for servers before it existed.
   */
  imported_by?: { app_id: string; name: string } | null;
  expires_at: Timestamp;
}

export interface ConsentRow {
  scope: Scope;
  label: string;
  value: string | null;
}

export interface FlowConsent {
  /** `required[0]` is always `profile`. Contact values are masked. */
  required: ConsentRow[];
  /** `granted` is the toggle's initial state. */
  optional: Array<ConsentRow & { granted: boolean }>;
  previously_granted: Scope[];
}

/** The state of a hosted sign-in, driven by `step`. */
export interface FlowView {
  id: string;
  step: FlowStep;
  expires_at: Timestamp;
  app: {
    app_id: string;
    name: string;
    logo_url: string | null;
    logo_dark_url: string | null;
    homepage_url: string | null;
    branding: Branding;
    copy: SigninCopy;
    first_party: boolean;
  };
  /** Enabled methods, in the configured order. */
  methods: SigninMethod[];
  /** The browser session's account (unless prompt=login). */
  signed_in_as: AccountSummary | null;
  challenge: FlowChallenge | null;
  signup: FlowSignup | null;
  requirements: { missing: ContactField[]; challenge: FlowChallenge | null } | null;
  consent: FlowConsent | null;
  /** Set on `complete` and `failed`: where to send the browser. */
  redirect_to: string | null;
  error: { code: string; message: string; hint: string | null } | null;
  /** The /authorize parameters the flow was created with. */
  prompt: FlowPrompt | null;
  login_hint: string | null;
  method_hint: SigninMethod | null;
}

export interface FlowEnvelope {
  flow: FlowView;
}

/** `POST /v1/flows/{id}/signup`: every field is optional; an omitted field keeps the prefill. */
export interface SignupSubmit {
  display_name?: string;
  id?: AccountId;
  timezone?: string;
  dob?: DateString;
  /** An external https URL, or null for the default photo (photos of this service are refused here). */
  pfp_url?: string | null;
}

export interface ConsentSubmit {
  approve: boolean;
  optional_scopes?: Scope[];
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Browser session, device approval and CLI sign-in                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

/** `GET /v1/session` (401 unauthenticated when there is none). */
export interface BrowserSession {
  account: AccountSummary;
  session: {
    id: string;
    /** "browser" for the cookie session; "token" when a first-party bearer token asks. */
    kind: "browser" | "token";
    created_at: Timestamp;
    expires_at: Timestamp;
    last_seen_at: Timestamp | null;
    label?: string | null;
    access_token_expires_at?: Timestamp | null;
  };
}

export interface DeviceAuthorization {
  device_code: string;
  /** XXXX-XXXX. */
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  expires_at: Timestamp;
  interval: number;
}

/** `GET /v1/device/{user_code}` (case-insensitive, dash optional). */
export interface DeviceRequest {
  user_code: string;
  client_label: string | null;
  created_at: Timestamp;
  expires_at: Timestamp;
  status: Open<"pending" | "approved" | "denied" | "consumed" | "expired">;
}

export interface CliLoginChallenge {
  challenge_id: string;
  destination: string;
  expires_at: Timestamp;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* OAuth / OIDC (apps)                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_at: Timestamp;
  scope: string;
  id_token?: string;
  membership_id: string;
  account: AccountForApp;
}

export type TokenRequest =
  | { grant_type: "authorization_code"; code: string; redirect_uri: string; code_verifier?: string; client_id?: string; client_secret?: string }
  | { grant_type: "refresh_token"; refresh_token: string; client_id?: string; client_secret?: string }
  | { grant_type: "urn:silicon:params:oauth:grant-type:slt" | "slt"; slt: string; client_id?: string; client_secret?: string }
  | { grant_type: "urn:ietf:params:oauth:grant-type:device_code"; device_code: string; client_id: "accounts" };

export interface Introspection {
  active: boolean;
  sub?: string;
  aud?: string;
  exp?: number;
  iat?: number;
  scope?: string;
  kind?: AccountKind;
  id?: AccountId;
  membership_id?: string;
  token_type?: "access_token" | "refresh_token";
}

/** `/v1/userinfo`: AccountForApp plus the OIDC aliases. */
export interface UserInfo extends AccountForApp {
  sub: string;
  name: string;
  picture: string;
  phone_number?: string;
  phone_number_verified?: boolean;
  zoneinfo?: string;
  birthdate?: DateString;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Silicons and custodians                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

/** `POST /v1/silicons` (a Silicon creating its own account). */
export interface SiliconSelfCreate {
  id: AccountId;
  display_name: string;
  /** `c:handle` or an email address. */
  custodian: string;
  timezone?: string;
  pfp_url?: string;
  /** Self-set STK: `stk-` + 8..32 hex (bare hex is accepted). Omit to have one generated. */
  stk?: string;
  webhook_url?: string;
}

export type CustodianRequestState = Open<"pending" | "accepted" | "declined" | "expired" | "cancelled">;

export interface CustodianRequestInfo {
  id: string;
  kind: "initial";
  status: CustodianRequestState;
  expires_at: Timestamp;
  /** The named custodian (`c:id`, or a masked email). */
  custodian: string;
}

export interface SiliconSelfCreated {
  silicon: ManagedSilicon;
  /** Only when generated; shown exactly once. */
  stk: string | null;
  request: CustodianRequestInfo;
  /** `sarq_…`: polls the request status. */
  request_token: string;
  webhook_secret: string | null;
}

/** `GET /v1/silicons/requests/{id}` with the `sarq_…` request token. */
export interface CustodianRequestStatus {
  id: string;
  kind: "initial" | "transfer";
  status: CustodianRequestState;
  custodian: string;
  created_at: Timestamp;
  expires_at: Timestamp;
  decided_at: Timestamp | null;
  silicon: { uuid: string; id: AccountId | null; status: AccountStatus };
}

/** `POST /v1/me/silicons` (a Carbon creating a Silicon it is custodian of). Unknown fields answer 422. */
export interface CreateSilicon {
  id: AccountId;
  display_name: string;
  timezone?: string;
  pfp_url?: string;
  stk?: string;
  webhook_url?: string;
}

export interface SiliconCreated {
  silicon: ManagedSilicon;
  /** Only when generated; shown exactly once. */
  stk: string | null;
  webhook_secret: string | null;
}

/**
 * Who a custodian request names: the Carbon as an AccountSummary, `{email}` when named by an email address, `{uuid}`
 * when that account can no longer be read, or null.
 */
export type RequestRecipient = AccountSummary | { email: string } | { uuid: string } | null;

export interface PendingTransfer {
  id: string;
  to: RequestRecipient;
  created_at: Timestamp;
  expires_at: Timestamp;
}

/** `GET /v1/me/silicons` items: the Silicon view plus any pending transfer. `{uuid}` paths also accept the si:id. */
export type ManagedSilicon = SiliconMe & { pending_transfer: PendingTransfer | null };

/** `PATCH /v1/me/silicons/{uuid}`. A photo of this service must be the custodian's or the Silicon's own upload. */
export interface UpdateSilicon {
  display_name?: string;
  timezone?: string;
  pfp_url?: string | null;
}

export interface StkRotated {
  /** Only when generated; shown exactly once. */
  stk: string | null;
  rotated_at: Timestamp;
  /** Sessions and token families that were signed out. */
  revoked_sessions: number;
}

export interface SiliconWebhook {
  webhook_url: string;
  /** `whsec_…`, shown once each time the URL is set. */
  webhook_secret: string;
}

/** A custodian request as Carbons see it (incoming requests, and a new transfer). */
export interface CustodianRequest {
  id: string;
  kind: "initial" | "transfer";
  status: CustodianRequestState;
  silicon: AccountSummary;
  /** The current custodian for a transfer; null for a Silicon's own request. */
  from: AccountSummary | null;
  to: RequestRecipient;
  created_at: Timestamp;
  expires_at: Timestamp;
  decided_at: Timestamp | null;
}

/** `POST /v1/me/silicons/{uuid}/transfer` (201): the new transfer request. */
export type TransferRequest = CustodianRequest & { kind: "transfer" };

export interface ShortLivedToken {
  slt: string;
  app_id: string;
  expires_at: Timestamp;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Proofs (OBO and ATA)                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

export type ProofKind = "obo" | "ata";
export type ProofStatus = Open<"active" | "revoked" | "expired">;

export interface ProofUser {
  uuid: string;
  id: AccountId | null;
  kind: AccountKind;
  membership_id: string;
}

/** `POST /v1/proofs/obo` | `/ata` | `/v1/apps/{id}/proofs/ata` response (tokens shown once). */
export interface IssuedProof {
  proof_id: string;
  kind: ProofKind;
  /** `sap_…`. */
  proof_token: string;
  expires_at: Timestamp;
  /** `sapr_…`. */
  proof_refresh_token: string;
  refresh_expires_at: Timestamp;
  issuing_app: string;
  /** The one app that may verify it (OBO and ATA alike: an ATA proof is for exactly one app). */
  receiving_app?: string;
  /** Older servers: every audience of an ATA proof. */
  receiving_apps?: string[];
  user?: ProofUser;
  scopes: string[];
}

export interface OboRequest {
  /** A user access token issued to the calling app. */
  subject_token: string;
  receiving_app: string;
  scopes?: string[];
  /** 60..1800, default 1800. */
  access_ttl_seconds?: number;
}

/**
 * `POST /v1/apps/{app_id}/proofs/ata`: an ATA proof is for exactly one app; a body with `audiences` answers 422
 * `ata_single_app` ("ask for one proof per app").
 */
export interface AtaRequest {
  receiving_app: string;
  scopes?: string[];
  /** 60..1800, default 1800. */
  access_ttl_seconds?: number;
}

export type ProofVerification =
  | {
    valid: true;
    proof_id: string;
    kind: ProofKind;
    expires_at: Timestamp;
    issuing_app: { app_id: string; name: string };
    receiving_app: { app_id: string; name: string };
    user: ProofUser | null;
    scopes: string[];
  }
  | { valid: false; expires_at: null };

export type ProofRevokeRequest = { proof_id: string } | { proof_token: string } | { proof_refresh_token: string };

/**
 * Why a proof ended (`revoke_reason`), as the server writes it (crates/proofs model.rs `revoke_reason`). Stored:
 * revoked_by_app, revoked_by_owner, revoked_by_account, refresh_token_reuse, access_removed, account_deleted,
 * sign_in_revoked. Derived live by listings: sign_in_expired, membership_inactive, account_inactive.
 * `PROOF_REVOKE_REASONS` (lib/api/labels.ts) has a sentence for each.
 */
export type ProofRevokeReason = Open<
  | "revoked_by_app" | "revoked_by_owner" | "revoked_by_account" | "refresh_token_reuse" | "access_removed"
  | "account_deleted" | "sign_in_revoked" | "sign_in_expired" | "membership_inactive" | "account_inactive"
>;

/** `GET /v1/apps/{app_id}/proofs` items: proofs issued by that app. */
export interface AppProof {
  proof_id: string;
  kind: ProofKind;
  /** The one app that may verify it. */
  receiving_app?: string | null;
  /** The stored audiences (one app); older listings only have this. */
  audiences?: string[];
  user: AccountSummary | null;
  scopes: string[];
  created_at: Timestamp;
  /** When the whole proof (its refresh family) ends. */
  expires_at: Timestamp;
  last_refreshed_at: Timestamp | null;
  revoked_at: Timestamp | null;
  status: ProofStatus;
  revoke_reason: ProofRevokeReason | null;
  /** When the current proof token expires (it is refreshed by the issuing app). */
  token_expires_at: Timestamp | null;
  access_ttl_seconds: number;
}

export interface AppProofsQuery extends PageQuery {
  kind?: ProofKind;
  status?: "active" | "revoked" | "expired";
}

/** `GET /v1/me/proofs` items: OBO proofs issued on my behalf. */
export interface MyProof {
  proof_id: string;
  issuing_app: AppSummary;
  receiving_app: AppSummary;
  scopes: string[];
  created_at: Timestamp;
  expires_at: Timestamp;
  last_refreshed_at: Timestamp | null;
  status: ProofStatus;
  revoked_at: Timestamp | null;
  revoke_reason: ProofRevokeReason | null;
  /** When the current proof token expires (the connector's expiry ring counts down to it). */
  token_expires_at: Timestamp | null;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Reports, telemetry, dev outbox, Silicon Apps sync                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface ReportReceipt {
  report_id: string;
  status: "queued";
  recipients: number;
}

export interface TelemetryEvent {
  source: string;
  step: string;
  /** `^[a-z0-9_.]{1,64}$`. */
  name: string;
  progress?: number;
  data?: Record<string, unknown>;
}

export interface OutboxMessage {
  id: string;
  channel: "email" | "sms";
  to: string;
  subject: string | null;
  text_body: string;
  purpose: string;
  status: string;
  created_at: Timestamp;
  /** The 6-digit code parsed from OTP messages (dev only). */
  code: string | null;
  attempts: number;
  last_error: string | null;
  sent_at: Timestamp | null;
}

/** An app as Silicon Apps delivers it (`POST /v1/internal/apps/sync`). */
export interface SiliconAppsApp {
  app_id: string;
  name: string;
  description?: string | null;
  logo_url?: string | null;
  logo_dark_url?: string | null;
  homepage_url?: string | null;
  owner_id: AccountId;
  owner_email?: string;
  secret: string;
  status?: AppStatus;
  created_at?: Timestamp;
  signin_defaults?: SigninConfigPatch;
}
