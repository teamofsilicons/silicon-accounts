/**
 * What an opened Activity row shows: the `meta` of a `GET /v1/me/history` item turned into readable label and value
 * pairs. The service sends a different meta per source (crates/account/src/history.rs `describe()`):
 *
 * | item id         | meta                                                                         |
 * |-----------------|------------------------------------------------------------------------------|
 * | `signin:…`      | `{method, outcome, ip, user_agent}`                                          |
 * | `handle:…`      | `{old_id, new_id, changed_by}` (an account uuid, `import` or `system`)       |
 * | `custodian:…`   | `{kind, silicon, from, to, request_id}` (AccountSummary, or `{uuid}`)        |
 * | `proof:…`       | `{proof_id, event, proof_kind, issuing_app, audiences, scopes, revoked_by, reason}` |
 * | `membership:…`  | `{membership_id, source}`                                                    |
 * | `audit:…`       | `{action, actor_kind, actor_id, target_kind, target_id, ip, details}`        |
 *
 * Internal codes (`action`, `*_kind`, request and session ids) are not shown. Accounts are shown by their c:id or si:id,
 * never by uuid: the custodian's own Silicons are known already, and anyone else is looked up when the row opens.
 * Enum values are said in words; `details` is flattened one level with a label per key.
 */
import { createEffect, createSignal, on, type JSX } from "solid-js";
import { api, ApiError, type AccountKind, type HistoryItem } from "../../../api";
import { formatPhone } from "../../../lib/format";

export interface DetailRow {
  label: string;
  value: () => JSX.Element;
}

export interface DetailContext {
  /** The signed-in account. */
  me: { uuid: string; id: string | null; kind: AccountKind } | undefined;
  /** The si:id of a Silicon in the signed-in Carbon's care, by uuid (no request needed). */
  siliconId: (uuid: string) => string | null | undefined;
}

type Meta = Record<string, unknown>;

const text = (value: string) => () => <>{value}</>;
const mono = (value: string) => () => <span class="mono">{value}</span>;
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item) : []);
const inWords = (code: string) => code.replace(/[._]+/g, " ").trim().replace(/^./, char => char.toUpperCase());

/** The sign-in method codes of signin_history and audit details. */
const METHODS: Record<string, string> = {
  email: "Email code",
  phone: "Phone code",
  google: "Google",
  apple: "Apple",
  silicon_stk: "si:id and STK",
  slt: "Short-lived token from the accounts CLI",
  device: "accounts CLI (device code)",
  session: "This site's session",
};

const OUTCOMES: Record<string, string> = {
  success: "Signed in",
  new_account: "Signed up: a new account was made",
  failed: "Failed",
};

const CUSTODY: Record<string, string> = {
  created_by_custodian: "Created by its custodian",
  initial_accepted: "Custodian request accepted",
  transfer: "Transferred to a new custodian",
};

const MEMBERSHIP_SOURCES: Record<string, string> = {
  signin: "Signed in to it",
  import: "The app imported the account",
  first_party: "Silicon Accounts itself",
};

/** Why something was closed or revoked (audit `details.reason`). */
const REASONS: Record<string, string> = {
  custodian_account_deleted: "The named custodian deleted their account",
  account_deleted: "The account was deleted",
  access_removed: "The app's access was removed",
  stk_rotated: "The STK was rotated",
  app_revoked: "The app signed it out",
};

/** Why a proof about you ended (the proofs crate's `revoke_reason`), as the Proofs page says it. */
function proofReason(reason: string, issuing: string): string {
  switch (reason) {
    case "revoked_by_account": return "You revoked it";
    case "revoked_by_app": return `${issuing} revoked it`;
    case "revoked_by_owner": return `${issuing}'s owner revoked it`;
    case "refresh_token_reuse": return "Its refresh token was used twice, which can mean it leaked";
    case "sign_in_revoked": return `Your sign-in at ${issuing} ended`;
    case "access_removed":
    case "membership_inactive": return `${issuing}'s access was removed`;
    case "account_deleted":
    case "account_inactive": return "The account was deleted";
    default: return inWords(reason);
  }
}

/** Words for the codes found in audit `details`, per key. */
const VALUES: Record<string, Record<string, string>> = {
  kind: { browser: "Browser", cli: "Terminal (accounts CLI)", initial: "A Silicon asking for a custodian", transfer: "A transfer between custodians", email: "Email", phone: "Phone number" },
  by: { custodian: "Its custodian", silicon: "The Silicon itself" },
  stk: { generated: "Generated and shown once", chosen: "Chosen by hand" },
  via: { requirement: "While signing in to an app that needs it", code: "With a code", google: "Google", apple: "Apple" },
  linked_by: { verified_email: "Its verified email matches this account" },
  token_type: { refresh_token: "Refresh token", access_token: "Access token" },
  provider: { google: "Google", apple: "Apple" },
};

