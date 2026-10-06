/**
 * The editable shape of an app's sign-in config and the rules for turning a draft into a PATCH body. The server
 * deep-merges objects, replaces arrays and scalars, and resets a field to its default on `null`; secrets travel next
 * to the document (`google.client_secret`, `apple.private_key`) and are never read back.
 */
import type { AppleConfig, ContactField, GoogleConfig, SigninConfig, SigninConfigPatch, SigninConfigView, SigninMethod } from "../../../api";
import { DEFAULT_BRANDING, normalizeBranding, normalizeCopy } from "../../../branding";
import { clone, deepEqual } from "./paths";

/** SigninConfig without the read-only secret markers. */
export type EditableConfig = SigninConfig;

export type SectionKey = "signin" | "branding";

/** Which top-level keys each editor tab owns. */
export const SECTION_KEYS: Record<SectionKey, readonly (keyof EditableConfig)[]> = {
  signin: ["methods", "method_order", "google", "apple", "redirect_uris", "allowed_origins", "required_fields", "optional_fields", "allowed_email_domains", "allow_signup", "remember_browser", "copy"],
  branding: ["branding"],
};

export const SECTION_LABEL: Record<SectionKey, string> = { signin: "Sign-in", branding: "Branding" };

export const METHODS: readonly SigninMethod[] = ["google", "apple", "email", "phone"];
export const CONTACT_FIELDS: readonly ContactField[] = ["email", "phone", "dob", "timezone"];

const strOrNull = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const list = <T>(value: unknown, allowed?: readonly T[]): T[] => (Array.isArray(value) ? (value as T[]).filter(item => (allowed ? allowed.includes(item) : typeof item === "string")) : []);

/** A complete, editable config from whatever the server (or a fixture) sent. */
export function normalizeConfig(view: Partial<SigninConfigView> | null | undefined): EditableConfig {
  const raw = (view ?? {}) as Partial<SigninConfigView>;
  const methods = { email: true, phone: false, google: false, apple: false, ...(raw.methods ?? {}) };
  const order = list<SigninMethod>(raw.method_order, METHODS);
  for (const method of METHODS) if (!order.includes(method)) order.push(method);
  const google: GoogleConfig = {
    mode: raw.google?.mode === "byo" ? "byo" : "managed",
    client_id: strOrNull(raw.google?.client_id),
    prompt: raw.google?.prompt === undefined ? "select_account" : strOrNull(raw.google?.prompt),
    hosted_domain: strOrNull(raw.google?.hosted_domain),
  };
  const apple: AppleConfig = {
    mode: raw.apple?.mode === "byo" ? "byo" : "managed",
    services_id: strOrNull(raw.apple?.services_id),
    team_id: strOrNull(raw.apple?.team_id),
    key_id: strOrNull(raw.apple?.key_id),
  };
  return {
    methods: { email: !!methods.email, phone: !!methods.phone, google: !!methods.google, apple: !!methods.apple },
    method_order: order,
    google,
    apple,
    redirect_uris: list<string>(raw.redirect_uris),
    allowed_origins: list<string>(raw.allowed_origins),
    required_fields: list<ContactField>(raw.required_fields, CONTACT_FIELDS),
    optional_fields: list<ContactField>(raw.optional_fields, CONTACT_FIELDS),
    allowed_email_domains: list<string>(raw.allowed_email_domains),
    allow_signup: raw.allow_signup ?? true,
    remember_browser: raw.remember_browser ?? true,
    branding: normalizeBranding(raw.branding ?? DEFAULT_BRANDING),
    copy: normalizeCopy(raw.copy),
  };
}

/** What the editor knows about stored secrets (they are never returned, only whether they are set). */
export function secretsStored(view: Partial<SigninConfigView> | null | undefined): { google: boolean; apple: boolean } {
  return { google: !!view?.google?.client_secret_set, apple: !!view?.apple?.private_key_set };
}

export interface SecretsDraft {
  /** A new Google client secret ("" = keep what is stored). */
  googleSecret: string;
  /** Remove the stored Google client secret. */
  googleRemove: boolean;
  /** A new Apple .p8 key ("" = keep what is stored). */
  appleKey: string;
  /** Remove the stored Apple key. */
  appleRemove: boolean;
}

export const NO_SECRETS: SecretsDraft = { googleSecret: "", googleRemove: false, appleKey: "", appleRemove: false };

