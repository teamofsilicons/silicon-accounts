/**
 * Realistic API data for screenshots and local page work without the Rust server. App names, logos and branding come
 * from testkit/fake-apps.json (the same 15 apps the e2e suite seeds), so screenshots look like the real thing.
 * Everything here is sample data.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AppDetail, AppPublic, AppUser, Branding, BrowserSession, CarbonMe, CustodianRequest, FlowView, HistoryItem, ImportJob, ManagedSilicon, Meta,
  MyApp, MyProof, OwnedApp, SessionInfo, SigninConfigView, WebhookDelivery,
} from "../../src/api/types";
import { DEFAULT_BRANDING, DEFAULT_COPY, normalizeBranding, normalizeCopy } from "../../src/branding/defaults";

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

/** A soft squircle portrait with initials, as a data URI (no network in screenshot runs). */
export function portrait(name: string, hue = 212): string {
  const initials = name.split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 46% 74%)"/><stop offset="1" stop-color="hsl(${hue + 28} 42% 58%)"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><text x="48" y="60" font-family="Georgia, serif" font-size="38" text-anchor="middle" fill="#FFFDF9">${initials}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

const iso = (offsetMinutes: number, base = Date.UTC(2026, 9, 6, 9, 41)) => new Date(base + offsetMinutes * 60_000).toISOString().replace(/\.\d{3}Z$/, ".000Z");

