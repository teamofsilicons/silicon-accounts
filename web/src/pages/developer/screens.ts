/**
 * Screens of the developer area for `pnpm screens` (both themes, 1440 and 390 px), with the mock API routes they need:
 * config history, PATCH, a fuller user base, imports with rows, webhook deliveries with attempts and payloads, proofs and
 * OIDC discovery. Sample data only.
 */
import type { Page } from "@playwright/test";
import type { MockRoute, ScreenSpec } from "../../../scripts/screens-types";
import * as data from "../../../scripts/mock/fixtures";

const BASE = Date.UTC(2026, 9, 6, 9, 41);
const iso = (minutes: number) => new Date(BASE + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, ".000Z");
const page = <T>(items: T[], next: string | null = null) => ({ items, next_cursor: next });
const owner = data.session.account;

/* ----------------------------------------------- user base ----------------------------------------------- */

const people: Array<[string, string, "carbon" | "silicon", string, string, number, string | null]> = [
  ["a8K", "Saket Dev", "carbon", "active", "signin", -2, "saketdev12@gmail.com"],
  ["Qz4", "Scout", "silicon", "active", "slt", -180, null],
  ["Pn3", "Mira Chen", "carbon", "imported", "import", 0, "mira@northwind.test"],
  ["Lm8", "Head of Growth", "silicon", "active", "slt", -60 * 26, null],
  ["Kd2", "Shubham", "carbon", "active", "signin", -60 * 5, "shubhastro2@gmail.com"],
  ["Ra9", "Ada Okafor", "carbon", "access_removed", "signin", -60 * 24 * 9, null],
  ["Ue1", "Courier", "silicon", "active", "slt", -45, null],
  ["Vb6", "Jonas Weber", "carbon", "imported", "import", 0, "jonas@weber.test"],
  ["Hx5", "Priya Nair", "carbon", "active", "signin", -60 * 50, "priya@nair.test"],
  ["Ty3", "Deleted account", "carbon", "deleted", "signin", -60 * 24 * 40, null],
];

const users = people.map(([uuid, name, kind, status, source, last, email], index) => ({
  membership_id: `briefcase:${uuid}`,
  uuid,
  kind,
  id: status === "deleted" ? null : kind === "carbon" ? `c:${name.toLowerCase().split(" ")[0]}` : `si:${name.toLowerCase().replace(/\s+/g, "_")}`,
  display_name: name,
  pfp_url: data.portrait(name, (index * 47 + 160) % 360),
  ...(email ? { email } : {}),
  ...(kind === "carbon" && index % 3 === 0 ? { phone: "+919876543210" } : {}),
  ...(status === "active" ? { timezone: index % 2 ? "Europe/Berlin" : "Asia/Kolkata" } : {}),
  status,
  source,
  external_id: source === "import" ? `crm-${1040 + index}` : null,
  granted_scopes: kind === "silicon" ? ["profile", "timezone"] : ["profile", "email", "timezone"],
  first_signed_in_at: status === "imported" ? null : iso(-60 * 24 * (30 - index)),
  last_signed_in_at: status === "imported" ? null : iso(last),
  created_at: iso(-60 * 24 * (30 - index)),
  account_status: status === "deleted" ? "deleted" : status === "imported" ? "unclaimed" : "active",
}));

const userDetail = (uuid: string) => {
  const user = users.find(entry => entry.uuid === uuid) ?? users[0];
  const methods = user?.kind === "silicon" ? ["slt", "slt", "slt"] : ["email", "google", "email", "phone"];
  return {
    ...user,
    history: Array.from({ length: 6 }, (_, index) => ({ at: iso(-2 - index * 60 * 19), method: methods[index % methods.length], outcome: index === 3 ? "failed" : index === 5 ? "new_account" : "success" })),
  };
};

/* ------------------------------------------------- history ------------------------------------------------- */

