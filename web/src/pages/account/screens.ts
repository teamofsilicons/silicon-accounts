/**
 * Screenshots of the account pages (picked up by `pnpm screens`), with a stateful mock of the account endpoints.
 *
 * The answers follow the real service's shapes (crates/account, crates/silicons, crates/proofs READMEs): lists are
 * `{items, next_cursor}`, a pending transfer names its recipient as an AccountSummary or `{email}`, proofs carry
 * `token_expires_at`, and history items carry the meta each source really sends (crates/account/src/history.rs:
 * signin, handle, custodian, proof, membership and audit rows). Times are relative to now, so countdowns and expiry
 * rings look the way they do for a real account. The state resets on every page load (the shell's GET /v1/session),
 * so each theme and width starts fresh.
 */
import type { Page } from "@playwright/test";
import type {
  AccountSummary, CarbonMe, CustodianRequest, EmailView, HistoryItem, IdentityView, ManagedSilicon, MyApp, MyProof, PhoneView, SessionInfo,
} from "../../api/types";
import type { MockReply, MockRequest, MockRoute, ScreenSpec } from "../../../scripts/screens-types";
import { fakeApp, portrait } from "../../../scripts/mock/fixtures";

const MINUTE = 60_000;
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const ago = (ms: number) => at(-ms);

const fail = (status: number, code: string, message: string, hint?: string, details?: Record<string, unknown>): MockReply => ({ status, json: { error: { code, message, hint, details } } });
const page = <T>(items: T[]) => ({ json: { items, next_cursor: null } });

const appSummary = (appId: string) => {
  const app = fakeApp(appId);
  return { app_id: appId, name: app?.name ?? appId, logo_url: app?.logo_url ?? null, logo_dark_url: app?.logo_dark_url ?? null, homepage_url: app?.homepage_url ?? null };
};

const summary = (uuid: string, kind: "carbon" | "silicon", id: string, name: string, hue: number, status: AccountSummary["status"] = "active"): AccountSummary => ({
  uuid, kind, id, display_name: name, pfp_url: portrait(name, hue), status,
});

const SAKET = summary("a8K", "carbon", "c:saket", "Saket Dev", 206);
const SHUBHAM = summary("Rw2", "carbon", "c:shubham", "Shubham Rao", 18);
const MIRA = summary("Pn3", "carbon", "c:mira", "Mira Chen", 340);

interface State {
  me: CarbonMe;
  apps: MyApp[];
  proofs: Array<MyProof & { token_expires_at: string | null; revoked_at: string | null; revoke_reason: string | null }>;
  silicons: ManagedSilicon[];
  requests: Array<CustodianRequest & { status: string; to: unknown; decided_at: null }>;
  sessions: Array<SessionInfo & { origin?: string; expires_at?: string }>;
  history: HistoryItem[];
  challenges: Map<string, { channel: "email" | "phone"; value: string }>;
  takenIds: Set<string>;
}