export const meta: Meta = {
  name: "Silicon Accounts",
  version: "0.1.0",
  environment: "development",
  public_url: "http://localhost:5190",
  silicon_apps_url: "https://apps.teamofsilicons.com",
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

export const session: BrowserSession = {
  account: { uuid: carbon.uuid, kind: "carbon", id: carbon.id, display_name: carbon.display_name, pfp_url: carbon.pfp_url, status: "active" },
  session: { id: "0192a6f0-4b1e-7c1d-9f00-3c1e0f0d1a2b", created_at: iso(-60 * 24 * 3), expires_at: "2029-03-25T09:41:00.000Z" },
};

const summary = (app: FakeApp) => ({ app_id: app.app_id, name: app.name, logo_url: app.logo_url ?? null, logo_dark_url: app.logo_dark_url ?? null, homepage_url: app.homepage_url ?? null });

export const myApps: MyApp[] = ["briefcase", "dm", "commit", "remind", "interface", "waveform", "spacestation"]
  .map(id => fakeApp(id))
  .filter((app): app is FakeApp => !!app)
  .map((app, index) => ({
    app: summary(app),
    membership_id: `${app.app_id}:${carbon.uuid}`,
    status: index === 6 ? "access_removed" : "active",
    granted_scopes: index % 2 ? ["profile", "email", "timezone"] : ["profile", "email"],
    first_signed_in_at: iso(-60 * 24 * (30 - index * 3)),
    last_signed_in_at: iso(-60 * (index * 7 + 2)),
    active_sessions: index === 6 ? 0 : (index % 3) + 1,
  }));

export const sessions: SessionInfo[] = [
  { id: session.session.id, kind: "browser", label: "Safari on macOS", ip: "103.48.12.9", user_agent: "Mozilla/5.0 (Macintosh)", created_at: iso(-60 * 24 * 3), last_seen_at: iso(-2), current: true },
  { id: "0192a6f0-0000-7000-8000-000000000002", kind: "cli", label: "accounts CLI on build-box", ip: "103.48.12.11", user_agent: "silicon-accounts-cli/0.1.0", created_at: iso(-60 * 24 * 9), last_seen_at: iso(-60 * 5), current: false },
];

export const silicons: ManagedSilicon[] = [
  { uuid: "Qz4", kind: "silicon", id: "si:scout", display_name: "Scout", pfp_url: portrait("Scout", 160), dob: "2026-09-03", timezone: "Asia/Kolkata", status: "active", created_at: "2026-09-03T10:00:00.000Z", updated_at: iso(-300), version: 3, custodian: session.account, webhook_url: "https://scout.example/hooks/accounts", stk_rotated_at: iso(-60 * 24 * 6), pending_transfer: null },
  { uuid: "Lm8", kind: "silicon", id: "si:head_of_growth", display_name: "Head of Growth", pfp_url: portrait("Head of Growth", 32), dob: "2026-09-11", timezone: "Europe/London", status: "active", created_at: "2026-09-11T10:00:00.000Z", updated_at: iso(-800), version: 2, custodian: session.account, webhook_url: null, stk_rotated_at: iso(-60 * 24 * 20), pending_transfer: { id: "0192a6f0-0000-7000-8000-0000000000aa", to: "c:shubham", created_at: iso(-60 * 20), expires_at: iso(60 * 24 * 13) } },
  { uuid: "Tb2", kind: "silicon", id: "si:atlas", display_name: "Atlas", pfp_url: portrait("Atlas", 270), dob: "2026-10-01", timezone: "UTC", status: "pending_custodian", created_at: "2026-10-01T10:00:00.000Z", updated_at: iso(-1200), version: 1, custodian: null, webhook_url: null, stk_rotated_at: null, pending_transfer: null },
];

export const custodianRequests: CustodianRequest[] = [
  { id: "0192a6f0-0000-7000-8000-0000000000cc", kind: "initial", silicon: { uuid: "Vx7", kind: "silicon", id: "si:courier", display_name: "Courier", pfp_url: portrait("Courier", 120), status: "pending_custodian" }, from: null, created_at: iso(-45), expires_at: iso(60 * 24 * 14 - 45) },
];

export const proofs: MyProof[] = [
  { proof_id: "0192a6f0-0000-7000-8000-0000000000p1", issuing_app: summary(fakeApp("dm") ?? fakeApps[0]!), receiving_app: summary(fakeApp("briefcase") ?? fakeApps[0]!), scopes: ["files.write"], created_at: iso(-30), expires_at: iso(1), last_refreshed_at: iso(-4), status: "active" },
  { proof_id: "0192a6f0-0000-7000-8000-0000000000p2", issuing_app: summary(fakeApp("interface") ?? fakeApps[0]!), receiving_app: summary(fakeApp("remind") ?? fakeApps[0]!), scopes: ["reminders.create"], created_at: iso(-60 * 5), expires_at: iso(-60 * 4), last_refreshed_at: null, status: "expired" },
];

export const history: HistoryItem[] = [
  { id: "h1", kind: "signin", at: iso(-2), title: "Signed in to Briefcase", detail: "Email code · Safari on macOS", app: summary(fakeApp("briefcase") ?? fakeApps[0]!), meta: {} },
  { id: "h2", kind: "proof", at: iso(-30), title: "DM got a proof for Briefcase", detail: "files.write, valid 30 minutes", app: summary(fakeApp("dm") ?? fakeApps[0]!), meta: {} },
  { id: "h3", kind: "id_change", at: iso(-60 * 26), title: "Changed id from c:saketdev to c:saket", detail: "c:saketdev stays reserved for you for 10 days", app: null, meta: { old_id: "c:saketdev", new_id: "c:saket" } },
  { id: "h4", kind: "custodian", at: iso(-60 * 50), title: "Became custodian of si:scout", detail: null, app: null, meta: {} },
];

const page = <T>(items: T[]) => ({ items, next_cursor: null });

export function ownedApps(owner = "c:saket"): OwnedApp[] {
  return fakeApps
    .filter(app => app.owner_id === owner)
    .map((app, index) => ({ app_id: app.app_id, name: app.name, logo_url: app.logo_url ?? null, status: app.status ?? "active", source: "fake" as const, users: [1284, 312, 96, 41, 7][index % 5] ?? 3, created_at: app.created_at ?? "2026-09-01T09:00:00.000Z" }));
}

export function appPublic(appId: string): AppPublic | null {
  const app = fakeApp(appId);
  if (!app) return null;
  const defaults = app.signin_defaults ?? {};
  const methods = (defaults.methods ?? { email: true }) as Record<string, boolean>;
  const order = (defaults.method_order as string[] | undefined) ?? ["google", "apple", "email", "phone"];
  return {
    ...summary(app),
    logo_dark_url: app.logo_dark_url ?? null,
    methods: order.filter(method => methods[method]) as AppPublic["methods"],
    branding: normalizeBranding({ ...DEFAULT_BRANDING, ...(defaults.branding ?? {}) }),
    copy: normalizeCopy({ ...DEFAULT_COPY, ...(defaults.copy ?? {}) }),
  };
}

export function appDetail(appId: string): AppDetail | null {
  const app = fakeApp(appId);
  const pub = appPublic(appId);
  if (!app || !pub) return null;
  const defaults = app.signin_defaults ?? {};
  const config: SigninConfigView = {
    methods: { email: false, phone: false, google: false, apple: false, ...(defaults.methods as object) },
    method_order: (defaults.method_order as SigninConfigView["method_order"]) ?? ["google", "apple", "email", "phone"],
    google: { mode: "managed", client_id: null, prompt: "select_account", hosted_domain: null, ...(defaults.google as object), client_secret_set: !!(defaults.google as { client_secret?: string } | undefined)?.client_secret },
    apple: { mode: "managed", services_id: null, team_id: null, key_id: null, ...(defaults.apple as object), private_key_set: !!(defaults.apple as { private_key?: string } | undefined)?.private_key },
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
  delete (config.google as { client_secret?: string }).client_secret;
  delete (config.apple as { private_key?: string }).private_key;
  return {
    ...pub,
    description: app.description ?? null,
    owner: { uuid: carbon.uuid, kind: "carbon", id: app.owner_id, display_name: app.owner_id === "c:saket" ? carbon.display_name : app.owner_id, pfp_url: carbon.pfp_url, status: "active" },
    status: app.status ?? "active",
    source: "fake",
    created_at: app.created_at ?? "2026-09-01T09:00:00.000Z",
    signin_config: config,
    config_version: 4,
    webhook: { url: app.webhook_url ?? null, secret_set: !!app.webhook_url },
    stats: { users: 1284, active_last_30d: 942, imported_unclaimed: 86 },
  };
}

export const appUsers: AppUser[] = [
  { membership_id: "briefcase:a8K", uuid: "a8K", kind: "carbon", id: "c:saket", display_name: "Saket Dev", pfp_url: carbon.pfp_url, email: "saketdev12@gmail.com", phone: null, timezone: "Asia/Kolkata", status: "active", source: "signin", external_id: null, granted_scopes: ["profile", "email", "timezone"], first_signed_in_at: iso(-60 * 24 * 30), last_signed_in_at: iso(-2), created_at: iso(-60 * 24 * 30) },
  { membership_id: "briefcase:Qz4", uuid: "Qz4", kind: "silicon", id: "si:scout", display_name: "Scout", pfp_url: portrait("Scout", 160), status: "active", source: "slt", external_id: null, granted_scopes: ["profile", "timezone"], first_signed_in_at: iso(-60 * 24 * 12), last_signed_in_at: iso(-60 * 3), created_at: iso(-60 * 24 * 12) },
  { membership_id: "briefcase:Pn3", uuid: "Pn3", kind: "carbon", id: "c:mira", display_name: "Mira Chen", pfp_url: portrait("Mira Chen", 340), email: "mira@northwind.test", status: "imported", source: "import", external_id: "crm-1042", granted_scopes: ["profile"], first_signed_in_at: null, last_signed_in_at: null, created_at: iso(-60 * 24 * 2) },
];

export const deliveries: WebhookDelivery[] = [
  { id: "d1", event_id: "0192a6f0-0000-7000-8000-0000000000e1", type: "account.updated", status: "delivered", attempts: 1, last_status: 200, last_error: null, next_attempt_at: null, delivered_at: iso(-12), created_at: iso(-12), manual_replays: 0 },
  { id: "d2", event_id: "0192a6f0-0000-7000-8000-0000000000e2", type: "account.id_changed", status: "failed", attempts: 9, last_status: 500, last_error: "HTTP 500 from the receiver", next_attempt_at: null, delivered_at: null, created_at: iso(-60 * 80), manual_replays: 0 },
  { id: "d3", event_id: "0192a6f0-0000-7000-8000-0000000000e3", type: "ping", status: "pending", attempts: 2, last_status: 502, last_error: "HTTP 502 from the receiver", next_attempt_at: iso(1), delivered_at: null, created_at: iso(-3), manual_replays: 1 },
];

export const importJob: ImportJob = {
  id: "0192a6f0-0000-7000-8000-0000000000j1",
  status: "completed",
  format: "csv",
  total_rows: 48,
  processed_rows: 48,
  counts: { created: 31, matched: 9, updated: 0, skipped: 3, error: 5, warnings: 7 },
  created_at: iso(-20),
  started_at: iso(-20),
  finished_at: iso(-19),
  error: null,
};

/** A hosted flow at a given step for an app (for the auth area's screenshots). */
export function flowView(appId: string, step: FlowView["step"] = "choose_method"): FlowView | null {
  const pub = appPublic(appId);
  if (!pub) return null;
  return {
    id: `flow_${appId}`,
    step,
    expires_at: iso(60),
    app: { app_id: pub.app_id, name: pub.name, logo_url: pub.logo_url, logo_dark_url: pub.logo_dark_url, homepage_url: pub.homepage_url, branding: pub.branding, copy: pub.copy, first_party: false },
    methods: pub.methods,
    signed_in_as: null,
    challenge: step === "verify_code" ? { channel: "email", destination: "s***@gmail.com", expires_at: iso(10), resend_available_at: iso(0.5) } : null,
    signup: step === "signup" ? { display_name: "Saket", id: "c:saket-2", timezone: "Asia/Kolkata", dob: "2008-10-06", pfp_url: portrait("Saket", 206), email: "saket@example.test", phone: null, provider: null, finishing_import: false, expires_at: iso(60 * 48) } : null,
    requirements: step === "requirements" ? { missing: ["phone"], challenge: null } : null,
    consent: step === "consent" ? { required: [{ scope: "email", label: "Email address", value: "s***@gmail.com" }], optional: [{ scope: "timezone", label: "Timezone", value: "Asia/Kolkata", granted: false }], previously_granted: ["profile"] } : null,
    redirect_to: step === "complete" ? `http://127.0.0.1:8593/${appId}/callback?code=sac_sample&state=xyz` : null,
    error: null,
  };
}

export { page };