const history = [
  { version: 4, actor: owner.uuid, actor_account: owner, at: iso(-35), changes: [{ path: "branding.radius", before: 14, after: 18 }, { path: "branding.light.primary", before: "#2A6FCB", after: "#1F5FB8" }] },
  { version: 3, actor: "app", actor_account: null, at: iso(-60 * 26), changes: [{ path: "redirect_uris", before: ["http://127.0.0.1:8593/briefcase/callback"], after: ["http://127.0.0.1:8593/briefcase/callback", "https://briefcase.example/auth/callback"] }] },
  { version: 2, actor: owner.uuid, actor_account: owner, at: iso(-60 * 24 * 3), changes: [{ path: "methods.apple", before: false, after: true }, { path: "google.client_secret", before: null, after: "[redacted]", secret: true }] },
  { version: 1, actor: "seed", actor_account: null, at: iso(-60 * 24 * 30), changes: [{ path: "copy.title", before: null, after: "Sign in to Briefcase" }] },
];

/* -------------------------------------------------- imports ------------------------------------------------- */

const jobs = [
  { ...data.importJob, id: "0192a6f0-0000-7000-8000-0000000000j1", app_id: "briefcase", options: { default_country: "US", ignore_unknown_columns: true, dry_run: false, update_existing: false }, dry_run: false, created_by: owner.uuid },
  { ...data.importJob, id: "0192a6f0-0000-7000-8000-0000000000j0", app_id: "briefcase", options: { default_country: "US", ignore_unknown_columns: false, dry_run: true, update_existing: false }, dry_run: true, created_at: iso(-60 * 26), started_at: iso(-60 * 26), finished_at: iso(-60 * 26 + 1), counts: { created: 31, matched: 9, updated: 0, skipped: 3, error: 5, warnings: 7 }, created_by: owner.uuid },
];

const importRows = [
  { row_number: 1, outcome: "created", account_uuid: "Wq1", id: "c:john", messages: [], input: { email: "john@example.com", display_name: "John Park", username: "john" } },
  { row_number: 2, outcome: "created", account_uuid: "Wq2", id: "c:mira-2", messages: [{ level: "warning", code: "id_conflict", message: "wanted c:mira, assigned c:mira-2 because c:mira belongs to another account", field: "username" }], input: { email: "mira@northwind.test", username: "mira" } },
  { row_number: 3, outcome: "matched", account_uuid: "a8K", id: "c:saket", messages: [], input: { email: "saketdev12@gmail.com" } },
  { row_number: 4, outcome: "error", account_uuid: null, id: null, messages: [{ level: "error", code: "missing_identifier", message: "The row has no valid email or phone number, so it can't be matched to an account or create one.", field: null }], input: { display_name: "No Contact" } },
  { row_number: 5, outcome: "created", account_uuid: "Wq3", id: "c:lena", messages: [{ level: "warning", code: "invalid_phone", message: "'555-01' is not a phone number for US; it was dropped and the row was imported with its email.", field: "phone" }], input: { email: "lena@example.com", phone: "555-01" } },
  { row_number: 6, outcome: "skipped", account_uuid: null, id: null, messages: [{ level: "info", code: "duplicate_in_file", message: "john@example.com already appeared in row 1; this row was skipped.", field: "email" }], input: { email: "john@example.com" } },
  { row_number: 7, outcome: "error", account_uuid: null, id: null, messages: [{ level: "error", code: "ambiguous_match", message: "ana@example.com and +12025550142 belong to two different accounts, so the row can't be matched to one.", field: null }], input: { email: "ana@example.com", phone: "+12025550142" } },
  { row_number: 8, outcome: "created", account_uuid: "Wq4", id: "c:omar", messages: [{ level: "warning", code: "invalid_dob", message: "'04/05/1990' could be April 5 or May 4; the default date of birth was used.", field: "dob" }], input: { email: "omar@example.com", dob: "04/05/1990" } },
];

/* ------------------------------------------------- webhooks ------------------------------------------------- */

