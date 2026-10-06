/**
 * Every request and response shape of the Silicon Accounts HTTP API (spec 02-api.md), as the account site sees it.
 * Field names are the wire names (snake_case). Where crates/core defines a view (AccountSummary, MeView, AccountForApp,
 * TokenResponse, SigninConfig, Branding) these types follow the Rust code, which is the reviewed source of truth.
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
    hint?: string;
    /** Machine-readable extras: `fields` (422), `retry_after_seconds` (429/423), `remaining_attempts`, `suggestions`, `request_id`… */
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

export interface EmailView {
  email: string;
  is_primary: boolean;
  verified_at: Timestamp | null;
  verified_via: VerifiedVia | null;
}

export interface PhoneView {
  /** E.164, for example "+919876543210". */
  phone: string;
  is_primary: boolean;
  verified_at: Timestamp | null;
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

/** `GET /v1/me` for a Silicon (also the "Silicon view" returned by the custodian endpoints). */
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

export interface ProfileUpdate {
  display_name?: string;
  timezone?: string;
  /** Carbons only: a Silicon's date of birth is the day it was created (422 `dob_immutable`). */
  dob?: DateString;
  /** https URL, or null to go back to the default photo. */
  pfp_url?: string | null;
}

export interface IdAvailability {
  id: string;
  available: boolean;
  reason: "taken" | "reserved" | "reserved_word" | "invalid" | null;
  /** Says exactly why (or that it is free). */
  message: string;
  /** True when the id is the caller's own reserved id and can be taken back. */
  reclaimable: boolean;
}

export interface PhotoUploaded {
  pfp_url: string;
  /** Some servers also return the refreshed Me view. */
  me?: Me;
}

/** A code was sent to add an email or phone; verify it with the challenge id. */
export interface ContactChallenge {
  challenge_id: string;
  expires_at: Timestamp;
  /** Masked destination, when the server includes it. */
  destination?: string;
}

/** An app the account has signed into (`GET /v1/me/apps`). */
export interface MyApp {
  app: AppSummary;
  membership_id: string;
  status: MembershipStatus;
  granted_scopes: Scope[];
  first_signed_in_at: Timestamp | null;
  last_signed_in_at: Timestamp | null;
  active_sessions: number;
}

/** A browser session or a first-party (CLI / Silicon) sign-in. */
export interface SessionInfo {
  id: string;
  kind: "browser" | "cli";
  label: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Timestamp;
  last_seen_at: Timestamp | null;
  /** The session this request was made with. */
  current: boolean;
}

export type HistoryKind = "signin" | "id_change" | "custodian" | "proof" | "app_access" | "security";

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

/** Texts and links on the hosted pages. */
export interface SigninCopy {
  /** ≤ 80 characters. */
  title: string | null;
  /** ≤ 200 characters. */
  subtitle: string | null;
  terms_url: string | null;
  privacy_url: string | null;
  support_email: string | null;
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
  /** Origins that may embed the iframe (frame-ancestors) and use the SDK. */
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
}

/** The configuration as `GET /v1/apps/{app_id}` shows it: secrets are never returned, only whether they are set. */
export interface SigninConfigView extends Omit<SigninConfig, "google" | "apple"> {
  google: GoogleConfig & { client_secret_set?: boolean };
  apple: AppleConfig & { private_key_set?: boolean };
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object | null ? DeepPartial<NonNullable<T[K]>> | null : T[K] | null };

/**
 * `PATCH /v1/apps/{app_id}/signin-config` body: a partial SigninConfig (objects merge, arrays replace, null resets a
 * field to its default) plus optional BYO secrets and an optimistic-concurrency version.
 */
export type SigninConfigPatch = DeepPartial<Omit<SigninConfig, "google" | "apple">> & {
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
}

/** `GET /v1/me/owned-apps` items. */
export interface OwnedApp {
  app_id: string;
  name: string;
  logo_url: string | null;
  status: AppStatus;
  source: AppSource;
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
  signin_config: SigninConfigView;
  config_version: number;
  webhook: { url: string | null; secret_set: boolean };
  stats: { users: number; active_last_30d: number; imported_unclaimed: number };
}

export interface ConfigHistoryItem {
  version: number;
  /** "app" when changed with app credentials, else the owner's uuid (or a summary). */
  actor: string | AccountSummary | null;
  /** Redacted diff of what changed (paths to before/after values). */
  changes: unknown;
  at: Timestamp;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* User base and imports                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

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
  status: MembershipStatus;
  source: MembershipSource;
  external_id: string | null;
  granted_scopes: Scope[];
  first_signed_in_at: Timestamp | null;
  last_signed_in_at: Timestamp | null;
  created_at: Timestamp;
}

export interface SigninHistoryEntry {
  at: Timestamp;
  method?: string | null;
  outcome?: string | null;
  ip?: string | null;
  user_agent?: string | null;
  [extra: string]: unknown;
}

export interface AppUserDetail extends AppUser {
  /** The last 20 sign-ins. */
  history: SigninHistoryEntry[];
}

export interface AppUsersQuery extends PageQuery {
  /** Matches id, display name, email, phone and external_id. */
  q?: string;
  status?: MembershipStatus;
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

export type ImportJobStatus = "queued" | "running" | "completed" | "failed" | (string & {});

export interface ImportJob {
  id: string;
  status: ImportJobStatus;
  format: "json" | "csv";
  total_rows: number;
  processed_rows: number;
  counts: { created: number; matched: number; updated: number; skipped: number; error: number; warnings: number };
  created_at: Timestamp;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
  error: string | null;
  /** Whether it was a dry run, when the server includes the options. */
  options?: ImportOptions;
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
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Webhooks                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

export type DeliveryStatus = "pending" | "delivered" | "failed";

export interface WebhookDelivery {
  id: string;
  event_id: string;
  type: string;
  status: DeliveryStatus;
  attempts: number;
  /** HTTP status of the last attempt. */
  last_status: number | null;
  last_error: string | null;
  next_attempt_at: Timestamp | null;
  delivered_at: Timestamp | null;
  created_at: Timestamp;
  manual_replays: number;
}

export interface WebhookAttempt {
  at?: Timestamp;
  attempt?: number;
  status?: number | null;
  error?: string | null;
  duration_ms?: number | null;
  [extra: string]: unknown;
}

/**
 * `GET /v1/apps/{app_id}/webhook/deliveries/{id}`, normalized by the client: the server may send the delivery flat with
 * `attempts` as an array, or nested under `delivery`.
 */
export interface WebhookDeliveryDetail {
  delivery: WebhookDelivery;
  attempts: WebhookAttempt[];
  payload: WebhookEvent | null;
}

export interface DeliveriesQuery extends PageQuery {
  status?: DeliveryStatus;
}

export type ReplayRequest = { delivery_ids: string[] } | { status: "failed"; since?: Timestamp };

export interface ReplayResult {
  /** Re-queued deliveries (a count or their ids). */
  replayed: number | string[];
  /** Skipped deliveries, for example because the account no longer has access. */
  skipped: number | Array<string | { id: string; reason: string }>;
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

export type FlowStep = "choose_method" | "verify_code" | "signup" | "requirements" | "consent" | "complete";

/** `POST /v1/flows` body: the /authorize query, as JSON. */
export interface FlowCreate {
  app_id?: string;
  /** Alias of app_id. */
  client_id?: string;
  redirect_uri: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: "S256" | "plain";
  /** Space-separated, for example "openid email". */
  scope?: string;
  nonce?: string;
  prompt?: "login" | "consent" | "select_account" | "none";
  login_hint?: string;
  /** Jump straight to one enabled method. */
  method?: SigninMethod;
  /** Accepted and ignored. */
  response_type?: string;
  /** The browser's IANA time zone (Intl), the fallback for the signup suggestion. */
  timezone?: string;
}

export interface FlowChallenge {
  channel: OtpChannel;
  /** Masked, for example "s***@gmail.com". */
  destination: string;
  expires_at: Timestamp;
  /** When "Resend" becomes available (UI hint). */
  resend_available_at: Timestamp;
}

export interface FlowSignup {
  display_name: string;
  id: AccountId;
  timezone: string;
  dob: DateString;
  pfp_url: string;
  email: string | null;
  phone: string | null;
  provider: Provider | null;
  /** True when an imported account is finishing its setup. */
  finishing_import: boolean;
  expires_at: Timestamp;
}

export interface ConsentRow {
  scope: Scope;
  label: string;
  value: string | null;
}

export interface FlowConsent {
  required: ConsentRow[];
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
  /** Set on `complete`: where to send the browser. */
  redirect_to: string | null;
  error: { code: string; message: string; hint?: string } | null;
}

export interface FlowEnvelope {
  flow: FlowView;
}

export interface SignupSubmit {
  display_name: string;
  id: AccountId;
  timezone: string;
  dob: DateString;
  /** https URL, or null for the default photo. */
  pfp_url?: string | null;
}

export interface ConsentSubmit {
  approve: boolean;
  optional_scopes?: Scope[];
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Browser session, device approval and CLI sign-in                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface BrowserSession {
  account: AccountSummary;
  session: { id: string; created_at: Timestamp; expires_at: Timestamp };
}

export interface DeviceAuthorization {
  device_code: string;
  /** XXXX-XXXX. */
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceRequest {
  user_code: string;
  client_label: string | null;
  created_at: Timestamp;
  expires_at: Timestamp;
  status: "pending" | "approved" | "denied" | "expired" | "consumed" | (string & {});
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

export interface CustodianRequestInfo {
  id: string;
  status: "pending" | "accepted" | "declined" | "expired" | "cancelled" | (string & {});
  expires_at: Timestamp;
  /** The named custodian (`c:id`, or a masked email). */
  custodian: string;
}

export interface SiliconSelfCreated {
  silicon: SiliconMe;
  /** Only when generated; shown exactly once. */
  stk: string | null;
  request: CustodianRequestInfo;
  /** `sarq_…`: polls the request status. */
  request_token: string;
  webhook_secret: string | null;
}

export interface CustodianRequestStatus {
  id: string;
  status: CustodianRequestInfo["status"];
  expires_at: Timestamp;
  decided_at: Timestamp | null;
  silicon: { uuid: string; id: AccountId | null; status: AccountStatus };
}

/** `POST /v1/me/silicons` (a Carbon creating a Silicon it is custodian of). */
export interface CreateSilicon {
  id: AccountId;
  display_name: string;
  timezone?: string;
  pfp_url?: string;
  stk?: string;
  webhook_url?: string;
}

export interface SiliconCreated {
  silicon: SiliconMe;
  /** Only when generated; shown exactly once. */
  stk: string | null;
  webhook_secret: string | null;
}

export interface PendingTransfer {
  id: string;
  /** The recipient (`c:id`, an AccountSummary or a masked email). */
  to: AccountSummary | string | null;
  created_at: Timestamp;
  expires_at: Timestamp;
  [extra: string]: unknown;
}

/** `GET /v1/me/silicons` items: the Silicon view plus any pending transfer. */
export type ManagedSilicon = SiliconMe & { pending_transfer: PendingTransfer | null };

export interface UpdateSilicon {
  display_name?: string;
  timezone?: string;
  pfp_url?: string | null;
}

export interface StkRotated {
  /** Only when generated; shown exactly once. */
  stk: string | null;
  rotated_at: Timestamp;
}

export interface SiliconWebhook {
  webhook_url: string;
  /** `whsec_…`, shown once each time the URL is set. */
  webhook_secret: string;
}

export interface TransferRequest {
  id: string;
  kind?: "transfer";
  status: CustodianRequestInfo["status"];
  to: AccountSummary | string | null;
  created_at: Timestamp;
  expires_at: Timestamp;
  [extra: string]: unknown;
}

/** A request addressed to me (by uuid or any of my verified emails). */
export interface CustodianRequest {
  id: string;
  kind: "initial" | "transfer";
  silicon: AccountSummary;
  /** The current custodian for a transfer; null for a Silicon's own request. */
  from: AccountSummary | null;
  created_at: Timestamp;
  expires_at: Timestamp;
}

export interface ShortLivedToken {
  slt: string;
  app_id: string;
  expires_at: Timestamp;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Proofs (OBO and ATA)                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

export type ProofKind = "obo" | "ata";

export interface ProofUser {
  uuid: string;
  id: AccountId | null;
  kind: AccountKind;
  membership_id: string;
}

/** `POST /v1/proofs/obo` | `/ata` | `/v1/apps/{id}/proofs/ata` response. */
export interface IssuedProof {
  proof_id: string;
  kind: ProofKind;
  /** `sap_…`, shown once. */
  proof_token: string;
  expires_at: Timestamp;
  /** `sapr_…`, shown once. */
  proof_refresh_token: string;
  refresh_expires_at: Timestamp;
  issuing_app: string;
  /** OBO: the one receiving app. */
  receiving_app?: string;
  /** ATA: every audience. */
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

export interface AtaRequest {
  audiences: string[];
  scopes?: string[];
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

/** `GET /v1/apps/{app_id}/proofs` items: proofs issued by that app. */
export interface AppProof {
  proof_id: string;
  kind: ProofKind;
  audiences: string[];
  user: AccountSummary | null;
  scopes: string[];
  created_at: Timestamp;
  expires_at: Timestamp;
  last_refreshed_at: Timestamp | null;
  revoked_at: Timestamp | null;
}

export interface AppProofsQuery extends PageQuery {
  kind?: ProofKind;
  status?: "active" | "revoked";
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
  status: "active" | "expired" | "revoked" | (string & {});
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
