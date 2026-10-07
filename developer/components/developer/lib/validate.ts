/**
 * Client-side mirrors of the server's sign-in setup, webhook and proof checks (crates/core models/signin_config.rs and
 * normalize.rs, crates/proofs). They give instant, precise feedback; the server stays the authority and its 422
 * `details.fields` show the same way. Messages say what is wrong and how to fix it.
 */
import type { Branding, ContactField, SigninCopy } from "@/lib/api/types";
import { brandingContrastIssues } from "@/lib/branding/contrast";
import { LIMITS } from "@/lib/branding/defaults";
import { FLOW_LAYOUTS, MAX_FLOW_STEPS, requestedFields, type EditableConfig } from "./config";

export const MAX_REDIRECT_URIS = 50;
export const MAX_ALLOWED_ORIGINS = 50;
export const MAX_EMAIL_DOMAINS = 100;
export const MAX_INLINE_LOGO_BYTES = 128 * 1024;
export const GOOGLE_PROMPTS = ["select_account", "consent", "none", "consent select_account", "select_account consent"] as const;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const UNUSABLE_SCHEMES = new Set(["javascript", "data", "file", "vbscript", "blob", "about", "ftp", "ws", "wss"]);

function parse(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** A registered redirect URI: https; http only on localhost/127.0.0.1/[::1]; or a reverse-domain scheme. No fragment. */
export function redirectUriProblem(raw: string): string | null {
  const uri = raw.trim();
  if (!uri) return "Enter a URL like https://app.example.com/auth/callback.";
  if (uri.length > 2048) return "A redirect URI can be at most 2048 characters.";
  const url = parse(uri);
  if (!url) return `'${uri}' is not an absolute URL like https://app.example.com/auth/callback.`;
  if (uri.includes("#")) return `'${uri}' must not contain a #fragment; the code and state are added as query parameters.`;
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme === "https") {
    if (!url.hostname) return `'${uri}' has no host.`;
  } else if (scheme === "http") {
    if (!LOOPBACK.has(url.hostname)) return `'${uri}' uses http; only https is allowed, except http://localhost and http://127.0.0.1 for local development.`;
  } else if (UNUSABLE_SCHEMES.has(scheme)) {
    return `'${uri}' uses the ${scheme} scheme, which can't receive a sign-in result.`;
  } else if (!scheme.includes(".")) {
    return `'${uri}' uses the '${scheme}' scheme; use https, or a reverse-domain scheme like com.example.app:/callback for native apps.`;
  }
  if (url.username || url.password) return `'${uri}' must not contain credentials.`;
  return null;
}

/** Normalizes an origin the way the server does before comparing: trimmed, without a trailing slash. */
export function normalizeOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** An allowed origin: scheme://host[:port], https (http only on localhost), no path. */
export function originProblem(raw: string): string | null {
  const origin = normalizeOrigin(raw);
  if (!origin) return "Enter an origin like https://app.example.com.";
  const url = parse(origin);
  if (!url) return `'${origin}' is not an origin like https://app.example.com.`;
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) return `'${origin}' must be just scheme://host[:port], without a path; try ${url.origin}.`;
  const scheme = url.protocol.replace(/:$/, "");
  if (scheme === "https") return null;
  if (scheme === "http") return LOOPBACK.has(url.hostname) ? null : `'${origin}' uses http; only https is allowed (http only for localhost and 127.0.0.1).`;
  return `'${origin}' uses the '${scheme}' scheme; origins must be https.`;
}

/** Normalizes an email domain the way the server does: trimmed, lowercase, without a leading @. */
export function normalizeDomain(raw: string): string {
  return raw.trim().replace(/^@+/, "").toLowerCase();
}

