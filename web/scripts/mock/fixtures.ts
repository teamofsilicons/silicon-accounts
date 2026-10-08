/**
 * Realistic API data for screenshots and page work without the Rust server. App names, logos, branding and sign-in
 * setups come from testkit/fake-apps.json (the same 15 apps the e2e suite seeds), so screenshots look like the real
 * thing. Everything here is sample data. Shapes follow lib/api/types.ts (the reviewed server shapes).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AccountSummary, AppDetail, AppPublic, AppSummary, AppUser, Branding, BrowserSession, CarbonMe, CustodianRequest, FlowView, HistoryItem,
  ImportJob, ManagedSilicon, Meta, MyApp, MyProof, OwnedApp, Page, SessionInfo, SigninConfigView, SigninMethod, WebhookDelivery,
} from "../../lib/api/types";
import { DEFAULT_BRANDING, DEFAULT_COPY, normalizeBranding, normalizeCopy } from "../../lib/branding/defaults";

const here = dirname(fileURLToPath(import.meta.url));

interface FakeApp {
  app_id: string;
  name: string;
  description?: string;
  logo_url?: string | null;
  logo_dark_url?: string | null;
  homepage_url?: string | null;
  owner_id: string;
  status?: "active" | "disabled";
  created_at?: string;
  signin_defaults?: Record<string, unknown> & { branding?: Partial<Branding>; copy?: Record<string, string | null> };
  webhook_url?: string | null;
}

function loadFakeApps(): FakeApp[] {
  try {
    const raw = JSON.parse(readFileSync(resolve(here, "../../../testkit/fake-apps.json"), "utf8")) as { apps?: FakeApp[] } | FakeApp[];
    return Array.isArray(raw) ? raw : raw.apps ?? [];
  } catch {
    return [];
  }
}

export const fakeApps: FakeApp[] = loadFakeApps();
export const fakeApp = (appId: string): FakeApp | undefined => fakeApps.find(app => app.app_id === appId);

/** A soft portrait with initials, as a data URI (no network in screenshot runs). */
export function portrait(name: string, hue = 212): string {
  const initials = name.split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 46% 74%)"/><stop offset="1" stop-color="hsl(${hue + 28} 42% 58%)"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><text x="48" y="60" font-family="Georgia, serif" font-size="38" text-anchor="middle" fill="#FFFDF9">${initials}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** Fixed "now" for the samples: Oct 6, 2026, 09:41 UTC. */
export const NOW = Date.UTC(2026, 9, 6, 9, 41);
const iso = (offsetMinutes: number, base = NOW) => new Date(base + offsetMinutes * 60_000).toISOString();

export const page = <T>(items: T[]): Page<T> => ({ items, next_cursor: null });

export const meta: Meta = {
  name: "Silicon Accounts",
  version: "0.2.0",
  environment: "development",
  public_url: "http://localhost:8590",
  silicon_apps_url: "https://apps.teamofsilicons.com",
  developer_url: "http://localhost:8600",
  docs_url: "http://localhost:8600/docs/accounts",
  providers: { google: true, apple: true },
  delivery: "local",
};

export const carbon: CarbonMe = {
  uuid: "a8K",
  kind: "carbon",
  id: "c:saket",
  display_name: "Saket Dev",
  pfp_url: portrait("Saket Dev", 206),
  dob: "1998-03-14",
  timezone: "Asia/Kolkata",
  status: "active",
  created_at: "2026-09-01T09:00:00.000Z",
  updated_at: iso(-90),
  version: 7,
  emails: [
    { email: "saketdev12@gmail.com", is_primary: true, verified_at: "2026-09-01T09:00:00.000Z", verified_via: "google" },
    { email: "cricketdrop6@gmail.com", is_primary: false, verified_at: "2026-09-14T17:22:00.000Z", verified_via: "code" },
  ],
  phones: [{ phone: "+919876543210", is_primary: true, verified_at: "2026-09-02T08:10:00.000Z" }],
  identities: [{ provider: "google", subject: "108233491177834234", email: "saketdev12@gmail.com", created_at: "2026-09-01T09:00:00.000Z", last_used_at: iso(-60 * 26) }],
  custodian_of: 3,
};

