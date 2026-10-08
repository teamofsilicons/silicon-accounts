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
  /** Where the published docs live (ACCOUNTS_DOCS_URL). */
  docs_url?: string;
  /** developer.teamofsilicons.com (ACCOUNTS_DEVELOPER_URL). */
  developer_url?: string;
  providers: { google: boolean; apple: boolean };
  delivery: 'local' | 'providers';
}

export type FlowStep = 'choose_method' | 'verify_code' | 'signup' | 'details' | 'review' | 'complete' | 'failed';

export type DetailField = 'email' | 'phone' | 'dob' | 'timezone';

/** One detail on a details page (FlowView.details.fields). */
export interface FlowDetailField {
  field: DetailField;
  mode: 'required' | 'optional';
  label: string;
  /** What the app gets (email/phone masked); null when missing. */
  value: string | null;
  /** An email/phone the account doesn't have yet: add it with POST …/details/add. */
  missing: boolean;
  /** The checkbox: always true for required details; optional ones start unticked unless shared before. */
  shared: boolean;
  previously_granted: boolean;
}

/** The details page on screen (step `details`): one step of the app's flow. */
export interface FlowDetails {
  index: number;
  count: number;
  id: string;
  title: string | null;
  subtitle: string | null;
  continue_label: string | null;
  layout: 'card' | 'split' | 'minimal' | null;
  fields: FlowDetailField[];
  /** The code sent to add a missing email or phone. */
  challenge: FlowChallenge | null;
}

/** The review page (step `review`): everything that will be shared, profile first. */
export interface FlowReview {
  fields: Array<{ field: 'profile' | DetailField; mode: 'required' | 'optional'; label: string; value: string | null; shared: boolean }>;
}

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
  /** Step `details`: the page of the app's flow on screen. */
  details: FlowDetails | null;
  /** Step `review`: everything that will be shared. */
  review: FlowReview | null;
  redirect_to: string | null;
  error: { code: string; message: string; hint?: string } | null;
  /** What the app asked for at POST /v1/flows. */
  prompt?: string | null;
  /** The sign-in or the sign-up version of the pages. */
  intent: 'signin' | 'signup';
  /** A direct method button (`method=`). */
  method_hint?: 'google' | 'apple' | 'email' | 'phone' | null;
}

export interface ProofIssued {
  proof_id: string;
  kind: 'user_verification' | 'app_verification';
  proof_token: string;
  expires_at: string;
  proof_refresh_token: string;
  refresh_expires_at: string;
  issuing_app: string;
  /** The one app this proof is for (User verification and App verification alike). */
  receiving_app: string;
  user?: { uuid: string; id: string; kind: AccountKind; membership_id: string };
  scopes: string[];
}

export type ProofVerification =
  | {
      valid: true;
      proof_id: string;
      kind: 'user_verification' | 'app_verification';
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