/** Secret changes that will be sent: a typed secret only counts while that provider is set to bring your own. */
export function secretsChanged(secrets: SecretsDraft, draft: Pick<EditableConfig, "google" | "apple">): string[] {
  const out: string[] = [];
  if ((secrets.googleSecret.trim() && draft.google.mode === "byo") || secrets.googleRemove) out.push("google.client_secret");
  if ((secrets.appleKey.trim() && draft.apple.mode === "byo") || secrets.appleRemove) out.push("apple.private_key");
  return out;
}

/** Trims strings and turns empty ones into null, recursively (arrays are trimmed item by item and emptied of blanks). */
function wire(value: unknown): unknown {
  if (typeof value === "string") return value.trim() ? value.trim() : null;
  if (Array.isArray(value)) return value.map(item => (typeof item === "string" ? item.trim() : wire(item))).filter(item => item !== "" && item !== null);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wire(item)]));
  return value;
}

/** The PATCH body for one tab: every top-level key it owns that differs from the stored config, plus secrets. */
export function sectionPatch(section: SectionKey, draft: EditableConfig, base: EditableConfig, secrets: SecretsDraft): SigninConfigPatch {
  const patch: Record<string, unknown> = {};
  for (const key of SECTION_KEYS[section]) {
    if (!deepEqual(draft[key], base[key])) patch[key] = wire(clone(draft[key]));
  }
  if (section === "signin") {
    // A typed secret is sent only while the provider is set to bring your own; one click never needs it.
    const google = secrets.googleSecret.trim() && draft.google.mode === "byo" ? secrets.googleSecret.trim() : secrets.googleRemove ? null : undefined;
    if (google !== undefined) patch.google = { ...((patch.google as object | undefined) ?? {}), client_secret: google };
    const apple = secrets.appleKey.trim() && draft.apple.mode === "byo" ? secrets.appleKey.trim() : secrets.appleRemove ? null : undefined;
    if (apple !== undefined) patch.apple = { ...((patch.apple as object | undefined) ?? {}), private_key: apple };
  }
  return patch as SigninConfigPatch;
}

/** Labels for leaf paths in history entries and conflict notes ("branding.light.primary" → "Light primary colour"). */
export function pathLabel(path: string): string {
  const exact: Record<string, string> = {
    methods: "Sign-in methods",
    "methods.email": "Email sign-in",
    "methods.phone": "Phone sign-in",
    "methods.google": "Google sign-in",
    "methods.apple": "Apple sign-in",
    method_order: "Method order",
    "google.mode": "Google: one click or bring your own",
    "google.client_id": "Google client ID",
    "google.client_secret": "Google client secret",
    "google.prompt": "Google prompt",
    "google.hosted_domain": "Google Workspace domain",
    "apple.mode": "Apple: one click or bring your own",
    "apple.services_id": "Apple Services ID",
    "apple.team_id": "Apple Team ID",
    "apple.key_id": "Apple Key ID",
    "apple.private_key": "Apple private key",
    redirect_uris: "Redirect URIs",
    allowed_origins: "Allowed origins",
    required_fields: "Required details",
    optional_fields: "Optional details",
    allowed_email_domains: "Allowed email domains",
    allow_signup: "Allow sign up",
    remember_browser: "Remember this browser",
    "copy.title": "Title",
    "copy.subtitle": "Subtitle",
    "copy.terms_url": "Terms URL",
    "copy.privacy_url": "Privacy URL",
    "copy.support_email": "Support email",
    "branding.theme": "Theme",
    "branding.logo_url": "Logo",
    "branding.logo_dark_url": "Dark logo",
    "branding.logo_height": "Logo height",
    "branding.show_app_name": "Show app name",
    "branding.font_family": "Font",
    "branding.heading_font_family": "Heading font",
    "branding.corner_style": "Corner style",
    "branding.radius": "Radius",
    "branding.button_style": "Button style",
    "branding.layout": "Layout",
    "branding.background_style": "Background",
    "branding.background_image_url": "Background image",
    "branding.density": "Density",
  };
  if (exact[path]) return exact[path];
  const colour = /^branding\.(light|dark)\.(\w+)$/.exec(path);
  if (colour) {
    const names: Record<string, string> = { primary: "primary", primary_foreground: "text on primary", background: "background", surface: "surface", foreground: "text", muted: "muted text", border: "border", danger: "danger" };
    return `${colour[1] === "light" ? "Light" : "Dark"} ${names[colour[2] ?? ""] ?? colour[2]} colour`;
  }
  const indexed = /^(\w+)\[(\d+)\]$/.exec(path);
  if (indexed) return `${exact[indexed[1] ?? ""] ?? indexed[1]} (item ${Number(indexed[2]) + 1})`;
  return path;
}