/** Labels for audit `details` keys; anything not listed is labelled from its key. */
const LABELS: Record<string, string> = {
  changed: "Changed",
  email: "Email",
  phone: "Phone number",
  primary: "Made primary",
  provider: "Provider",
  kind: "Type",
  content_type: "Format",
  bytes: "File size",
  deleted_photos: "Old photos deleted",
  membership_id: "Membership",
  revoked_sessions: "Sessions ended",
  revoked_proofs: "Proofs revoked",
  revoked_token_families: "Sign-ins ended",
  revoked_families: "Sign-ins ended",
  revoked_browser_sessions: "Browser sessions ended",
  url_origin: "Webhook host",
  by: "Set by",
  stk: "New STK",
  id: "Id",
  old_id: "Old id",
  new_id: "New id",
  silicon_id: "Silicon",
  custodian_id: "Custodian",
  released_id: "Id released",
  custodian: "Custodian named",
  from: "From",
  to: "To",
  reason: "Why",
  method: "How",
  app_id: "App",
  via: "Added",
  label: "Name",
  linked_by: "Linked",
  token_type: "Token",
  webhook: "Webhook set",
  reclaimed: "A previous id taken back",
  scopes: "Scopes",
  audiences: "Apps it acts at",
};

/** Internal references with no meaning on this page. */
const HIDDEN = new Set(["subject", "session_id", "photo_id", "request_id", "challenge_id", "family_id", "delivery_id", "event_id", "width", "height"]);

/** The fields of a profile change, as the service's history titles name them. */
const FIELD_NAMES: Record<string, string> = { display_name: "display name", pfp_url: "photo", dob: "date of birth", timezone: "timezone" };

const isAccountId = (value: string) => /^(c|si):[a-z0-9_-]{3,30}$/.test(value);
const isContact = (value: string) => value.includes("@") || /^\+[\d*]{6,}$/.test(value);

/* --------------------------------------------- accounts by uuid --------------------------------------------- */

const lookups = new Map<string, Promise<{ label: string; id: boolean }>>();

/** An account's current id (or why there is none), looked up once per page load. */
function lookupAccount(uuid: string): Promise<{ label: string; id: boolean }> {
  let found = lookups.get(uuid);
  if (!found) {
    found = api.accounts.get(uuid).then(
      account => (account.id ? { label: account.id, id: true } : { label: `${account.display_name} (no id)`, id: false }),
      error => {
        if (ApiError.is(error, "account_deleted")) return { label: "An account that was deleted", id: false };
        if (ApiError.is(error, "account_not_found")) return { label: "An account that no longer exists", id: false };
        lookups.delete(uuid);
        return { label: "Another account (it could not be looked up just now)", id: false };
      },
    );
    lookups.set(uuid, found);
  }
  return found;
}

/** Shows an account by its id, looking it up when the row opens. */
function AccountRef(props: { uuid: string }) {
  const [shown, setShown] = createSignal<{ label: string; id: boolean } | null>(null);
  createEffect(on(() => props.uuid, uuid => {
    setShown(null);
    void lookupAccount(uuid).then(result => { if (props.uuid === uuid) setShown(result); });
  }));
  return (
    <span aria-busy={shown() ? undefined : true}>
      {shown() ? (shown()!.id ? <span class="mono">{shown()!.label}</span> : shown()!.label) : "Looking it up…"}
    </span>
  );
}

/**
 * Who did something when it was not an account: the markers the service writes instead of a uuid (handle_history
 * `changed_by`, audit actors). They are never looked up.
 */
const MARKERS: Record<string, string> = {
  signup: "You, when you signed up",
  self: "The Silicon itself, when it made its account",
  import: "An app's import of its existing accounts",
  system: "Silicon Accounts",
  silicon_apps: "Silicon Apps",
};

/** An account given as a uuid (or a marker such as `system`), in words. */
function accountValue(uuid: string, ctx: DetailContext): () => JSX.Element {
  if (ctx.me && uuid === ctx.me.uuid) return text(ctx.me.id ? `You (${ctx.me.id})` : "You");
  const marker = MARKERS[uuid];
  if (marker) return text(marker);
  // Account uuids are 3 to 12 letters and digits; anything else is a marker this page does not know yet.
  if (!/^[A-Za-z0-9]{3,12}$/.test(uuid)) return text(inWords(uuid));
  const known = ctx.siliconId(uuid);
  if (known) return mono(known);
  return () => <AccountRef uuid={uuid} />;
}