export const carbonSummary: AccountSummary = { uuid: carbon.uuid, kind: "carbon", id: carbon.id, display_name: carbon.display_name, pfp_url: carbon.pfp_url, status: "active" };

export const session: BrowserSession = {
  account: carbonSummary,
  session: { id: "0192a6f0-4b1e-7c1d-9f00-3c1e0f0d1a2b", kind: "browser", created_at: iso(-60 * 24 * 3), expires_at: "2029-03-25T09:41:00.000Z", last_seen_at: iso(-2) },
};

export const summary = (app: FakeApp): AppSummary => ({ app_id: app.app_id, name: app.name, logo_url: app.logo_url ?? null, logo_dark_url: app.logo_dark_url ?? null, homepage_url: app.homepage_url ?? null });
const summaryOf = (appId: string): AppSummary => summary(fakeApp(appId) ?? fakeApps[0] ?? { app_id: appId, name: appId, owner_id: "c:saket" });

export const myApps: MyApp[] = ["briefcase", "dm", "commit", "remind", "interface", "waveform", "spacestation"]
  .map(id => fakeApp(id))
  .filter((app): app is FakeApp => !!app)
  .map((app, index) => ({
    app: summary(app),
    membership_id: `${app.app_id}:${carbon.uuid}`,
    status: index === 6 ? "access_removed" : "active",
    source: "signin",
    granted_scopes: index % 2 ? ["profile", "email", "timezone"] : ["profile", "email"],
    first_signed_in_at: iso(-60 * 24 * (30 - index * 3)),
    last_signed_in_at: iso(-60 * (index * 7 + 2)),
    active_sessions: index === 6 ? 0 : (index % 3) + 1,
    access_removed_at: index === 6 ? iso(-60 * 24 * 2) : null,
  }));

export const sessions: SessionInfo[] = [
  { id: session.session.id, kind: "browser", origin: "browser", label: "Safari on macOS", ip: "103.48.12.9", user_agent: "Mozilla/5.0 (Macintosh)", created_at: iso(-60 * 24 * 3), last_seen_at: iso(-2), expires_at: "2029-03-25T09:41:00.000Z", current: true },
  { id: "0192a6f0-0000-7000-8000-000000000002", kind: "cli", origin: "device", label: "silicon-accounts CLI on build-box", ip: "103.48.12.11", user_agent: "silicon-accounts-cli/0.2.0", created_at: iso(-60 * 24 * 9), last_seen_at: iso(-60 * 5), expires_at: iso(60 * 24 * 80), current: false },
];

const siliconBase = { kind: "silicon" as const, custodian: carbonSummary };

export const silicons: ManagedSilicon[] = [
  { ...siliconBase, uuid: "Qz4", id: "si:scout", display_name: "Scout", pfp_url: portrait("Scout", 160), dob: "2026-09-03", timezone: "Asia/Kolkata", status: "active", created_at: "2026-09-03T10:00:00.000Z", updated_at: iso(-300), version: 3, webhook_url: "https://scout.example/hooks/accounts", stk_rotated_at: iso(-60 * 24 * 6), pending_transfer: null },
  { ...siliconBase, uuid: "Lm8", id: "si:head_of_growth", display_name: "Head of Growth", pfp_url: portrait("Head of Growth", 32), dob: "2026-09-11", timezone: "Europe/London", status: "active", created_at: "2026-09-11T10:00:00.000Z", updated_at: iso(-800), version: 2, webhook_url: null, stk_rotated_at: iso(-60 * 24 * 20), pending_transfer: { id: "0192a6f0-0000-7000-8000-0000000000aa", to: { uuid: "Sh7", kind: "carbon", id: "c:shubham", display_name: "Shubham", pfp_url: portrait("Shubham", 300), status: "active" }, created_at: iso(-60 * 20), expires_at: iso(60 * 24 * 13) } },
  { ...siliconBase, uuid: "Tb2", id: "si:atlas", display_name: "Atlas", pfp_url: portrait("Atlas", 270), dob: "2026-10-01", timezone: "UTC", status: "pending_custodian", created_at: "2026-10-01T10:00:00.000Z", updated_at: iso(-1200), version: 1, custodian: null, webhook_url: null, stk_rotated_at: null, pending_transfer: null },
];