export function isValidDomain(domain: string): boolean {
  if (!domain || domain.length > 253 || !domain.includes(".")) return false;
  return domain.split(".").every(label => label.length > 0 && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-") && /^[a-z0-9-]+$/.test(label));
}

export function domainProblem(raw: string): string | null {
  const domain = normalizeDomain(raw);
  if (!domain) return "Enter a domain like example.com.";
  if (domain.includes("@")) return `'${raw.trim()}' looks like an email address; enter only the part after the @, like example.com.`;
  return isValidDomain(domain) ? null : `'${domain}' is not a domain name like example.com.`;
}

/** https only, with a host and no credentials (terms, privacy, background image). */
export function httpsUrlProblem(raw: string, example = "https://example.com/terms"): string | null {
  const value = raw.trim();
  if (value.length > 2048) return "The URL is longer than 2048 characters.";
  const url = parse(value);
  if (!url) return `'${value}' is not an absolute URL like ${example}.`;
  if (url.protocol !== "https:") return `'${value}' must use https.`;
  if (!url.hostname) return `'${value}' has no host.`;
  if (url.username || url.password) return `'${value}' must not contain credentials.`;
  return null;
}

/** Logo: https, or an inline data:image (png, jpeg, webp, gif, svg+xml) of at most 128 KB. */
export function logoUrlProblem(raw: string): string | null {
  const value = raw.trim();
  if (value.startsWith("data:")) {
    if (!/^data:image\/(png|jpeg|webp|gif|svg\+xml)[;,]/.test(value)) return "Inline logos must be data:image/png, jpeg, webp, gif or svg+xml.";
    if (value.length > MAX_INLINE_LOGO_BYTES) return `This inline logo is ${Math.ceil(value.length / 1024)} KB; inline logos can be at most 128 KB. Host the logo and use an https URL.`;
    return null;
  }
  return httpsUrlProblem(value, "https://example.com/logo.svg");
}

/** A plausible email address (the server normalizes and checks it fully). */
export function emailProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.length > 254) return "An email address can be at most 254 characters.";
  if (/[^\x21-\x7e]/.test(value)) return `'${value}' contains spaces or non-ASCII characters.`;
  if ((value.match(/@/g) ?? []).length !== 1) return `'${value}' needs exactly one @, like support@example.com.`;
  const [local, domain = ""] = value.split("@");
  if (!local) return `'${value}' has nothing before the @.`;
  if (!isValidDomain(domain.toLowerCase())) return `'${domain}' after the @ is not a domain like example.com.`;
  return null;
}

/** Apple Team ID and Key ID: exactly 10 letters or digits. */
export function appleIdProblem(raw: string, what: "Team ID" | "Key ID"): string | null {
  const value = raw.trim();
  if (!value) return `Enter your Apple ${what} (10 letters or digits, from your Apple developer account).`;
  return /^[A-Za-z0-9]{10}$/.test(value) ? null : `'${value}' must be exactly 10 letters or digits; copy the ${what} from your Apple developer account.`;
}

/** A Google client secret: visible ASCII without spaces, at most 512 characters. */
export function googleSecretProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.length > 512) return "This is longer than 512 characters, which no Google client secret is.";
  return /^[\x21-\x7e]+$/.test(value) ? null : "Use the client secret exactly as Google shows it: visible characters, no spaces.";
}

/** An Apple .p8 key in PEM form (the server also checks it parses as an EC P-256 key). */
export function applePrivateKeyProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const pem = !value.includes("\n") && value.includes("\\n") ? value.replace(/\\n/g, "\n") : value;
  if (!pem.startsWith("-----BEGIN PRIVATE KEY-----")) return "Paste the .p8 key from Apple in PEM form, starting with -----BEGIN PRIVATE KEY-----.";
  if (!pem.includes("-----END PRIVATE KEY-----")) return "The key is cut off: it must end with -----END PRIVATE KEY-----.";
  if (pem.length > 4096) return "This is longer than 4096 characters, which no Apple .p8 key is.";
  return null;
}

export interface SecretsCheck {
  googleSecret: string;
  googleSecretStored: boolean;
  googleRemove: boolean;
  appleKey: string;
  appleKeyStored: boolean;
  appleRemove: boolean;
}