/** An AccountSummary (or `{uuid}`) from custodian rows. */
function summaryValue(value: unknown, ctx: DetailContext): (() => JSX.Element) | null {
  if (!value || typeof value !== "object") return null;
  const summary = value as { uuid?: unknown; id?: unknown; display_name?: unknown };
  const uuid = str(summary.uuid);
  if (uuid && ctx.me && uuid === ctx.me.uuid) return text(ctx.me.id ? `You (${ctx.me.id})` : "You");
  const id = str(summary.id);
  if (id) return mono(id);
  if (uuid) return accountValue(uuid, ctx);
  const name = str(summary.display_name);
  return name ? text(name) : null;
}

/* ------------------------------------------------- per source ------------------------------------------------- */

function signinRows(meta: Meta): DetailRow[] {
  const rows: DetailRow[] = [];
  const method = str(meta.method);
  if (method) rows.push({ label: "How", value: text(METHODS[method] ?? inWords(method)) });
  const outcome = str(meta.outcome);
  if (outcome) rows.push({ label: "Result", value: text(OUTCOMES[outcome] ?? inWords(outcome)) });
  const ip = str(meta.ip);
  if (ip) rows.push({ label: "IP address", value: mono(ip) });
  const agent = str(meta.user_agent);
  if (agent) rows.push({ label: "Browser or app", value: text(agent) });
  return rows;
}

function handleRows(meta: Meta, ctx: DetailContext): DetailRow[] {
  const rows: DetailRow[] = [];
  const old = str(meta.old_id);
  const next = str(meta.new_id);
  if (old) rows.push({ label: next ? "Old id" : "Id released", value: mono(old) });
  if (next) rows.push({ label: old ? "New id" : "First id", value: mono(next) });
  const by = str(meta.changed_by);
  if (by) rows.push({ label: "Done by", value: accountValue(by, ctx) });
  return rows;
}

function custodianRows(meta: Meta, ctx: DetailContext): DetailRow[] {
  const rows: DetailRow[] = [];
  const kind = str(meta.kind);
  if (kind) rows.push({ label: "What happened", value: text(CUSTODY[kind] ?? inWords(kind)) });
  const silicon = summaryValue(meta.silicon, ctx);
  if (silicon) rows.push({ label: "Silicon", value: silicon });
  const from = summaryValue(meta.from, ctx);
  if (from) rows.push({ label: "From", value: from });
  const to = summaryValue(meta.to, ctx);
  if (to) rows.push({ label: "To", value: to });
  return rows;
}

/** Who revoked a proof is in the row's own text ("Revoked by you", "by c:saket", "by Briefcase"); the rows add why. */
function proofRows(item: HistoryItem, meta: Meta): DetailRow[] {
  const rows: DetailRow[] = [];
  const issuing = str(meta.issuing_app);
  if (issuing) rows.push({ label: "Held by", value: text(item.app?.app_id === issuing ? item.app.name : issuing) });
  const audiences = list(meta.audiences);
  if (audiences.length) rows.push({ label: "Lets it act at", value: mono(audiences.join(", ")) });
  const scopes = list(meta.scopes);
  rows.push({ label: "Scopes", value: scopes.length ? mono(scopes.join(", ")) : text("None") });
  if (str(meta.event) === "revoked") {
    const reason = str(meta.reason);
    if (reason) rows.push({ label: "Why it ended", value: text(proofReason(reason, item.app?.name ?? issuing ?? "The app")) });
  }
  const id = str(meta.proof_id);
  if (id) rows.push({ label: "Proof id", value: mono(id) });
  return rows;
}

function membershipRows(meta: Meta): DetailRow[] {
  const rows: DetailRow[] = [];
  const source = str(meta.source);
  if (source) rows.push({ label: "How", value: text(MEMBERSHIP_SOURCES[source] ?? inWords(source)) });
  const membership = str(meta.membership_id);
  if (membership) rows.push({ label: "The app knows it as", value: mono(membership) });
  return rows;
}

