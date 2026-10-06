// Silicon Accounts API shapes used by the helpers (mirrors 02-api.md; fields the tests
// do not need are left out, and extra fields from the server are tolerated).

export type AccountKind = 'carbon' | 'silicon';

export interface ApiErrorBody {
  error: { code: string; message: string; hint?: string; details?: Record<string, unknown> };
}

export interface OAuthErrorBody {
  error: string;
  error_description?: string;
}

export interface AccountSummary {
  uuid: string;
  kind: AccountKind;
  id: string;
  display_name: string;
  pfp_url: string;
  status: string;
}

export interface AccountForApp {
  uuid: string;
  membership_id: string;
  kind: AccountKind;
  id: string;
  display_name: string;
  pfp_url: string;
  email?: string;
  email_verified?: boolean;
  phone?: string;
  phone_verified?: boolean;
  dob?: string;
  timezone?: string;
  custodian?: { uuid: string; id: string };
  updated_at: string;
  version: number;
  [key: string]: unknown;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_at: string;
  scope: string;
  id_token?: string;
  membership_id: string;
  account: AccountForApp;
}

export interface Meta {
  name: string;
  version: string;
  environment: string;
  public_url: string;
  silicon_apps_url: string;
  providers: { google: boolean; apple: boolean };
  delivery: 'local' | 'providers';
}

export type FlowStep = 'choose_method' | 'verify_code' | 'signup' | 'requirements' | 'consent' | 'complete' | 'failed';

export interface FlowChallenge {
  channel: 'email' | 'phone';
  destination: string;
  expires_at: string;
  resend_available_at: string;
}

export interface FlowSignup {
  display_name: string;
  id: string;
  timezone: string;
  dob: string;
  pfp_url: string | null;
  email: string | null;
  phone: string | null;
  provider: 'google' | 'apple' | null;
  /** The photo Google reported (offered as an alternative to the Iris default in pfp_url). */
  provider_pfp_url?: string | null;
  finishing_import: boolean;
  expires_at: string;
}

export interface FlowView {
  id: string;
  step: FlowStep;
  expires_at: string;
  app: { app_id: string; name: string; logo_url: string | null; branding: unknown; copy: unknown; first_party: boolean; [key: string]: unknown };
  methods: Array<'google' | 'apple' | 'email' | 'phone'>;
  signed_in_as: AccountSummary | null;
  challenge: FlowChallenge | null;
  signup: FlowSignup | null;
  requirements: { missing: Array<'email' | 'phone' | 'dob' | 'timezone'>; challenge: FlowChallenge | null } | null;
  consent: {
    required: Array<{ scope: string; label: string; value: string }>;
    optional: Array<{ scope: string; label: string; value: string; granted: boolean }>;
    previously_granted: string[];
  } | null;
  redirect_to: string | null;
  error: { code: string; message: string; hint?: string } | null;
  /** What the app asked for at POST /v1/flows. */
  prompt?: string | null;
  login_hint?: string | null;
  method_hint?: string | null;
}

export interface ProofIssued {
  proof_id: string;
  kind: 'obo' | 'ata';
  proof_token: string;
  expires_at: string;
  proof_refresh_token: string;
  refresh_expires_at: string;
  issuing_app: string;
  receiving_app?: string;
  receiving_apps?: string[];
  user?: { uuid: string; id: string; kind: AccountKind; membership_id: string };
  scopes: string[];
}

export type ProofVerification =
  | {
      valid: true;
      proof_id: string;
      kind: 'obo' | 'ata';
      expires_at: string;
      issuing_app: { app_id: string; name: string };
      receiving_app: { app_id: string; name: string };
      user: { uuid: string; id: string; kind: AccountKind; membership_id: string } | null;
      scopes: string[];
    }
  | { valid: false; expires_at: null };

export interface WebhookEvent<T = Record<string, unknown>> {
  event_id: string;
  type: string;
  occurred_at: string;
  app_id: string | null;
  silicon: string | null;
  data: T;
}

export interface ImportRow {
  external_id?: string;
  email?: string;
  emails?: string[] | string;
  phone?: string;
  phones?: string[] | string;
  display_name?: string;
  name?: string;
  username?: string;
  dob?: string;
  timezone?: string;
  pfp_url?: string;
  email_verified?: boolean | string;
}

export interface ImportOptions {
  default_country?: string;
  ignore_unknown_columns?: boolean;
  dry_run?: boolean;
  update_existing?: boolean;
}

export interface ImportJob {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  format: 'json' | 'csv';
  total_rows: number;
  processed_rows: number;
  counts: { created: number; matched: number; updated: number; skipped: number; error: number; warnings: number };
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  app_id?: string;
  dry_run?: boolean;
  options?: ImportOptions;
  /** `app`, or the uuid of the owner who started it. */
  created_by?: string;
}

export interface ImportRowResult {
  row_number: number;
  outcome: 'pending' | 'created' | 'matched' | 'updated' | 'skipped' | 'error';
  account_uuid: string | null;
  id: string | null;
  messages: Array<{ level: 'error' | 'warning' | 'info'; code: string; message: string; field?: string }>;
  input: Record<string, unknown>;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