/** Every problem in the sign-in part of a draft, keyed by the server's field paths. */
export function signinProblems(config: EditableConfig, secrets: SecretsCheck): Record<string, string> {
  const out: Record<string, string> = {};
  const methods = config.methods;
  if (!methods.email && !methods.phone && !methods.google && !methods.apple) out.methods = "Turn on at least one sign-in method: email, phone, Google or Apple.";

  const google = config.google;
  if (google.prompt && !(GOOGLE_PROMPTS as readonly string[]).includes(google.prompt)) out["google.prompt"] = "Choose select_account, consent, none or \"consent select_account\".";
  if (google.hosted_domain && !isValidDomain(google.hosted_domain.trim().toLowerCase())) out["google.hosted_domain"] = `'${google.hosted_domain.trim()}' is not a Google Workspace domain like example.com.`;
  if (google.mode === "byo") {
    if (!google.client_id?.trim()) out["google.client_id"] = "Paste your Google OAuth client ID (it ends in .apps.googleusercontent.com).";
    else if (google.client_id.trim().length > 255) out["google.client_id"] = "A client ID can be at most 255 characters.";
    const secretProblem = googleSecretProblem(secrets.googleSecret);
    if (secretProblem) out["google.client_secret"] = secretProblem;
    else if (!secrets.googleSecret.trim() && (!secrets.googleSecretStored || secrets.googleRemove)) out["google.client_secret"] = "Paste the client secret of your Google OAuth client; bring-your-own Google needs both the ID and the secret.";
  }

  const apple = config.apple;
  if (apple.mode === "byo") {
    if (!apple.services_id?.trim()) out["apple.services_id"] = "Enter your Services ID, for example com.example.signin.";
    else if (apple.services_id.trim().length > 255) out["apple.services_id"] = "A Services ID can be at most 255 characters.";
    const team = appleIdProblem(apple.team_id ?? "", "Team ID");
    if (team) out["apple.team_id"] = team;
    const key = appleIdProblem(apple.key_id ?? "", "Key ID");
    if (key) out["apple.key_id"] = key;
    const pem = applePrivateKeyProblem(secrets.appleKey);
    if (pem) out["apple.private_key"] = pem;
    else if (!secrets.appleKey.trim() && (!secrets.appleKeyStored || secrets.appleRemove)) out["apple.private_key"] = "Paste the .p8 key you downloaded from Apple; bring-your-own Apple needs it to sign in.";
  }

  if (config.redirect_uris.length > MAX_REDIRECT_URIS) out.redirect_uris = `At most ${MAX_REDIRECT_URIS} redirect URIs are allowed; this list has ${config.redirect_uris.length}.`;
  config.redirect_uris.forEach((uri, index) => {
    const problem = redirectUriProblem(uri);
    if (problem) out[`redirect_uris[${index}]`] = problem;
  });
  if (config.allowed_origins.length > MAX_ALLOWED_ORIGINS) out.allowed_origins = `At most ${MAX_ALLOWED_ORIGINS} origins are allowed; this list has ${config.allowed_origins.length}.`;
  config.allowed_origins.forEach((origin, index) => {
    const problem = originProblem(origin);
    if (problem) out[`allowed_origins[${index}]`] = problem;
  });
  if (config.allowed_email_domains.length > MAX_EMAIL_DOMAINS) out.allowed_email_domains = `At most ${MAX_EMAIL_DOMAINS} domains are allowed; this list has ${config.allowed_email_domains.length}.`;
  config.allowed_email_domains.forEach((domain, index) => {
    const problem = domainProblem(domain);
    if (problem) out[`allowed_email_domains[${index}]`] = problem;
  });
  return out;
}

/** A short plain text (a title, a subtitle, a button label): at most `max` characters, no control characters. */
export function plainTextProblem(raw: string | null | undefined, what: string, max: number): string | null {
  const text = raw?.trim() ?? "";
  if (/[\u0000-\u001f\u007f]/.test(text)) return `The ${what} must not contain line breaks or other control characters.`;
  const length = [...text].length;
  return length > max ? `The ${what} is ${length} characters; keep it to ${max}.` : null;
}