const deliveryPayload = (type: string, eventId: string) => ({
  event_id: eventId,
  type,
  occurred_at: iso(-12),
  app_id: "briefcase",
  silicon: null,
  data: type === "ping" ? {} : { uuid: "a8K", membership_id: "briefcase:a8K", kind: "carbon", old_id: "c:saketdev", new_id: "c:saket" },
});

const deliveries = [
  ...data.deliveries.map(delivery => ({ ...delivery, id: `0192a6f0-0000-7000-8000-00000000d${delivery.id.slice(1)}0`, url: "http://127.0.0.1:8593/briefcase/webhooks", account_uuid: "a8K", last_attempt_at: delivery.created_at })),
  { id: "0192a6f0-0000-7000-8000-00000000d400", event_id: "0192a6f0-0000-7000-8000-0000000000e4", type: "membership.signed_out", status: "delivered", attempts: 1, last_status: 204, last_error: null, next_attempt_at: null, last_attempt_at: iso(-60 * 3), delivered_at: iso(-60 * 3), created_at: iso(-60 * 3), manual_replays: 0, url: "http://127.0.0.1:8593/briefcase/webhooks", account_uuid: "Kd2" },
  { id: "0192a6f0-0000-7000-8000-00000000d500", event_id: "0192a6f0-0000-7000-8000-0000000000e5", type: "account.deleted", status: "failed", attempts: 9, last_status: null, last_error: "Connection refused (os error 61) while connecting to 127.0.0.1:8593", next_attempt_at: null, last_attempt_at: iso(-60 * 70), delivered_at: null, created_at: iso(-60 * 74), manual_replays: 1, url: "http://127.0.0.1:8593/briefcase/webhooks", account_uuid: "Ty3" },
];

const deliveryDetail = (id: string) => {
  const delivery = deliveries.find(entry => entry.id === id) ?? deliveries[0];
  if (!delivery) return null;
  return {
    ...delivery,
    attempt_count: delivery.attempts,
    attempts: Array.from({ length: Math.min(delivery.attempts, 4) }, (_, index) => ({
      attempted_at: iso(-60 * 70 + index * 10),
      status_code: delivery.status === "delivered" && index === delivery.attempts - 1 ? 200 : delivery.last_status,
      error: delivery.status === "delivered" && index === delivery.attempts - 1 ? null : delivery.last_error,
      duration_ms: 84 + index * 37,
    })),
    payload: deliveryPayload(delivery.type, delivery.event_id),
    payload_redacted: false,
  };
};

/* -------------------------------------------------- proofs -------------------------------------------------- */

const proofs = [
  { proof_id: "0192a6f0-0000-7000-8000-0000000000a1", kind: "ata", audiences: ["remind", "waveform"], user: null, scopes: ["notify.send"], status: "active", access_ttl_seconds: 1800, created_at: iso(-50), expires_at: iso(60 * 24 * 900), token_expires_at: iso(-20), last_refreshed_at: iso(-50), revoked_at: null, revoke_reason: null },
  { proof_id: "0192a6f0-0000-7000-8000-0000000000a2", kind: "obo", audiences: ["dm"], user: { uuid: "a8K", kind: "carbon", id: "c:saket", display_name: "Saket Dev", pfp_url: data.carbon.pfp_url, status: "active" }, scopes: ["files.write", "files.read"], status: "active", access_ttl_seconds: 600, created_at: iso(-30), expires_at: iso(60 * 24 * 900), token_expires_at: iso(6), last_refreshed_at: iso(-4), revoked_at: null, revoke_reason: null },
  { proof_id: "0192a6f0-0000-7000-8000-0000000000a3", kind: "obo", audiences: ["interface"], user: { uuid: "Qz4", kind: "silicon", id: "si:scout", display_name: "Scout", pfp_url: data.portrait("Scout", 160), status: "active" }, scopes: [], status: "revoked", access_ttl_seconds: 1800, created_at: iso(-60 * 20), expires_at: iso(60 * 24 * 900), token_expires_at: null, last_refreshed_at: null, revoked_at: iso(-60 * 2), revoke_reason: "access_removed" },
  { proof_id: "0192a6f0-0000-7000-8000-0000000000a4", kind: "ata", audiences: ["commit"], user: null, scopes: ["builds.read"], status: "expired", access_ttl_seconds: 60, created_at: iso(-60 * 24 * 2), expires_at: iso(-60), token_expires_at: iso(-60 * 24 * 2 + 1), last_refreshed_at: null, revoked_at: null, revoke_reason: null },
];

