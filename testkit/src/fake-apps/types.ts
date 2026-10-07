// Shapes shared by the fake apps generator, the fake app server and the e2e helpers.
// SiliconAppsApp mirrors 02-api.md ("SiliconAppsApp"); the extra fields are marked.

export type SigninMethod = 'email' | 'phone' | 'google' | 'apple';
export type ProfileField = 'email' | 'phone' | 'dob' | 'timezone';
export type BrandFont =
  | 'Geist'
  | 'Inter'
  | 'IBM Plex Sans'
  | 'DM Sans'
  | 'Space Grotesk'
  | 'Source Serif 4'
  | 'Fraunces'
  | 'Instrument Serif'
  | 'JetBrains Mono'
  | 'System';

export const BRAND_FONTS: readonly BrandFont[] = [
  'Geist',
  'Inter',
  'IBM Plex Sans',
  'DM Sans',
  'Space Grotesk',
  'Source Serif 4',
  'Fraunces',
  'Instrument Serif',
  'JetBrains Mono',
  'System',
];

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

export interface Branding {
  theme: 'auto' | 'light' | 'dark';
  logo_url: string | null;
  logo_dark_url: string | null;
  logo_height: number;
  show_app_name: boolean;
  font_family: BrandFont;
  heading_font_family: BrandFont | null;
  corner_style: 'squircle' | 'rounded' | 'sharp';
  radius: number;
  button_style: 'solid' | 'soft' | 'outline';
  layout: 'card' | 'split' | 'minimal';
  background_style: 'plain' | 'dots' | 'grain' | 'gradient' | 'image';
  background_image_url: string | null;
  density: 'comfortable' | 'compact';
  light: Palette;
  dark: Palette;
}

export interface Copy {
  title: string | null;
  subtitle: string | null;
  terms_url: string | null;
  privacy_url: string | null;
  support_email: string | null;
  /** The opening page before Google/Apple (≤ 80 chars, may contain {provider} and {app}). */
  opening_title: string | null;
  /** Sign-up versions of title/subtitle (intent=signup). */
  signup_title: string | null;
  signup_subtitle: string | null;
}

/** One page of an app's sign-in flow: the requested details it asks for, with its own copy. */
export interface FlowStep {
  /** [a-z0-9-]{1,40}, unique in the flow. */
  id: string;
  /** Every requested detail (required_fields ∪ optional_fields) is on exactly one step. */
  fields: ProfileField[];
  title: string | null;
  subtitle: string | null;
  continue_label: string | null;
  /** null = branding.layout. */
  layout: 'card' | 'split' | 'minimal' | null;
}

/** Which pages a Carbon goes through and which details each asks (null = one page with every detail). */
export interface Flow {
  steps: FlowStep[];
  /** A last page listing everything that will be shared. */
  review: boolean;
}

/**
 * Partial SigninConfig as Silicon Apps delivers it. The google/apple blocks may carry the
 * bring-your-own secrets (`client_secret`, `private_key`) exactly like
 * PATCH /v1/apps/{app_id}/signin-config accepts them.
 */
export interface SigninDefaults {
  methods?: Partial<Record<SigninMethod, boolean>>;
  method_order?: SigninMethod[];
  google?: {
    mode?: 'managed' | 'byo';
    client_id?: string | null;
    client_secret?: string;
    prompt?: 'select_account' | 'consent' | 'none' | null;
    hosted_domain?: string | null;
  };
  apple?: {
    mode?: 'managed' | 'byo';
    services_id?: string | null;
    team_id?: string | null;
    key_id?: string | null;
    private_key?: string;
  };
  redirect_uris?: string[];
  allowed_origins?: string[];
  required_fields?: ProfileField[];
  optional_fields?: ProfileField[];
  allowed_email_domains?: string[];
  allow_signup?: boolean;
  remember_browser?: boolean;
  branding?: Partial<Branding>;
  copy?: Partial<Copy>;
  flow?: Flow | null;
}

/** Testkit-only metadata (ignored by Silicon Accounts; drives the fake app server and docs). */
export interface TestkitMeta {
  category: string;
  /** One line on what this app is for in tests. */
  purpose: string;
  /** The behaviours this app exists to exercise. */
  exercises: string[];
  /** The integration its demo page highlights first. */
  integration: 'hosted' | 'iframe' | 'sdk';
  /** Default query params for the app's sign-in links (overridable per page load). */
  authorize_params: Record<string, string>;
  proofs: {
    obo_issuer_to: string[];
    obo_receiver: boolean;
    ata_issuer_to: string[];
    ata_receiver: boolean;
  };
  /** Silicons sign in to this app with short-lived tokens in the e2e suites. */
  silicon_slt: boolean;
  /** Brand colour for the fake app's own pages. */
  accent: string;
}

export interface SiliconAppsApp {
  app_id: string;
  name: string;
  description: string;
  logo_url: string | null;
  logo_dark_url: string | null;
  homepage_url: string | null;
  owner_id: string;
  owner_email: string;
  secret: string;
  status: 'active' | 'disabled';
  created_at: string;
  signin_defaults: SigninDefaults;
  /** Extra (testkit): where the fake app server receives this app's webhooks; null = no webhook. */
  webhook_url: string | null;
  /** Extra (testkit): fixed signing secret for that webhook, so the fake app can verify from the start. */
  webhook_secret: string | null;
  /** Extra (testkit): metadata for the fake app server and the e2e suites. */
  testkit: TestkitMeta;
}

export interface FakeAppsFile {
  _comment: string;
  version: number;
  /** Base URL the redirect URIs, origins and webhooks below point at. */
  fake_app_server: string;
  apps: SiliconAppsApp[];
}