export function copyProblems(copy: SigninCopy): Record<string, string> {
  const out: Record<string, string> = {};
  const texts: Array<[keyof SigninCopy, string, number]> = [
    ["title", "sign-in title", LIMITS.titleMax],
    ["subtitle", "sign-in subtitle", LIMITS.subtitleMax],
    ["signup_title", "sign-up title", LIMITS.titleMax],
    ["signup_subtitle", "sign-up subtitle", LIMITS.subtitleMax],
    ["opening_title", "Opening page title", LIMITS.titleMax],
  ];
  for (const [key, what, max] of texts) {
    const problem = plainTextProblem(copy[key], what, max);
    if (problem) out[`copy.${key}`] = problem;
  }
  const opening = copy.opening_title?.trim() ?? "";
  const placeholder = [...opening.matchAll(/\{([^}]*)\}/g)].find(match => match[1] !== "provider" && match[1] !== "app");
  if (placeholder && !out["copy.opening_title"]) out["copy.opening_title"] = `{${placeholder[1]}} is not a placeholder; the Opening page title can use {provider} (Google or Apple) and {app} (the app's name).`;
  if (copy.terms_url?.trim()) {
    const problem = httpsUrlProblem(copy.terms_url, "https://example.com/terms");
    if (problem) out["copy.terms_url"] = problem;
  }
  if (copy.privacy_url?.trim()) {
    const problem = httpsUrlProblem(copy.privacy_url, "https://example.com/privacy");
    if (problem) out["copy.privacy_url"] = problem;
  }
  if (copy.support_email?.trim()) {
    const problem = emailProblem(copy.support_email);
    if (problem) out["copy.support_email"] = problem;
  }
  return out;
}

/** Step ids: lowercase letters, digits and dashes, 1 to 40 characters, unique in the flow. */
export const STEP_ID = /^[a-z0-9-]{1,40}$/;

/**
 * Every problem in the details and the flow (the server's rules, 422 with the same paths): a detail is required or
 * optional, never both; a flow has 1 to 8 pages, each with a unique id and at least one detail; every requested detail is
 * on exactly one page and pages only hold requested details; titles, subtitles and continue labels are short plain text.
 */
export function flowProblems(config: Pick<EditableConfig, "required_fields" | "optional_fields" | "flow">): Record<string, string> {
  const out: Record<string, string> = {};
  const both = config.optional_fields.filter(field => config.required_fields.includes(field));
  if (both.length) out.optional_fields = `${both.join(", ")} ${both.length === 1 ? "is" : "are"} also required; a detail is either required or optional.`;
  const flow = config.flow;
  if (!flow) return out;
  const requested = requestedFields(config);
  if (!flow.steps.length) out["flow.steps"] = "A flow needs at least one page. Turn the custom flow off to use the default page.";
  if (flow.steps.length > MAX_FLOW_STEPS) out["flow.steps"] = `A flow can have at most ${MAX_FLOW_STEPS} pages; this one has ${flow.steps.length}.`;
  const ids = new Map<string, number>();
  const placed = new Map<ContactField, number>();
  flow.steps.forEach((step, index) => {
    const at = `flow.steps[${index}]`;
    if (!STEP_ID.test(step.id)) out[`${at}.id`] = step.id ? `'${step.id}' is not a page id: use 1 to 40 lowercase letters, digits and dashes, like contact or about-you.` : "Give the page an id, like contact or about-you.";
    else if (ids.has(step.id)) out[`${at}.id`] = `Page ${(ids.get(step.id) ?? 0) + 1} already uses the id '${step.id}'; ids are unique.`;
    else ids.set(step.id, index);
    if (!step.fields.length) out[`${at}.fields`] = "This page asks nothing: move a detail onto it, or remove the page.";
    for (const field of step.fields) {
      if (!requested.includes(field)) out[`${at}.fields`] = `${field} is not one of the details the app asks for; pick it on the Details tab first.`;
      else if (placed.has(field)) out[`${at}.fields`] = `${field} is already asked on page ${(placed.get(field) ?? 0) + 1}; each detail is asked once.`;
      else placed.set(field, index);
    }
    const title = plainTextProblem(step.title, "title", LIMITS.titleMax);
    if (title) out[`${at}.title`] = title;
    const subtitle = plainTextProblem(step.subtitle, "subtitle", LIMITS.subtitleMax);
    if (subtitle) out[`${at}.subtitle`] = subtitle;
    const label = plainTextProblem(step.continue_label, "continue label", LIMITS.continueLabelMax);
    if (label) out[`${at}.continue_label`] = label;
    if (step.layout !== null && !FLOW_LAYOUTS.includes(step.layout)) out[`${at}.layout`] = "Choose card, split, minimal, or the branding's layout.";
  });
  const unplaced = requested.filter(field => !placed.has(field));
  if (unplaced.length && !out["flow.steps"]) out["flow.steps"] = `${unplaced.join(", ")} ${unplaced.length === 1 ? "is" : "are"} asked for but on no page; drag ${unplaced.length === 1 ? "it" : "them"} onto one.`;
  return out;
}