/* --------------------------------------------------- routes --------------------------------------------------- */

const discovery = {
  issuer: data.meta.public_url,
  authorization_endpoint: `${data.meta.public_url}/authorize`,
  token_endpoint: `${data.meta.public_url}/v1/oauth/token`,
  userinfo_endpoint: `${data.meta.public_url}/v1/userinfo`,
  jwks_uri: `${data.meta.public_url}/.well-known/jwks.json`,
  revocation_endpoint: `${data.meta.public_url}/v1/oauth/revoke`,
  introspection_endpoint: `${data.meta.public_url}/v1/oauth/introspect`,
  device_authorization_endpoint: `${data.meta.public_url}/v1/device/authorize`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code", "urn:silicon:params:oauth:grant-type:slt"],
  code_challenge_methods_supported: ["S256", "plain"],
  id_token_signing_alg_values_supported: ["EdDSA"],
  scopes_supported: ["openid", "profile", "email", "phone", "dob", "timezone", "offline_access"],
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
  claims_supported: ["sub", "name", "picture", "email", "email_verified", "phone_number", "phone_number_verified", "zoneinfo", "birthdate"],
};

export function developerRoutes(): MockRoute[] {
  let version = 4;
  return [
    ["GET /v1/apps/:appId/signin-config/history", () => ({ json: page(history) })],
    ["PATCH /v1/apps/:appId/signin-config", ({ params, body }) => {
      const detail = data.appDetail(params.appId ?? "");
      if (!detail) return { status: 404, json: { error: { code: "unknown_app", message: `No app with app_id '${params.appId}' exists.` } } };
      version += 1;
      const patch = (body ?? {}) as Record<string, unknown>;
      const merged = { ...detail.signin_config } as Record<string, unknown>;
      for (const [key, value] of Object.entries(patch)) if (key !== "expected_version") merged[key] = value && typeof value === "object" && !Array.isArray(value) ? { ...(merged[key] as object), ...(value as object) } : value;
      return { json: { ...detail, signin_config: merged, config_version: version }, delay: 400 };
    }],
    ["GET /v1/apps/:appId/users", ({ query }) => {
      const q = (query.get("q") ?? "").toLowerCase();
      const status = query.get("status");
      const kind = query.get("kind");
      const items = users.filter(user => (!q || `${user.id} ${user.display_name} ${user.email ?? ""}`.toLowerCase().includes(q)) && (!status || user.status === status) && (!kind || user.kind === kind));
      return { json: page(items) };
    }],
    ["GET /v1/apps/:appId/users/:uuid", ({ params }) => ({ json: userDetail(params.uuid ?? "") })],
    ["GET /v1/apps/:appId/imports", () => ({ json: page(jobs) })],
    ["GET /v1/apps/:appId/imports/:jobId", ({ params }) => ({ json: { job: jobs.find(job => job.id === params.jobId) ?? jobs[0] } })],
    ["GET /v1/apps/:appId/imports/:jobId/rows", ({ query }) => {
      const outcome = query.get("outcome");
      const level = query.get("level");
      return { json: page(importRows.filter(row => (!outcome || row.outcome === outcome) && (!level || row.messages.some(message => message.level === level)))) };
    }],
    ["POST /v1/apps/:appId/imports", () => ({ status: 202, json: { job: { ...jobs[0], id: "0192a6f0-0000-7000-8000-0000000000j9", status: "queued", processed_rows: 0, total_rows: 8, counts: { created: 0, matched: 0, updated: 0, skipped: 0, error: 0, warnings: 0 }, started_at: null, finished_at: null } } })],
    ["GET /v1/apps/:appId/webhook/deliveries", ({ query }) => {
      const status = query.get("status");
      return { json: page(deliveries.filter(delivery => !status || delivery.status === status)) };
    }],
    ["GET /v1/apps/:appId/webhook/deliveries/:id", ({ params }) => ({ json: deliveryDetail(params.id ?? "") })],
    ["POST /v1/apps/:appId/webhook/replay", ({ body }) => {
      const ids = (body as { delivery_ids?: string[] } | null)?.delivery_ids ?? deliveries.filter(delivery => delivery.status === "failed").map(delivery => delivery.id);
      return { json: { replayed: ids.slice(0, -1), skipped: ids.slice(-1).map(id => ({ delivery_id: id, reason: "account_deleted", message: "Not replayed because the account was deleted; an app that lost access never gets account data replayed." })), remaining: 0, not_replayable: 1, url: "http://127.0.0.1:8593/briefcase/webhooks" } };
    }],
    ["POST /v1/apps/:appId/webhook/test", () => ({ status: 202, json: { event_id: "0192a6f0-0000-7000-8000-0000000000e9", delivery_id: "0192a6f0-0000-7000-8000-00000000d900", type: "ping" } })],
    ["PUT /v1/apps/:appId/webhook", ({ body }) => ({ json: { url: (body as { url?: string } | null)?.url ?? "", secret: "whsec_Jx3m9QpZt7bV2kLr8sYd4nW1cF6hA0eG5uT" } })],
    ["POST /v1/apps/:appId/webhook/rotate-secret", () => ({ json: { secret: "whsec_Q8n2Lk5vR1tZ7mX4cB9pW3yH6dF0sJ2aE8g" } })],
    ["DELETE /v1/apps/:appId/webhook", () => ({ status: 204 })],
    ["GET /v1/apps/:appId/proofs", ({ query }) => {
      const kind = query.get("kind");
      const status = query.get("status");
      return { json: page(proofs.filter(proof => (!kind || proof.kind === kind) && (!status || proof.status === status))) };
    }],
    ["POST /v1/apps/:appId/proofs/ata", ({ params, body }) => {
      const request = (body ?? {}) as { audiences?: string[]; scopes?: string[]; access_ttl_seconds?: number };
      return {
        status: 201,
        json: {
          proof_id: "0192a6f0-0000-7000-8000-0000000000a9",
          kind: "ata",
          proof_token: "sap_kV3q9ZtX1mB7nR4cW8yL2pD6sH0fJ5aG3uE9oQ1",
          expires_at: iso(request.access_ttl_seconds ? request.access_ttl_seconds / 60 : 30),
          proof_refresh_token: "sapr_N7w2Kx9mQ4tB1vZ8cL5rY3pH6dF0sJ2aE7gU4i",
          refresh_expires_at: iso(60 * 24 * 900),
          issuing_app: params.appId,
          receiving_apps: request.audiences ?? [],
          user: null,
          scopes: request.scopes ?? [],
        },
      };
    }],
    ["DELETE /v1/apps/:appId/proofs/:proofId", () => ({ status: 204 })],
    ["GET /.well-known/openid-configuration", () => ({ json: discovery })],
    ["GET /.well-known/jwks.json", () => ({ json: { keys: [{ kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo", kid: "dev-1", use: "sig", alg: "EdDSA" }] } })],
  ];
}

const settle = (ms: number) => async (page: Page) => { await page.waitForTimeout(ms); };

const UNKNOWN_CSV = "email,display_name,username,plan,signup_source\nada@example.com,Ada Okafor,ada,pro,ads\njohn@example.com,John Park,john,free,\nmira@northwind.test,Mira Chen,mira,studio,referral";

export const screens: ScreenSpec[] = [
  { name: "developer-apps", path: "/developer", routes: developerRoutes() },
  { name: "developer-overview", path: "/developer/briefcase", routes: developerRoutes() },
  { name: "developer-signin", path: "/developer/briefcase/sign-in", routes: developerRoutes(), prepare: settle(300) },
  { name: "developer-signin-byo", path: "/developer/acme-notes/sign-in", routes: developerRoutes(), widths: [1440] },
  {
    name: "developer-signin-dirty",
    path: "/developer/briefcase/sign-in",
    routes: developerRoutes(),
    fullPage: false,
    prepare: async page => {
      // From the keyboard: on phones the floating dock covers the lower part of the screen, so a click could land on it.
      const toggle = page.locator('li[data-method="phone"] [role="switch"]');
      await toggle.scrollIntoViewIfNeeded();
      await toggle.focus();
      await page.keyboard.press("Space");
      await page.waitForTimeout(700);
      if (!(await toggle.isChecked())) throw new Error("developer-signin-dirty: the Phone switch did not turn on, so the screen would not show unsaved changes.");
    },
  },
  { name: "developer-branding", path: "/developer/briefcase/branding", routes: developerRoutes(), settle: 1200 },
  { name: "developer-branding-split", path: "/developer/acme-notes/branding", routes: developerRoutes(), widths: [1440], settle: 1200 },
  {
    name: "developer-branding-phone-code",
    path: "/developer/pixel-studio/branding",
    routes: developerRoutes(),
    widths: [1440],
    settle: 1000,
    fullPage: false,
    prepare: async page => {
      await page.getByRole("button", { name: "Phone", exact: true }).click();
      await page.getByRole("button", { name: "Code", exact: true }).click();
      await page.waitForTimeout(900);
    },
  },
  { name: "developer-users", path: "/developer/briefcase/users", routes: developerRoutes() },
  {
    name: "developer-users-drawer",
    path: "/developer/briefcase/users",
    routes: developerRoutes(),
    fullPage: false,
    prepare: async page => {
      await page.locator("tbody tr[data-row]").first().click();
      await page.waitForTimeout(1000);
    },
  },
  { name: "developer-import", path: "/developer/briefcase/import", routes: developerRoutes() },
  {
    name: "developer-import-check",
    path: "/developer/briefcase/import",
    routes: developerRoutes(),
    prepare: async page => {
      await page.getByRole("button", { name: "Paste instead" }).click();
      await page.getByLabel("Paste CSV or JSON").fill(UNKNOWN_CSV);
      await page.getByRole("button", { name: "Check columns", exact: true }).click();
      await page.waitForTimeout(900);
    },
  },
  {
    name: "developer-import-report",
    path: "/developer/briefcase/import",
    routes: developerRoutes(),
    prepare: async page => {
      await page.locator("button", { hasText: "created" }).first().click();
      await page.waitForTimeout(1400);
    },
  },
  { name: "developer-webhooks", path: "/developer/briefcase/webhooks", routes: developerRoutes() },
  {
    name: "developer-webhooks-drawer",
    path: "/developer/briefcase/webhooks",
    routes: developerRoutes(),
    fullPage: false,
    prepare: async page => {
      await page.getByRole("button", { name: /^Open delivery/ }).nth(1).click();
      await page.waitForTimeout(1100);
    },
  },
  { name: "developer-proofs", path: "/developer/briefcase/proofs", routes: developerRoutes() },
  {
    name: "developer-proofs-issued",
    path: "/developer/briefcase/proofs",
    routes: developerRoutes(),
    widths: [1440],
    prepare: async page => {
      const audiences = page.getByLabel("Apps that may verify it");
      await audiences.fill("remind");
      await audiences.press("Enter");
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: "Issue the proof" }).click();
      await page.waitForTimeout(1100);
    },
  },
  { name: "developer-embed", path: "/developer/briefcase/embed", routes: developerRoutes(), settle: 1200 },
];