/** One `details` entry of an audit row, in words; null to leave it out. */
function detailValue(key: string, raw: unknown, item: HistoryItem, ctx: DetailContext): (() => JSX.Element) | null {
  if (HIDDEN.has(key) || raw === null || raw === undefined || raw === "") return null;
  if (key === "changed") {
    const fields = list(raw).map(field => FIELD_NAMES[field] ?? field.replace(/_/g, " "));
    return fields.length ? text(fields.join(", ")) : null;
  }
  if (key === "method" && typeof raw === "string") return text(METHODS[raw] ?? inWords(raw));
  if (key === "reason" && typeof raw === "string") return text(REASONS[raw] ?? inWords(raw));
  if (key === "app_id" && typeof raw === "string") return text(item.app?.app_id === raw ? item.app.name : raw);
  if (key === "content_type" && typeof raw === "string") return text(raw.replace(/^image\//, "").toUpperCase());
  if (key === "bytes") {
    const bytes = num(raw);
    return bytes === null ? null : text(bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
  }
  if (key === "phone" && typeof raw === "string") return mono(raw.includes("*") ? raw : formatPhone(raw));
  if ((key === "from" || key === "to") && typeof raw === "string") {
    return isAccountId(raw) || isContact(raw) ? mono(raw) : accountValue(raw, ctx);
  }
  const words = VALUES[key];
  if (typeof raw === "string") {
    if (words?.[raw]) return text(words[raw]!);
    return isAccountId(raw) || isContact(raw) || key.endsWith("_id") || key === "id" || key === "url_origin" || key === "membership_id" ? mono(raw) : text(raw);
  }
  // A count of things ended or deleted says nothing when it is zero.
  if (typeof raw === "number") return raw === 0 && /^(revoked|deleted)_/.test(key) ? null : text(String(raw));
  if (typeof raw === "boolean") return text(raw ? "Yes" : "No");
  const values = Array.isArray(raw) ? raw.filter(value => typeof value === "string" || typeof value === "number") : [];
  return values.length ? text(values.join(", ")) : null;
}

function auditRows(item: HistoryItem, meta: Meta, ctx: DetailContext): DetailRow[] {
  const rows: DetailRow[] = [];
  const actorKind = str(meta.actor_kind);
  const actor = str(meta.actor_id);
  if (actorKind === "account" && actor) rows.push({ label: "Done by", value: accountValue(actor, ctx) });
  else if (actorKind === "app" && actor) rows.push({ label: "Done by", value: text(item.app?.app_id === actor ? item.app.name : actor) });
  else if (actorKind === "system") rows.push({ label: "Done by", value: text("Silicon Accounts") });
  const target = str(meta.target_id);
  if (str(meta.target_kind) === "silicon" && target && !(ctx.me && target === ctx.me.uuid)) rows.push({ label: "Silicon", value: accountValue(target, ctx) });
  const ip = str(meta.ip);
  if (ip) rows.push({ label: "IP address", value: mono(ip) });
  const details = meta.details && typeof meta.details === "object" && !Array.isArray(meta.details) ? (meta.details as Meta) : {};
  for (const [key, raw] of Object.entries(details)) {
    const value = detailValue(key, raw, item, ctx);
    if (value) rows.push({ label: LABELS[key] ?? inWords(key), value });
  }
  return rows;
}

/** Older or unknown shapes: every plain value with its key made readable. */
function fallbackRows(item: HistoryItem, meta: Meta, ctx: DetailContext): DetailRow[] {
  const rows: DetailRow[] = [];
  for (const [key, raw] of Object.entries(meta)) {
    const value = detailValue(key, raw, item, ctx);
    if (value) rows.push({ label: LABELS[key] ?? inWords(key), value });
  }
  return rows;
}

/** The rows an opened Activity entry shows (at most 10). */
export function historyDetails(item: HistoryItem, ctx: DetailContext): DetailRow[] {
  const meta: Meta = item.meta && typeof item.meta === "object" ? item.meta : {};
  const source = item.id.split(":")[0];
  let rows: DetailRow[];
  switch (source) {
    case "signin": rows = signinRows(meta); break;
    case "handle": rows = handleRows(meta, ctx); break;
    case "custodian": rows = custodianRows(meta, ctx); break;
    case "proof": rows = proofRows(item, meta); break;
    case "membership": rows = membershipRows(meta); break;
    case "audit": rows = auditRows(item, meta, ctx); break;
    default: rows = "action" in meta ? auditRows(item, meta, ctx) : fallbackRows(item, meta, ctx);
  }
  return rows.slice(0, 10);
}

/**
 * Which Silicon a row is about, when the collapsed row would not say (the service titles audit rows like "STK rotated"
 * without naming the Silicon). Only ids known without a request: the Carbon's own Silicons, or one in the details.
 */
export function siliconOf(item: HistoryItem, ctx: DetailContext): string | null {
  const meta: Meta = item.meta && typeof item.meta === "object" ? item.meta : {};
  if (str(meta.target_kind) !== "silicon") return null;
  const target = str(meta.target_id);
  if (!target || (ctx.me && target === ctx.me.uuid)) return null;
  const details = meta.details && typeof meta.details === "object" ? (meta.details as Meta) : {};
  const id = ctx.siliconId(target) ?? str(details.silicon_id) ?? str(details.id);
  return id && !item.title.includes(id) && !(item.detail ?? "").includes(id) ? id : null;
}