export const custodianRequests: CustodianRequest[] = [
  { id: "0192a6f0-0000-7000-8000-0000000000cc", kind: "initial", status: "pending", silicon: { uuid: "Vx7", kind: "silicon", id: "si:courier", display_name: "Courier", pfp_url: portrait("Courier", 120), status: "pending_custodian" }, from: null, to: carbonSummary, created_at: iso(-45), expires_at: iso(60 * 24 * 14 - 45), decided_at: null },
];

export const proofs: MyProof[] = [
  { proof_id: "0192a6f0-0000-7000-8000-0000000000a1", issuing_app: summaryOf("dm"), receiving_app: summaryOf("briefcase"), scopes: ["files.write"], created_at: iso(-30), expires_at: iso(60 * 24 * 30), last_refreshed_at: iso(-4), status: "active", revoked_at: null, revoke_reason: null, token_expires_at: iso(11) },
  { proof_id: "0192a6f0-0000-7000-8000-0000000000a2", issuing_app: summaryOf("interface"), receiving_app: summaryOf("remind"), scopes: ["reminders.create"], created_at: iso(-60 * 5), expires_at: iso(-60 * 4), last_refreshed_at: null, status: "revoked", revoked_at: iso(-60 * 4), revoke_reason: "revoked_by_account", token_expires_at: null },
];

export const history: HistoryItem[] = [
  { id: "h1", kind: "signin", at: iso(-2), title: "Signed in to Briefcase", detail: "Email code · Safari on macOS", app: summaryOf("briefcase"), meta: { method: "email", outcome: "success" } },
  { id: "h2", kind: "proof", at: iso(-30), title: "DM got a proof for Briefcase", detail: "files.write", app: summaryOf("dm"), meta: {} },
  { id: "h3", kind: "id_change", at: iso(-60 * 26), title: "Changed id from c:saketdev to c:saket", detail: "c:saketdev stays reserved for you for 10 days", app: null, meta: { old_id: "c:saketdev", new_id: "c:saket" } },
  { id: "h4", kind: "custodian", at: iso(-60 * 50), title: "Became custodian of si:scout", detail: null, app: null, meta: {} },
];

export function ownedApps(owner = "c:saket"): OwnedApp[] {
  return fakeApps
    .filter(app => app.owner_id === owner)
    .map((app, index) => ({ app_id: app.app_id, name: app.name, logo_url: app.logo_url ?? null, status: app.status ?? "active", source: "fake" as const, users: [1284, 312, 96, 41, 7][index % 5] ?? 3, created_at: app.created_at ?? "2026-09-01T09:00:00.000Z" }));
}

const METHODS: SigninMethod[] = ["google", "apple", "email", "phone"];

export function appPublic(appId: string): AppPublic | null {
  const app = fakeApp(appId);
  if (!app) return null;
  const defaults = app.signin_defaults ?? {};
  const methods = (defaults.methods ?? { email: true }) as Partial<Record<SigninMethod, boolean>>;
  const order = ((defaults.method_order as SigninMethod[] | undefined) ?? METHODS).filter(method => METHODS.includes(method));
  return {
    ...summary(app),
    logo_dark_url: app.logo_dark_url ?? null,
    methods: order.filter(method => methods[method]),
    branding: normalizeBranding({ ...DEFAULT_BRANDING, ...(defaults.branding ?? {}) }),
    copy: normalizeCopy({ ...DEFAULT_COPY, ...(defaults.copy ?? {}) }),
    allowed_origins: (defaults.allowed_origins as string[] | undefined) ?? [],
  };
}