/** Every problem in a branding draft, keyed by the server's field paths (including the 4.5:1 text contrast rule). */
export function brandingProblems(branding: Branding): Record<string, string> {
  const out: Record<string, string> = {};
  if (branding.logo_height < LIMITS.logoHeight.min || branding.logo_height > LIMITS.logoHeight.max) out["branding.logo_height"] = `The logo height is ${branding.logo_height}; it must be between ${LIMITS.logoHeight.min} and ${LIMITS.logoHeight.max} pixels.`;
  if (branding.radius < LIMITS.radius.min || branding.radius > LIMITS.radius.max) out["branding.radius"] = `The radius is ${branding.radius}; it must be between ${LIMITS.radius.min} and ${LIMITS.radius.max} pixels.`;
  for (const key of ["logo_url", "logo_dark_url"] as const) {
    const value = branding[key];
    if (value?.trim()) {
      const problem = logoUrlProblem(value);
      if (problem) out[`branding.${key}`] = problem;
    }
  }
  if (branding.background_style === "image" && !branding.background_image_url?.trim()) out["branding.background_image_url"] = "The image background needs an https image URL.";
  else if (branding.background_image_url?.trim()) {
    const problem = httpsUrlProblem(branding.background_image_url, "https://example.com/background.jpg");
    if (problem) out["branding.background_image_url"] = problem;
  }
  for (const theme of ["light", "dark"] as const) {
    for (const [name, value] of Object.entries(branding[theme])) {
      if (!/^#[0-9a-fA-F]{6}$/.test(value)) out[`branding.${theme}.${name}`] = `'${value}' must be a #RRGGBB colour.`;
    }
  }
  for (const issue of brandingContrastIssues(branding)) out[issue.path] ??= issue.message;
  return out;
}

/**
 * The edits that choose a background style. The server checks background_image_url whatever the style, and the Pages
 * tab shows that field only while Image is chosen, so leaving Image drops a URL the server would refuse: a problem in a
 * field nobody can see must never block saving. A usable URL stays, for coming back to Image.
 */
export function backgroundStyleEdits(branding: Pick<Branding, "background_image_url">, style: Branding["background_style"]): Record<string, unknown> {
  const url = branding.background_image_url?.trim();
  const unusable = !!url && !!httpsUrlProblem(url, "https://example.com/background.jpg");
  return style !== "image" && unusable ? { "branding.background_style": style, "branding.background_image_url": null } : { "branding.background_style": style };
}

/** An app id as Silicon Apps assigns them: `[a-z][a-z0-9-]{1,39}`. */
export function appIdProblem(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (!value) return "Enter an app id like remind.";
  return /^[a-z][a-z0-9-]{1,39}$/.test(value) ? null : `'${raw.trim()}' is not an app id: 2 to 40 characters, lowercase letters, digits and dashes, starting with a letter.`;
}

/** Proof scopes are the apps' own: 1 to 100 characters of A-Z a-z 0-9 _ . : / - */
export function proofScopeProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Enter a scope like files.write.";
  if (value.length > 100) return "A scope can be at most 100 characters.";
  const bad = [...value].find(char => !/[A-Za-z0-9_.:/-]/.test(char));
  return bad ? `'${value}' contains '${bad}'; scopes use only letters, digits and _ . : / -` : null;
}