function initialState(options: StateOptions): State {
  const emails: EmailView[] = [
    { email: "saketdev12@gmail.com", is_primary: true, verified_at: "2026-09-01T09:00:00.000Z", verified_via: "google" },
    { email: "cricketdrop6@gmail.com", is_primary: false, verified_at: "2026-09-14T17:22:00.000Z", verified_via: "code" },
    { email: "saket@teamofsilicons.com", is_primary: false, verified_at: "2026-09-20T08:02:00.000Z", verified_via: "code" },
  ];
  const phones: PhoneView[] = [{ phone: "+919876543210", is_primary: true, verified_at: "2026-09-02T08:10:00.000Z" }];
  const identities: IdentityView[] = [{ provider: "google", subject: "108233491177834234", email: "saketdev12@gmail.com", created_at: "2026-09-01T09:00:00.000Z", last_used_at: ago(26 * 60 * MINUTE) }];
  const silicons: ManagedSilicon[] = options.noSilicons ? [] : [
    { uuid: "Qz4", kind: "silicon", id: "si:scout", display_name: "Scout", pfp_url: portrait("Scout", 160), dob: "2026-09-03", timezone: "Asia/Kolkata", status: "active", created_at: "2026-09-03T10:00:00.000Z", updated_at: ago(300 * MINUTE), version: 3, custodian: SAKET, webhook_url: "https://scout.example/hooks/accounts", stk_rotated_at: ago(6 * DAY), pending_transfer: null },
    { uuid: "Lm8", kind: "silicon", id: "si:head_of_growth", display_name: "Head of Growth", pfp_url: portrait("Head of Growth", 32), dob: "2026-09-11", timezone: "Europe/London", status: "active", created_at: "2026-09-11T10:00:00.000Z", updated_at: ago(800 * MINUTE), version: 2, custodian: SAKET, webhook_url: null, stk_rotated_at: ago(20 * DAY), pending_transfer: { id: "0192a6f0-0000-7000-8000-0000000000aa", to: SHUBHAM, created_at: ago(20 * MINUTE), expires_at: at(14 * DAY - 20 * MINUTE) } },
    { uuid: "Tb2", kind: "silicon", id: "si:ledger", display_name: "Ledger", pfp_url: portrait("Ledger", 270), dob: "2026-10-01", timezone: "UTC", status: "active", created_at: "2026-10-01T10:00:00.000Z", updated_at: ago(1200 * MINUTE), version: 1, custodian: SAKET, webhook_url: null, stk_rotated_at: null, pending_transfer: null },
    ...(options.longSilicon ? [{ uuid: "Hq7", kind: "silicon", id: "si:head_of_growth_and_partnership", display_name: "Head of Growth and Partnerships", pfp_url: portrait("Head of Growth and Partnerships", 90), dob: "2026-10-02", timezone: "America/New_York", status: "active", created_at: "2026-10-02T10:00:00.000Z", updated_at: ago(600 * MINUTE), version: 1, custodian: SAKET, webhook_url: "https://growth.example/hooks/accounts", stk_rotated_at: null, pending_transfer: null } as ManagedSilicon] : []),
  ];
  const requests: State["requests"] = options.noRequests ? [] : [
    { id: "0192a6f0-0000-7000-8000-0000000000cc", kind: "initial", status: "pending", silicon: summary("Vx7", "silicon", "si:courier", "Courier", 120, "pending_custodian"), from: null, to: SAKET, created_at: ago(45 * MINUTE), expires_at: at(14 * DAY - 45 * MINUTE), decided_at: null },
    { id: "0192a6f0-0000-7000-8000-0000000000cd", kind: "transfer", status: "pending", silicon: summary("Kp5", "silicon", "si:atlas", "Atlas", 300), from: MIRA, to: SAKET, created_at: ago(3 * 60 * MINUTE), expires_at: at(14 * DAY - 3 * 60 * MINUTE), decided_at: null },
  ];
  const membership = (appId: string, status: MyApp["status"], scopes: MyApp["granted_scopes"], firstDays: number, lastMinutes: number | null, sessions: number): MyApp => ({
    app: appSummary(appId),
    membership_id: `${appId}:a8K`,
    status,
    granted_scopes: scopes,
    first_signed_in_at: status === "imported" ? null : ago(firstDays * DAY),
    last_signed_in_at: lastMinutes === null ? null : ago(lastMinutes * MINUTE),
    active_sessions: sessions,
    ...(status === "access_removed" ? { access_removed_at: ago(2 * DAY) } : {}),
    ...(status === "imported" ? { source: "import" } : { source: "signin" }),
  } as MyApp);
  const apps: MyApp[] = options.noApps ? [] : [
    membership("briefcase", "active", ["profile", "email", "timezone"], 30, 2, 2),
    membership("dm", "active", ["profile", "email"], 26, 40, 1),
    membership("commit", "active", ["profile", "email", "phone"], 19, 6 * 60, 1),
    membership("remind", "active", ["profile", "timezone"], 12, 26 * 60, 1),
    membership("interface", "active", ["profile", "email", "dob", "timezone"], 9, 3 * 24 * 60, 0),
    membership("waveform", "active", ["profile"], 6, 5 * 24 * 60, 0),
    membership("legacy-crm", "imported", ["profile"], 0, null, 0),
    membership("spacestation", "access_removed", ["profile", "email"], 40, 12 * 24 * 60, 0),
  ];
  const proof = (id: string, issuing: string, receiving: string, scopes: string[], status: string, created: number, tokenLeft: number | null, refreshed: number | null, revoked: number | null, reason: string | null) => ({
    proof_id: id,
    issuing_app: appSummary(issuing),
    receiving_app: appSummary(receiving),
    scopes,
    status,
    created_at: ago(created),
    expires_at: status === "expired" ? ago(created - 30 * MINUTE) : at(900 * DAY - created),
    token_expires_at: tokenLeft === null ? null : at(tokenLeft),
    last_refreshed_at: refreshed === null ? null : ago(refreshed),
    revoked_at: revoked === null ? null : ago(revoked),
    revoke_reason: reason,
  });
  const proofs: State["proofs"] = options.noProofs ? [] : [
    proof("0192a6f0-0000-7000-8000-0000000000f1", "dm", "briefcase", ["files.write"], "active", 30 * MINUTE, 17 * MINUTE, 13 * MINUTE, null, null),
    proof("0192a6f0-0000-7000-8000-0000000000f2", "commit", "remind", ["reminders.create", "reminders.read"], "active", 3 * 60 * MINUTE, 4 * MINUTE, 26 * MINUTE, null, null),
    proof("0192a6f0-0000-7000-8000-0000000000f3", "interface", "waveform", ["audio.render"], "revoked", 2 * DAY, -2 * DAY + 20 * MINUTE, null, 26 * 60 * MINUTE, "revoked_by_account"),
    proof("0192a6f0-0000-7000-8000-0000000000f4", "dm", "remind", ["reminders.create"], "expired", 4 * DAY, -4 * DAY + 30 * MINUTE, null, null, null),
  ];
  const sessions: State["sessions"] = [
    { id: "0192a6f0-4b1e-7c1d-9f00-3c1e0f0d1a2b", kind: "browser", label: "Chrome on macOS", origin: "browser", ip: "103.48.12.9", user_agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0", created_at: ago(3 * DAY), last_seen_at: ago(1 * MINUTE), expires_at: at(897 * DAY), current: true },
    { id: "0192a6f0-0000-7000-8000-000000000002", kind: "cli", label: "accounts CLI on build-box", origin: "device", ip: "103.48.12.11", user_agent: "silicon-accounts-cli/0.1.0 (linux)", created_at: ago(9 * DAY), last_seen_at: ago(5 * 60 * MINUTE), expires_at: at(891 * DAY), current: false },
    { id: "0192a6f0-0000-7000-8000-000000000003", kind: "browser", label: "Safari on iPhone", origin: "browser", ip: "49.36.170.4", user_agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Safari/604.1", created_at: ago(14 * DAY), last_seen_at: ago(2 * DAY), expires_at: at(886 * DAY), current: false },
  ];
  const item = (id: string, kind: HistoryItem["kind"], when: number, title: string, detail: string | null, appId: string | null, meta: Record<string, unknown> = {}): HistoryItem => ({ id, kind, at: ago(when), title, detail, app: appId ? appSummary(appId) : null, meta });
  const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
  const audit = (action: string, target: { kind: string; id: string }, details: Record<string, unknown>, actor: { kind: string; id: string | null } = { kind: "account", id: "a8K" }, ip: string | null = "103.48.12.9") =>
    ({ action, actor_kind: actor.kind, actor_id: actor.id, target_kind: target.kind, target_id: target.id, ip, details });
  // The shapes GET /v1/me/history really sends (crates/account/src/history.rs describe()), newest first.
  const history: HistoryItem[] = [
    item("signin:41", "signin", 2 * MINUTE, "Signed in to Briefcase with an email code", "from 103.48.12.9 · Chrome on macOS", "briefcase", { method: "email", outcome: "success", ip: "103.48.12.9", user_agent: CHROME }),
    item("proof:0192a6f0-0000-7000-8000-0000000000f1:issued", "proof", 30 * MINUTE, "DM got a proof to act for you at Briefcase", `Scopes: files.write · renewable until ${at(900 * DAY)}`, "dm", { proof_id: "0192a6f0-0000-7000-8000-0000000000f1", event: "issued", proof_kind: "obo", issuing_app: "dm", audiences: ["briefcase"], scopes: ["files.write"], revoked_by: null, reason: null }),
    item("audit:812", "custodian", 45 * MINUTE, "Silicon custodian requested", "By si:courier", null, audit("silicon.custodian.requested", { kind: "silicon", id: "Vx7" }, { id: "si:courier", request_id: "0192a6f0-0000-7000-8000-0000000000cc", kind: "initial" }, { kind: "account", id: "Vx7" }, null)),
    item("signin:40", "signin", 3 * 60 * MINUTE, "Signed in to Commit with Google", "from 103.48.12.9 · Chrome on macOS", "commit", { method: "google", outcome: "success", ip: "103.48.12.9", user_agent: CHROME }),
    item("audit:805", "custodian", 5 * 60 * MINUTE, "Silicon transfer requested", null, null, audit("silicon.transfer.requested", { kind: "silicon", id: "Lm8" }, { request_id: "0192a6f0-0000-7000-8000-0000000000aa", to: "Rw2" })),
    item("handle:3", "id_change", 26 * 60 * MINUTE, "Id changed from c:saketdev to c:saket", null, null, { old_id: "c:saketdev", new_id: "c:saket", changed_by: "a8K" }),
    item("audit:790", "security", 27 * 60 * MINUTE, "STK rotated", null, null, audit("silicon.stk.rotated", { kind: "silicon", id: "Qz4" }, { stk: "generated", revoked_token_families: 2, revoked_browser_sessions: 0 })),
    item("proof:0192a6f0-0000-7000-8000-0000000000f3:revoked", "proof", 26 * 60 * MINUTE + 10 * MINUTE, "Proof for Silicon Interface to act for you at Waveform revoked", "Revoked by you (revoked by account)", "interface", { proof_id: "0192a6f0-0000-7000-8000-0000000000f3", event: "revoked", proof_kind: "obo", issuing_app: "interface", audiences: ["waveform"], scopes: ["audio.render"], revoked_by: "a8K", reason: "revoked_by_account" }),
    item("audit:770", "app_access", 2 * DAY, "Removed Space Station's access", "Its sign-ins and the proofs it held for you were revoked", "spacestation", audit("membership.access_removed", { kind: "account", id: "a8K" }, { membership_id: "spacestation:a8K", revoked_sessions: 1, revoked_proofs: 0 })),
    item("signin:37", "signin", 2 * DAY + 3 * 60 * MINUTE, "Signed in to Remind with an email code", "from 49.36.170.4 · Safari on iOS", "remind", { method: "email", outcome: "success", ip: "49.36.170.4", user_agent: SAFARI }),
    item("audit:760", "security", 2 * DAY + 5 * 60 * MINUTE, "Profile updated", "Changed: display name, photo", null, audit("account.profile.updated", { kind: "account", id: "a8K" }, { changed: ["display_name", "pfp_url"] })),
    item("membership:legacy-crm:import", "app_access", 3 * DAY, "Legacy CRM imported your account from its existing records", null, "legacy-crm", { membership_id: "legacy-crm:a8K", source: "import" }),
    item("custodian:4", "custodian", 5 * DAY, "Created the Silicon si:ledger", null, null, { kind: "created_by_custodian", silicon: { uuid: "Tb2", kind: "silicon", id: "si:ledger", display_name: "Ledger", pfp_url: portrait("Ledger", 270), status: "active" }, from: null, to: SAKET, request_id: null }),
    item("audit:700", "security", 6 * DAY, "Email cricketdrop6@gmail.com added", null, null, audit("account.email.added", { kind: "account", id: "a8K" }, { email: "cricketdrop6@gmail.com", primary: false })),
    item("membership:interface:first", "app_access", 9 * DAY, "Started using Silicon Interface", null, "interface", { membership_id: "interface:a8K", source: "signin" }),
  ];
  const me: CarbonMe = {
    uuid: "a8K", kind: "carbon", id: options.longId ? "c:saket-dev-and-the-long-handles" : "c:saket", display_name: "Saket Dev", pfp_url: portrait("Saket Dev", 206), dob: "1998-03-14", timezone: "Asia/Kolkata",
    status: "active", created_at: "2026-09-01T09:00:00.000Z", updated_at: ago(90 * MINUTE), version: 7,
    emails, phones, identities, custodian_of: silicons.length,
  };
  return { me, apps, proofs, silicons, requests, sessions, history, challenges: new Map(), takenIds: new Set(["c:saket", "c:shubham", "c:mira", "si:scout", "si:atlas", "si:courier", "si:head_of_growth", "si:ledger", "c:admin"]) };
}

interface StateOptions {
  noSilicons?: boolean;
  noRequests?: boolean;
  noApps?: boolean;
  noProofs?: boolean;
  /** The signed-in Carbon has a 30-character handle (the longest an id can be). */
  longId?: boolean;
  /** Adds a Silicon whose si:id has a 30-character handle. */
  longSilicon?: boolean;
}

const lower = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");
const body = (request: MockRequest) => (request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {});

/** Every account endpoint the account pages call, answering from one state object. */
export function accountRoutes(options: StateOptions = {}): MockRoute[] {
  let state = initialState(options);
  const reset = () => { state = initialState(options); };
  const meReply = () => ({ json: state.me });
  const silicon = (uuid: string) => state.silicons.find(item => item.uuid === uuid || item.id === uuid);
  const notFound = (what: string) => fail(404, `${what}_not_found`, `No ${what.replace(/_/g, " ")} with that id belongs to this account.`, "Reload the page to see the current list.");
  const contactRoutes = (channel: "email" | "phone"): MockRoute[] => {
    const key = channel === "email" ? "emails" : "phones";
    const list = () => (channel === "email" ? state.me.emails : state.me.phones) as Array<EmailView | PhoneView>;
    const valueOf = (item: EmailView | PhoneView) => (channel === "email" ? (item as EmailView).email : (item as PhoneView).phone);
    const setList = (next: Array<EmailView | PhoneView>) => {
      if (channel === "email") state.me = { ...state.me, emails: next as EmailView[] };
      else state.me = { ...state.me, phones: next as PhoneView[] };
    };
    return [
      [`GET /v1/me/${key}`, () => page(list())],
      [`POST /v1/me/${key}`, request => {
        const value = channel === "email" ? lower(body(request).email) : String(body(request).phone ?? "").replace(/[^\d+]/g, "");
        if (!value) return fail(422, `invalid_${channel}`, `Enter a${channel === "email" ? "n email address" : " phone number"} to add.`);
        if (list().length >= 10) return fail(422, `${channel}_limit_reached`, `This account already has 10 ${key}, the most it can hold.`, `Remove one of your ${key} first.`);
        if (list().some(item => valueOf(item) === value)) return fail(409, `${channel}_already_added`, `${value} is already on your account.`, "Pick it in the list to make it primary.");
        if (value.startsWith("taken")) return fail(409, `${channel}_in_use`, `${value} belongs to another account, and an ${channel} can only belong to one account.`, "Sign in with it to use that account, or add a different one.");
        const id = `chal-${Math.random().toString(16).slice(2)}`;
        state.challenges.set(id, { channel, value });
        return { status: 201, json: { challenge_id: id, channel, destination: channel === "email" ? value.replace(/^(.).*(@.*)$/, "$1***$2") : `•••• ${value.slice(-4)}`, expires_at: at(10 * MINUTE), resend_available_at: at(30_000) } };
      }],
      [`POST /v1/me/${key}/verify`, request => {
        const input = body(request);
        const challenge = state.challenges.get(String(input.challenge_id));
        if (!challenge) return fail(404, "challenge_not_found", "That code request does not exist or was replaced by a newer one.", "Send a new code.");
        if (input.code !== "123456") return fail(422, "invalid_code", "That code is not right. 9 tries are left before a 1 minute pause.", "Check the latest message and type its 6 digits.", { remaining_attempts: 9 });
        const entry = channel === "email"
          ? { email: challenge.value, is_primary: list().length === 0, verified_at: at(0), verified_via: "code" as const }
          : { phone: challenge.value, is_primary: list().length === 0, verified_at: at(0) };
        setList([...list(), entry]);
        return page(list());
      }],
      [`POST /v1/me/${key}/:value/primary`, ({ params }) => {
        if (!list().some(item => valueOf(item) === params.value)) return notFound(channel);
        setList(list().map(item => ({ ...item, is_primary: valueOf(item) === params.value })).sort((a, b) => Number(b.is_primary) - Number(a.is_primary)));
        return page(list());
      }],
      [`DELETE /v1/me/${key}/:value`, ({ params }) => {
        const target = list().find(item => valueOf(item) === params.value);
        if (!target) return notFound(channel);
        if (target.is_primary) return fail(409, "cannot_remove_primary", `${params.value} is your primary ${channel}, so it cannot be removed.`, `Make another ${channel} primary first.`);
        setList(list().filter(item => item !== target));
        return page(list());
      }],
    ];
  };
  return [
    ["GET /v1/session", () => {
      reset();
      return { json: { account: SAKET, session: { id: state.sessions[0]?.id, created_at: ago(3 * DAY), expires_at: at(897 * DAY) } } };
    }],
    ["GET /v1/me", meReply],
    ["PATCH /v1/me", request => {
      const patch = body(request);
      if (typeof patch.display_name === "string" && !patch.display_name.trim()) return fail(422, "validation_failed", "display_name: enter 1 to 100 characters.", undefined, { fields: { display_name: "enter 1 to 100 characters" } });
      state.me = { ...state.me, ...patch, version: state.me.version + 1, updated_at: at(0) } as CarbonMe;
      return meReply();
    }],
    ["POST /v1/me/id", request => {
      const id = lower(body(request).id);
      if (state.takenIds.has(id) && id !== state.me.id) return fail(409, "id_taken", `${id} is taken by another account.`, "Pick one of the suggestions or another id.", { suggestions: [`${id}-2`, `${id}-dev`] });
      state.takenIds.add(id);
      state.me = { ...state.me, id, version: state.me.version + 1 };
      return meReply();
    }],
    ["POST /v1/me/photo", () => ({ status: 201, json: { pfp_url: portrait("Saket Dev", 150), photo: { id: "photo-1", content_type: "image/svg+xml", bytes: 2048, width: 96, height: 96 }, me: (state.me = { ...state.me, pfp_url: portrait("Saket Dev", 150) }) } })],
    ["DELETE /v1/me/photo", () => { state.me = { ...state.me, pfp_url: portrait("Saket Dev", 30) }; return meReply(); }],
    ["GET /v1/ids/available", ({ query }) => {
      const id = lower(query.get("id"));
      const handle = id.replace(/^(c|si):/, "");
      if (!/^(c|si):[a-z0-9_-]{3,30}$/.test(id)) return { json: { id, available: false, reason: "invalid", message: `${id} is not a valid id.`, reclaimable: false, suggestions: [] } };
      if (id === "c:saketdev") return { json: { id, available: true, reason: null, message: `${id} was your id; it is reserved for you until ${at(9 * DAY)} and you can take it back.`, reclaimable: true, suggestions: [] } };
      // A Silicon's old id, as the service reports it to the custodian (the reservation belongs to the Silicon).
      if (id === "si:scout-old") return { json: { id, available: false, reason: "reserved", message: `${id} was released recently and is reserved for its previous owner until ${at(9 * DAY)}.`, reclaimable: false, suggestions: [`${id}-2`, `${id}_hq`] } };
      if (handle === "admin") return { json: { id, available: false, reason: "reserved_word", message: `${id} uses a reserved word ("admin") that no account can have.`, reclaimable: false, suggestions: [] } };
      const taken = state.takenIds.has(id);
      return { json: { id, available: !taken, reason: taken ? "taken" : null, message: taken ? `${id} is taken by another account.` : `${id} is available.`, reclaimable: false, suggestions: taken ? [`${id}-2`, `${id}_hq`, `${id}-${new Date().getFullYear()}`] : [] } };
    }],
    ["GET /v1/accounts/:uuid", ({ params }) => {
      const known = [SAKET, SHUBHAM, MIRA, summary("Vx7", "silicon", "si:courier", "Courier", 120, "pending_custodian"), ...state.silicons.map(item => summary(item.uuid, "silicon", item.id ?? "", item.display_name, 160))];
      const found = known.find(item => item.uuid === params.uuid);
      return found ? { json: found } : fail(404, "account_not_found", `No account has the uuid '${params.uuid}'.`, "uuids are case-sensitive; check the value.");
    }],
    ...contactRoutes("email"),
    ...contactRoutes("phone"),
    ["GET /v1/me/identities", () => page(state.me.identities)],
    ["DELETE /v1/me/identities/:provider/:subject", ({ params }) => {
      state.me = { ...state.me, identities: state.me.identities.filter(item => !(item.provider === params.provider && item.subject === params.subject)) };
      return { status: 204 };
    }],
    ["GET /v1/me/apps", () => page(state.apps)],
    ["DELETE /v1/me/apps/:appId", ({ params }) => {
      const found = state.apps.find(item => item.app.app_id === params.appId);
      if (!found) return fail(404, "membership_not_found", `You have not signed into ${params.appId}.`, "Reload the page to see your apps.");
      state.apps = state.apps.map(item => (item === found ? { ...item, status: "access_removed", active_sessions: 0, access_removed_at: at(0) } as MyApp : item));
      return { status: 204, delay: 400 };
    }],
    ["GET /v1/me/sessions", () => page(state.sessions)],
    ["DELETE /v1/me/sessions/:id", ({ params }) => {
      state.sessions = state.sessions.filter(item => item.id !== params.id);
      return { status: 204, delay: 300 };
    }],
    ["GET /v1/me/history", ({ query }) => {
      const kind = query.get("kind");
      const limit = Number(query.get("limit") ?? 50);
      return page(state.history.filter(item => !kind || item.kind === kind).slice(0, limit));
    }],
    ["GET /v1/me/proofs", () => page(state.proofs)],
    ["DELETE /v1/me/proofs/:id", ({ params }) => {
      state.proofs = state.proofs.map(item => (item.proof_id === params.id ? { ...item, status: "revoked", revoked_at: at(0), revoke_reason: "revoked_by_account" } : item));
      return { status: 204, delay: 400 };
    }],
    ["GET /v1/me/silicons", () => page(state.silicons)],
    ["POST /v1/me/silicons", request => {
      const input = body(request);
      const id = lower(input.id);
      if (state.takenIds.has(id)) return fail(409, "id_taken", `${id} is taken by another account.`, "Pick another id.", { suggestions: [`${id}-2`] });
      const created: ManagedSilicon = { uuid: "Zq9", kind: "silicon", id, display_name: String(input.display_name ?? "New Silicon"), pfp_url: portrait(String(input.display_name ?? "S"), 190), dob: new Date().toISOString().slice(0, 10), timezone: String(input.timezone ?? "Asia/Kolkata"), status: "active", created_at: at(0), updated_at: at(0), version: 1, custodian: SAKET, webhook_url: (input.webhook_url as string) ?? null, stk_rotated_at: null, pending_transfer: null };
      state.silicons = [created, ...state.silicons];
      state.takenIds.add(id);
      state.me = { ...state.me, custodian_of: state.silicons.length };
      return { status: 201, delay: 500, json: { silicon: created, stk: input.stk ? null : "stk-7f3a9c41e2b8", webhook_secret: input.webhook_url ? "whsec_5n8KfQm2Rk7Yp1Lw3Xz6Tb9Vd4Hc0Gj" : null } };
    }],
    ["GET /v1/me/silicons/:uuid", ({ params }) => { const found = silicon(params.uuid ?? ""); return found ? { json: found } : notFound("silicon"); }],
    ["PATCH /v1/me/silicons/:uuid", request => {
      const found = silicon(request.params.uuid ?? "");
      if (!found) return notFound("silicon");
      const next = { ...found, ...body(request), version: found.version + 1 } as ManagedSilicon;
      state.silicons = state.silicons.map(item => (item === found ? next : item));
      return { json: next };
    }],
    ["POST /v1/me/silicons/:uuid/id", request => {
      const found = silicon(request.params.uuid ?? "");
      if (!found) return notFound("silicon");
      const id = lower(body(request).id);
      if (state.takenIds.has(id)) return fail(409, "id_taken", `${id} is taken by another account.`, "Pick another id.", { suggestions: [`${id}-2`] });
      if (id === "si:scout-old" && found.uuid !== "Qz4") return fail(409, "id_reserved", `${id} was released recently and is reserved for its previous owner until ${at(9 * DAY)}.`, "Pick another id, or wait until the reservation ends.", { reserved_until: at(9 * DAY) });
      const next = { ...found, id };
      state.silicons = state.silicons.map(item => (item === found ? next : item));
      return { json: next };
    }],
    ["PUT /v1/me/silicons/:uuid/webhook", request => {
      const found = silicon(request.params.uuid ?? "");
      if (!found) return notFound("silicon");
      const url = String(body(request).url ?? "");
      if (!/^https?:\/\//.test(url)) return fail(422, "validation_failed", "url: must be an https URL.", "Use the https address the Silicon listens on.", { fields: { url: "must be an https URL" } });
      state.silicons = state.silicons.map(item => (item === found ? { ...item, webhook_url: url } : item));
      return { json: { webhook_url: url, webhook_secret: "whsec_2Lq8Vn5Tc1Xr7Bk4Mz9Pw6Hd3Jf0Ys" } };
    }],
    ["DELETE /v1/me/silicons/:uuid/webhook", ({ params }) => {
      state.silicons = state.silicons.map(item => (item.uuid === params.uuid ? { ...item, webhook_url: null } : item));
      return { status: 204, delay: 300 };
    }],
    ["POST /v1/me/silicons/:uuid/stk", ({ params }) => {
      const found = silicon(params.uuid ?? "");
      if (!found) return notFound("silicon");
      const rotated = at(0);
      state.silicons = state.silicons.map(item => (item === found ? { ...item, stk_rotated_at: rotated } : item));
      return { delay: 400, json: { stk: "stk-c41d07e9b25a", rotated_at: rotated, revoked_sessions: 2 } };
    }],
    ["POST /v1/me/silicons/:uuid/transfer", request => {
      const found = silicon(request.params.uuid ?? "");
      if (!found) return notFound("silicon");
      const to = lower(body(request).to);
      if (to === "c:saket") return fail(422, "transfer_to_self", "You are already the custodian of this Silicon.", "Name another Carbon's c:id or email.");
      if (to.startsWith("c:") && !["c:shubham", "c:mira"].includes(to)) return fail(404, "custodian_not_found", `No active Carbon has the id ${to}.`, "Check the c:id, or name their email instead.");
      const recipient = to === "c:shubham" ? SHUBHAM : to === "c:mira" ? MIRA : { email: to };
      const transfer = { id: "0192a6f0-0000-7000-8000-0000000000ab", to: recipient, created_at: at(0), expires_at: at(14 * DAY) };
      state.silicons = state.silicons.map(item => (item === found ? { ...item, pending_transfer: transfer as ManagedSilicon["pending_transfer"] } : item));
      return { status: 201, delay: 500, json: { request: { ...transfer, kind: "transfer", status: "pending", silicon: found, from: SAKET, decided_at: null } } };
    }],
    ["DELETE /v1/me/silicons/:uuid/transfer", ({ params }) => {
      state.silicons = state.silicons.map(item => (item.uuid === params.uuid ? { ...item, pending_transfer: null } : item));
      return { status: 204, delay: 300 };
    }],
    ["DELETE /v1/me/silicons/:uuid", ({ params }) => {
      state.silicons = state.silicons.filter(item => item.uuid !== params.uuid);
      state.me = { ...state.me, custodian_of: state.silicons.length };
      return { status: 204, delay: 400 };
    }],
    ["GET /v1/me/custodian-requests", () => page(state.requests)],
    ["POST /v1/me/custodian-requests/:id/accept", ({ params }) => {
      const found = state.requests.find(item => item.id === params.id);
      if (!found) return fail(404, "custodian_request_not_found", "That request is not addressed to you, or it does not exist.", "Reload the page to see your requests.");
      state.requests = state.requests.filter(item => item !== found);
      state.silicons = [...state.silicons, { ...found.silicon, status: "active", dob: "2026-10-01", timezone: "UTC", created_at: found.created_at, updated_at: at(0), version: 2, custodian: SAKET, webhook_url: null, stk_rotated_at: null, pending_transfer: null } as ManagedSilicon];
      state.me = { ...state.me, custodian_of: state.silicons.length };
      return { status: 204, delay: 400 };
    }],
    ["POST /v1/me/custodian-requests/:id/decline", ({ params }) => {
      state.requests = state.requests.filter(item => item.id !== params.id);
      return { status: 204, delay: 400 };
    }],
    ["DELETE /v1/me", () => {
      if (state.silicons.length) return fail(409, "custodian_of_silicons", `You are the custodian of ${state.silicons.length} Silicons, and every Silicon must always have one.`, "Transfer each Silicon to another Carbon, or delete it, then delete your account.", { silicons: state.silicons.map(item => ({ uuid: item.uuid, kind: "silicon", id: item.id, display_name: item.display_name, pfp_url: item.pfp_url, status: item.status })) });
      return { status: 204 };
    }],
  ];
}

const settle = (page: Page, ms = 700) => page.waitForTimeout(ms);
/**
 * Back to the top before a full-page shot: a fixed element parked above the viewport (the skip link) would otherwise
 * be drawn into the page wherever the scroll position left it.
 */
const top = async (page: Page) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
};

export const screens: ScreenSpec[] = [
  { name: "account-landing", path: "/", as: "signed-out" },
  { name: "account-activity", path: "/activity", routes: accountRoutes() },
  {
    name: "account-activity-open",
    path: "/activity",
    routes: accountRoutes(),
    widths: [1440],
    prepare: async page => {
      await page.getByRole("button", { name: /Signed in to Briefcase/ }).click();
      await settle(page, 800);
      await top(page);
    },
  },
  {
    // Audit rows as the service sends them: labels in words, accounts by id (Rw2 is looked up as c:shubham).
    name: "account-activity-open-audit",
    path: "/activity",
    routes: accountRoutes(),
    widths: [1440, 390],
    prepare: async page => {
      await page.getByRole("button", { name: /Silicon transfer requested/ }).click();
      await settle(page, 500);
      await page.getByRole("button", { name: /STK rotated/ }).click();
      await settle(page, 900);
      await top(page);
    },
  },
  { name: "account-settings", path: "/settings", routes: accountRoutes() },
  { name: "account-settings-deletable", path: "/settings", routes: accountRoutes({ noSilicons: true }), widths: [1440] },
  { name: "account-silicons", path: "/silicons", routes: accountRoutes() },
  {
    name: "account-silicons-create",
    path: "/silicons",
    routes: accountRoutes(),
    fullPage: false,
    prepare: async page => {
      await page.getByRole("button", { name: "Create a Silicon" }).first().click();
      await settle(page, 600);
      await page.getByLabel("Display name").fill("Field Notes");
      await settle(page, 900);
    },
  },
  {
    name: "account-silicons-created",
    path: "/silicons",
    routes: accountRoutes(),
    prepare: async page => {
      await page.getByRole("button", { name: "Create a Silicon" }).first().click();
      await settle(page, 500);
      await page.getByLabel("Display name").fill("Field Notes");
      await page.getByLabel("Webhook URL (optional)").fill("https://notes.example/hooks/accounts");
      await settle(page, 700);
      await page.getByRole("button", { name: "Create Silicon" }).click();
      await settle(page, 2200);
      await top(page);
    },
  },
  {
    name: "account-silicons-drawer",
    path: "/silicons",
    routes: accountRoutes(),
    fullPage: false,
    prepare: async page => {
      await page.getByRole("button", { name: /^Manage si:scout/ }).click();
      await settle(page, 900);
    },
  },
  {
    name: "account-silicons-drawer-transfer",
    path: "/silicons",
    routes: accountRoutes(),
    fullPage: false,
    widths: [1440],
    prepare: async page => {
      await page.getByRole("button", { name: /^Manage si:head_of_growth/ }).click();
      await settle(page, 700);
      await page.getByRole("heading", { name: "Custodian" }).scrollIntoViewIfNeeded();
      await settle(page, 500);
    },
  },
  {
    // Taking back a Silicon's previous id: the service reports it "reserved" to the custodian; the drawer offers it.
    name: "account-silicons-drawer-reclaim",
    path: "/silicons",
    routes: accountRoutes(),
    fullPage: false,
    prepare: async page => {
      await page.getByRole("button", { name: /^Manage si:scout/ }).click();
      await settle(page, 700);
      await page.getByRole("button", { name: "Change its id" }).click();
      await settle(page, 400);
      await page.getByLabel("New id").fill("scout-old");
      await settle(page, 1000);
    },
  },
  {
    // A 30-character si:id on a phone: nothing in the drawer may scroll sideways.
    name: "account-silicons-drawer-long",
    path: "/silicons",
    routes: accountRoutes({ longSilicon: true }),
    fullPage: false,
    prepare: async page => {
      await page.getByRole("button", { name: /^Manage si:head_of_growth_and_partnership/ }).click();
      await settle(page, 900);
      const sideways = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[role=dialog] *")).filter(el => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible" && getComputedStyle(el).overflowX !== "clip" && getComputedStyle(el).overflowX !== "hidden").map(el => el.className));
      if (sideways.length) throw new Error(`The Silicon drawer scrolls sideways with a long si:id: ${sideways.join(", ")}`);
    },
  },
  { name: "account-silicons-empty", path: "/silicons", routes: accountRoutes({ noSilicons: true, noRequests: true }), widths: [1440] },
  { name: "account-apps", path: "/apps", routes: accountRoutes() },
  {
    name: "account-apps-remove",
    path: "/apps",
    routes: accountRoutes(),
    fullPage: false,
    widths: [1440],
    prepare: async page => {
      await page.getByRole("button", { name: "Remove access" }).first().click();
      await settle(page, 600);
    },
  },
  { name: "account-apps-empty", path: "/apps", routes: accountRoutes({ noApps: true }), widths: [1440] },
  // A stamp on the identity card opens its app's card: scrolled into view and marked for a moment.
  { name: "account-apps-linked", path: "/apps#app-remind", routes: accountRoutes(), widths: [1440], fullPage: false, scroll: false, settle: 1200 },
  { name: "account-proofs", path: "/proofs", routes: accountRoutes() },
  {
    name: "account-proofs-ended",
    path: "/proofs",
    routes: accountRoutes(),
    widths: [1440],
    prepare: async page => {
      await page.getByRole("button", { name: /^Ended/ }).click();
      await settle(page, 700);
      await top(page);
    },
  },
  { name: "account-sign-in-methods", path: "/sign-in-methods", routes: accountRoutes() },
  {
    name: "account-sign-in-methods-add",
    path: "/sign-in-methods",
    routes: accountRoutes(),
    prepare: async page => {
      await page.getByRole("button", { name: "Add an email" }).click();
      await page.getByLabel("Email address").fill("saket.dev@proton.me");
      await page.getByRole("button", { name: "Send code" }).click();
      await settle(page, 900);
      await top(page);
    },
  },
  {
    name: "account-sign-in-methods-added",
    path: "/sign-in-methods",
    routes: accountRoutes(),
    widths: [1440],
    prepare: async page => {
      await page.getByRole("button", { name: "Add an email" }).click();
      await page.getByLabel("Email address").fill("saket.dev@proton.me");
      await page.getByRole("button", { name: "Send code" }).click();
      await settle(page, 600);
      await page.getByLabel("Verification code, digit 1 of 6").pressSequentially("123456");
      await settle(page, 1200);
      await top(page);
    },
  },
  {
    name: "account-sign-in-methods-remove",
    path: "/sign-in-methods",
    routes: accountRoutes(),
    fullPage: false,
    prepare: async page => {
      await page.getByRole("button", { name: "Remove" }).nth(1).click();
      await settle(page, 600);
    },
  },
  { name: "account-identity", path: "/identity", routes: accountRoutes() },
  {
    // The longest id (30 characters after c:) gets the card's whole row and never runs under the uuid.
    name: "account-identity-long-id",
    path: "/identity",
    routes: accountRoutes({ longId: true }),
    fullPage: false,
    prepare: async page => {
      await settle(page, 600);
      const overlap = await page.evaluate(() => {
        const id = document.querySelector<HTMLElement>("[title^='c:saket-dev']");
        const uuid = Array.from(document.querySelectorAll<HTMLElement>("span")).find(el => el.textContent === "a8K");
        if (!id || !uuid) return "missing";
        const a = id.getBoundingClientRect();
        const b = uuid.getBoundingClientRect();
        return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom ? `id ${Math.round(a.left)}-${Math.round(a.right)} overlaps uuid ${Math.round(b.left)}-${Math.round(b.right)}` : "";
      });
      if (overlap) throw new Error(`Identity card: ${overlap}`);
    },
  },
  {
    name: "account-identity-photo",
    path: "/identity",
    routes: accountRoutes(),
    fullPage: false,
    widths: [1440],
    prepare: async page => {
      await page.getByRole("button", { name: "Change your photo" }).click();
      await settle(page, 500);
    },
  },
  {
    name: "account-identity-timezone",
    path: "/identity",
    routes: accountRoutes(),
    fullPage: false,
    widths: [1440],
    prepare: async page => {
      await page.getByRole("button", { name: "Change your timezone" }).click();
      await settle(page, 400);
      await page.getByRole("combobox", { name: "Timezone" }).fill("lon");
      await settle(page, 500);
    },
  },
  {
    name: "account-identity-dob",
    path: "/identity",
    routes: accountRoutes(),
    fullPage: false,
    widths: [1440],
    prepare: async page => {
      await page.getByRole("button", { name: "Details" }).click();
      await settle(page, 900);
      await page.getByRole("button", { name: "Change your date of birth" }).click();
      await settle(page, 400);
      await page.getByRole("button", { name: /Date of birth/ }).last().click();
      await settle(page, 600);
    },
  },
  {
    name: "account-identity-change-id",
    path: "/identity",
    routes: accountRoutes(),
    fullPage: false,
    prepare: async page => {
      await page.getByRole("button", { name: "Change id" }).click();
      await settle(page, 400);
      await page.getByLabel("New id").fill("scout");
      await settle(page, 900);
    },
  },
  {
    name: "account-identity-details",
    path: "/identity",
    routes: accountRoutes(),
    prepare: async page => {
      await page.getByRole("button", { name: "Details" }).click();
      await settle(page, 1000);
      await top(page);
    },
  },
];