export function appDetail(appId: string): AppDetail | null {
  const app = fakeApp(appId);
  const pub = appPublic(appId);
  if (!app || !pub) return null;
  const defaults = app.signin_defaults ?? {};
  const google = (defaults.google ?? {}) as Record<string, unknown>;
  const apple = (defaults.apple ?? {}) as Record<string, unknown>;
  const config: SigninConfigView = {
    methods: { email: false, phone: false, google: false, apple: false, ...(defaults.methods as object) },
    method_order: (defaults.method_order as SigninConfigView["method_order"]) ?? METHODS,
    google: { mode: google.mode === "byo" ? "byo" : "managed", client_id: (google.client_id as string) ?? null, prompt: (google.prompt as string) ?? "select_account", hosted_domain: (google.hosted_domain as string) ?? null, client_secret_set: !!google.client_secret },
    apple: { mode: apple.mode === "byo" ? "byo" : "managed", services_id: (apple.services_id as string) ?? null, team_id: (apple.team_id as string) ?? null, key_id: (apple.key_id as string) ?? null, private_key_set: !!apple.private_key },
    redirect_uris: (defaults.redirect_uris as string[]) ?? [],
    allowed_origins: (defaults.allowed_origins as string[]) ?? [],
    required_fields: (defaults.required_fields as SigninConfigView["required_fields"]) ?? [],
    optional_fields: (defaults.optional_fields as SigninConfigView["optional_fields"]) ?? [],
    allowed_email_domains: (defaults.allowed_email_domains as string[]) ?? [],
    allow_signup: (defaults.allow_signup as boolean) ?? true,
    remember_browser: (defaults.remember_browser as boolean) ?? true,
    branding: pub.branding,
    copy: pub.copy,
  };
  return {
    app_id: pub.app_id,
    name: pub.name,
    description: app.description ?? null,
    logo_url: pub.logo_url,
    logo_dark_url: pub.logo_dark_url,
    homepage_url: pub.homepage_url,
    owner: { ...carbonSummary, id: app.owner_id, display_name: app.owner_id === carbon.id ? carbon.display_name : app.owner_id },
    status: app.status ?? "active",
    source: "fake",
    created_at: app.created_at ?? "2026-09-01T09:00:00.000Z",
    updated_at: iso(-60 * 3),
    signin_config: config,
    config_version: 4,
    webhook: { url: app.webhook_url ?? null, secret_set: !!app.webhook_url },
    stats: { users: 1284, active_last_30d: 942, imported_unclaimed: 86 },
  };
}

export const appUsers: AppUser[] = [
  { membership_id: "briefcase:a8K", uuid: "a8K", kind: "carbon", id: "c:saket", display_name: "Saket Dev", pfp_url: carbon.pfp_url, email: "saketdev12@gmail.com", phone: null, timezone: "Asia/Kolkata", status: "active", account_status: "active", source: "signin", external_id: null, granted_scopes: ["profile", "email", "timezone"], first_signed_in_at: iso(-60 * 24 * 30), last_signed_in_at: iso(-2), created_at: iso(-60 * 24 * 30) },
  { membership_id: "briefcase:Qz4", uuid: "Qz4", kind: "silicon", id: "si:scout", display_name: "Scout", pfp_url: portrait("Scout", 160), status: "active", account_status: "active", source: "slt", external_id: null, granted_scopes: ["profile", "timezone"], timezone: "Asia/Kolkata", first_signed_in_at: iso(-60 * 24 * 12), last_signed_in_at: iso(-60 * 3), created_at: iso(-60 * 24 * 12) },
  { membership_id: "briefcase:Pn3", uuid: "Pn3", kind: "carbon", id: "c:mira", display_name: "Mira Chen", pfp_url: portrait("Mira Chen", 340), email: "mira@northwind.test", status: "imported", account_status: "unclaimed", source: "import", external_id: "crm-1042", granted_scopes: ["profile"], first_signed_in_at: null, last_signed_in_at: null, created_at: iso(-60 * 24 * 2) },
];