/** The four octets of a dotted-quad IPv4 host (the URL parser writes every IPv4 spelling this way), or null. */
function ipv4Octets(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every(octet => octet <= 255) ? octets : null;
}

/** The eight 16-bit groups of an IPv6 address written without brackets, or null. */
function ipv6Groups(text: string): number[] | null {
  let address = text.toLowerCase();
  const embedded = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (embedded) {
    const octets = ipv4Octets(embedded[2] ?? "");
    if (!octets) return null;
    address = `${embedded[1]}${(((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16)}:${(((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (![...left, ...right].every(group => /^[0-9a-f]{1,4}$/.test(group))) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  return [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right].map(group => parseInt(group, 16));
}

/** The server's `is_public_ip` for IPv4 (crates/core normalize.rs): not private, loopback, link-local, documentation… */
function isPublicIpv4([a = 0, b = 0, c = 0, d = 0]: number[]): boolean {
  return !(
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) // private
    || a === 127 // loopback
    || (a === 169 && b === 254) // link-local
    || (a === 255 && b === 255 && c === 255 && d === 255) // broadcast
    || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) // documentation
    || a === 0 // unspecified and "this network"
    || (a >= 224 && a <= 239) // multicast
    || (a === 100 && b >= 64 && b <= 127) // shared address space
    || (a === 192 && b === 0 && c === 0) // IETF protocol assignments
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || a >= 240 // reserved
  );
}

/** The server's `is_public_ip` for IPv6: only global unicast (2000::/3), minus IETF and documentation ranges. */
function isPublicIpv6(groups: number[]): boolean {
  const octets = groups.flatMap(group => [group >> 8, group & 0xff]);
  const [first = 0, second = 0] = groups;
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) return isPublicIpv4(octets.slice(12)); // ::ffff:a.b.c.d
  if (first === 0x64 && second === 0xff9b && groups.slice(2, 6).every(group => group === 0)) return isPublicIpv4(octets.slice(12)); // 64:ff9b::/96
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2002) return isPublicIpv4(octets.slice(2, 6)); // 6to4
  const ietf = first === 0x2001 && second < 0x0200;
  const documentation = (first === 0x2001 && second === 0x0db8) || (first === 0x3fff && second < 0x1000);
  return !ietf && !documentation;
}

/** True when a URL host (as `URL.hostname` writes it) is an IP literal that isn't public. Host names are never judged here. */
export function isNonPublicIpHost(hostname: string): boolean {
  const v4 = ipv4Octets(hostname);
  if (v4) return !isPublicIpv4(v4);
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const v6 = ipv6Groups(hostname.slice(1, -1));
    return v6 ? !isPublicIpv6(v6) : false;
  }
  return false;
}

/**
 * The webhook URL rule of the server (crates/core normalize.rs `validate_webhook_url`). `strict` is the rule without
 * ACCOUNTS_WEBHOOK_ALLOW_PRIVATE, which production always runs: https, no local host names (localhost, *.localhost,
 * *.internal) and no IP literal that isn't public. Host names are not resolved here: the server checks where they point
 * when it delivers. Anywhere else the server decides (its 422 `details.fields.url` shows next to the field).
 */
export function webhookUrlProblem(raw: string, strict: boolean): string | null {
  const value = raw.trim();
  if (!value) return "Enter the URL Silicon Accounts should POST events to, like https://app.example.com/webhooks/accounts.";
  if (value.length > 2048) return "The webhook URL is longer than 2048 characters.";
  const url = parse(value);
  if (!url) return `'${value}' is not an absolute URL like https://app.example.com/webhooks/accounts.`;
  if (value.includes("#")) return `'${value}' must not contain a #fragment.`;
  if (url.username || url.password) return `'${value}' must not contain credentials.`;
  if (!strict) return url.protocol === "https:" || url.protocol === "http:" ? null : `'${value}' must use https (or http in development).`;
  if (url.protocol !== "https:") return `'${value}' must use https.`;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return `'${value}' points at a local host; webhooks must reach a public server.`;
  if (isNonPublicIpHost(url.hostname)) return `'${value}' points at a private or reserved IP address; webhooks must reach a public server.`;
  return null;
}