export const deliveries: WebhookDelivery[] = [
  { id: "d1", event_id: "0192a6f0-0000-7000-8000-0000000000e1", type: "account.updated", account_uuid: "a8K", url: "https://briefcase.example/hooks/accounts", status: "delivered", attempts: 1, last_status: 200, last_error: null, next_attempt_at: null, last_attempt_at: iso(-12), delivered_at: iso(-12), created_at: iso(-12), manual_replays: 0 },
  { id: "d2", event_id: "0192a6f0-0000-7000-8000-0000000000e2", type: "account.id_changed", account_uuid: "a8K", url: "https://briefcase.example/hooks/accounts", status: "failed", attempts: 9, last_status: 500, last_error: "HTTP 500 from the receiver", next_attempt_at: null, last_attempt_at: iso(-60 * 20), delivered_at: null, created_at: iso(-60 * 80), manual_replays: 0 },
  { id: "d3", event_id: "0192a6f0-0000-7000-8000-0000000000e3", type: "ping", account_uuid: null, url: "https://briefcase.example/hooks/accounts", status: "pending", attempts: 2, last_status: 502, last_error: "HTTP 502 from the receiver", next_attempt_at: iso(1), last_attempt_at: iso(-1), delivered_at: null, created_at: iso(-3), manual_replays: 1 },
];

export const importJob: ImportJob = {
  id: "0192a6f0-0000-7000-8000-0000000000f1",
  app_id: "briefcase",
  status: "completed",
  format: "csv",
  total_rows: 48,
  processed_rows: 48,
  counts: { created: 31, matched: 9, updated: 0, skipped: 3, error: 5, warnings: 7 },
  options: { default_country: "IN", ignore_unknown_columns: false, dry_run: false, update_existing: false },
  dry_run: false,
  created_by: carbon.uuid,
  created_at: iso(-20),
  started_at: iso(-20),
  finished_at: iso(-19),
  error: null,
};

/** A hosted flow at a given step for an app (for the hosted pages' screenshots). */
export function flowView(appId: string, step: FlowView["step"] = "choose_method"): FlowView | null {
  const pub = appPublic(appId);
  if (!pub) return null;
  return {
    id: `flow_${appId}`,
    step,
    expires_at: iso(60),
    app: { app_id: pub.app_id, name: pub.name, logo_url: pub.logo_url, logo_dark_url: pub.logo_dark_url, homepage_url: pub.homepage_url, branding: pub.branding, copy: pub.copy, first_party: appId === "silicon-accounts" },
    methods: pub.methods,
    signed_in_as: null,
    challenge: step === "verify_code" ? { channel: "email", destination: "s***@gmail.com", expires_at: iso(10), resend_available_at: iso(0.5) } : null,
    signup: step === "signup" ? { display_name: "Saket", id: "c:saket-2", timezone: "Asia/Kolkata", dob: "2008-10-06", pfp_url: portrait("Saket", 206), email: "saket@example.test", phone: null, provider: null, provider_pfp_url: null, finishing_import: false, expires_at: iso(60 * 48) } : null,
    details: step === "details"
      ? {
        index: 0,
        count: 1,
        id: "details",
        title: null,
        subtitle: null,
        continue_label: null,
        layout: null,
        fields: [
          { field: "email", mode: "required", label: "Email address", value: "s***@gmail.com", missing: false, shared: true, previously_granted: false, new: true },
          { field: "timezone", mode: "optional", label: "Timezone", value: "Asia/Kolkata", missing: false, shared: false, previously_granted: false, new: true },
        ],
        challenge: null,
      }
      : null,
    review: null,
    redirect_to: step === "complete" ? `http://127.0.0.1:8593/${appId}/callback?code=sac_sample&state=xyz` : null,
    error: null,
    prompt: null,
    intent: "signin",
    method_hint: null,
  };
}
