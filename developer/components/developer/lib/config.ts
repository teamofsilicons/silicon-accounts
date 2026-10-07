/**
 * The editable shape of an app's sign-in setup and the rules for turning a draft into a PATCH body. The server
 * deep-merges objects, replaces arrays and scalars, and resets a field to its default on `null`; secrets travel next
 * to the document (`google.client_secret`, `apple.private_key`) and are never read back (crates/apps signin_config.rs).
 *
 * Three save groups ("sections"), each saved on its own with `expected_version`:
 *   signin   the Sign-in tab: methods and their order, Google and Apple, redirect URIs, allowed origins, who can sign in
 *   flow     the Details and Flows tabs: the required and optional details and the flow that asks them. They are one
 *            group because the flow must hold exactly the requested details: ticking a detail adds it to the flow, and
 *            removing one takes it out (reconcileFlow), so a save is always a valid document.
 *   pages    the Pages tab: the branding variables and every page's words (copy)
 */
import type { AppleConfig, BrandLayout, ContactField, GoogleConfig, SigninConfig, SigninConfigPatch, SigninConfigView, SigninFlow, SigninFlowStep, SigninMethod } from "@/lib/api/types";
import { DEFAULT_BRANDING, normalizeBranding, normalizeCopy } from "@/lib/branding/defaults";
import { clone, deepEqual } from "./json";

/** SigninConfig without the read-only secret markers, with the flow always present (null = the default flow). */
export type EditableConfig = Omit<SigninConfig, "flow"> & { flow: SigninFlow | null };

export type SectionKey = "signin" | "flow" | "pages";
export const SECTIONS: readonly SectionKey[] = ["signin", "flow", "pages"];

/** Which top-level keys each save group owns. */
export const SECTION_KEYS: Record<SectionKey, readonly (keyof EditableConfig)[]> = {
  signin: ["methods", "method_order", "google", "apple", "redirect_uris", "allowed_origins", "allowed_email_domains", "allow_signup", "remember_browser"],
  flow: ["required_fields", "optional_fields", "flow"],
  pages: ["branding", "copy"],
};

export const SECTION_LABEL: Record<SectionKey, string> = { signin: "Sign-in", flow: "Details and flows", pages: "Pages" };

const KEY_SECTION = new Map<string, SectionKey>(SECTIONS.flatMap(section => SECTION_KEYS[section].map(key => [key as string, section] as const)));

/** The save group a dotted path belongs to (`branding.light.primary` → pages, `flow.steps` → flow). */
export function sectionOf(path: string): SectionKey {
  const top = path.split(/[.[]/)[0] ?? "";
  return KEY_SECTION.get(top) ?? "signin";
}

export const METHODS: readonly SigninMethod[] = ["google", "apple", "email", "phone"];
export const CONTACT_FIELDS: readonly ContactField[] = ["email", "phone", "dob", "timezone"];
export const FLOW_LAYOUTS: readonly BrandLayout[] = ["card", "split", "minimal"];
export const MAX_FLOW_STEPS = 8;

const strOrNull = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);
const list = <T>(value: unknown, allowed?: readonly T[]): T[] =>
  Array.isArray(value) ? (value as T[]).filter(item => (allowed ? allowed.includes(item) : typeof item === "string")) : [];

/** A flow as the editor holds it (null stays null: the default flow). Unknown values are dropped, never invented. */
export function normalizeFlow(value: unknown): SigninFlow | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SigninFlow>;
  const steps = Array.isArray(raw.steps)
    ? raw.steps.map((step): SigninFlowStep => {
      const item = (step ?? {}) as Partial<SigninFlowStep>;
      return {
        id: typeof item.id === "string" ? item.id : "",
        fields: list<ContactField>(item.fields, CONTACT_FIELDS),
        title: strOrNull(item.title),
        subtitle: strOrNull(item.subtitle),
        continue_label: strOrNull(item.continue_label),
        layout: FLOW_LAYOUTS.includes(item.layout as BrandLayout) ? (item.layout as BrandLayout) : null,
      };
    })
    : [];
  return { steps, review: !!raw.review };
}

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
    flow: normalizeFlow(raw.flow),
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Details and the flow                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/** The details an app asks for, in the order the editor lists them (required first, then optional). */
export function requestedFields(config: Pick<EditableConfig, "required_fields" | "optional_fields">): ContactField[] {
  return [...config.required_fields, ...config.optional_fields.filter(field => !config.required_fields.includes(field))];
}

/** A free step id like `step-3`. */
export function freeStepId(steps: readonly SigninFlowStep[], base = "step"): string {
  const taken = new Set(steps.map(step => step.id));
  for (let index = steps.length + 1; ; index += 1) {
    const id = `${base}-${index}`;
    if (!taken.has(id)) return id;
  }
}

export const emptyStep = (id: string, fields: ContactField[] = []): SigninFlowStep => ({ id, fields, title: null, subtitle: null, continue_label: null, layout: null });

/** The flow null stands for: one page with every requested detail, no review. */
export function defaultFlowOf(config: Pick<EditableConfig, "required_fields" | "optional_fields">): SigninFlow {
  return { steps: [emptyStep("details", requestedFields(config))], review: false };
}

/**
 * Keeps a flow in step with the requested details (what the server's PATCH merge does too): fields no longer requested
 * leave their step, an emptied step is dropped, a newly requested field joins the last step. A flow with nothing left
 * to ask becomes null (the default: the what's-shared page with the profile only).
 */
export function reconcileFlow(flow: SigninFlow | null, config: Pick<EditableConfig, "required_fields" | "optional_fields">): SigninFlow | null {
  if (!flow) return null;
  const requested = requestedFields(config);
  if (!requested.length) return null;
  const seen = new Set<ContactField>();
  let steps = flow.steps.map(step => ({
    ...step,
    fields: step.fields.filter(field => {
      if (!requested.includes(field) || seen.has(field)) return false;
      seen.add(field);
      return true;
    }),
  }));
  steps = steps.filter(step => step.fields.length > 0);
  const missing = requested.filter(field => !seen.has(field));
  if (missing.length) {
    if (steps.length) steps[steps.length - 1] = { ...steps[steps.length - 1]!, fields: [...steps[steps.length - 1]!.fields, ...missing] };
    else steps = [emptyStep(freeStepId([], "details"), missing)];
  }
  const next = { ...flow, steps };
  return deepEqual(next, flow) ? flow : next;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Secrets and the wire                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

/** What the editor knows about stored secrets: they are never returned, only whether they are set. */
export function secretsStored(view: Partial<SigninConfigView> | null | undefined): { google: boolean; apple: boolean } {
  return { google: !!view?.google?.client_secret_set, apple: !!view?.apple?.private_key_set };
}

export interface SecretsDraft {
  /** A new Google client secret ("" = keep what is stored). */
  googleSecret: string;
  /** Remove the stored Google client secret. */
  googleRemove: boolean;
  /**
   * The stored Google secret's field is open for a replacement (Replace was pressed). Not a change by itself: it only
   * decides what the field shows. It lives in the draft, not in the field, so a save or Discard (which empty the draft
   * secrets) puts the field back to "A client secret is stored" instead of leaving an empty replace field.
   */
  googleReplace: boolean;
  /** A new Apple .p8 key ("" = keep what is stored). */
  appleKey: string;
  /** Remove the stored Apple key. */
  appleRemove: boolean;
  /** The stored Apple key's field is open for a replacement (see googleReplace). */
  appleReplace: boolean;
}

export const NO_SECRETS: SecretsDraft = { googleSecret: "", googleRemove: false, googleReplace: false, appleKey: "", appleRemove: false, appleReplace: false };

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

/**
 * The PATCH body for one save group: every top-level key it owns that differs from the stored config, plus secrets.
 * The flow group always sends the flow with the details (the server checks them together).
 */
export function sectionPatch(section: SectionKey, draft: EditableConfig, base: EditableConfig, secrets: SecretsDraft): SigninConfigPatch {
  const patch: Record<string, unknown> = {};
  for (const key of SECTION_KEYS[section]) {
    if (!deepEqual(draft[key], base[key])) patch[key] = wire(clone(draft[key]));
  }
  if (section === "flow" && Object.keys(patch).length && !("flow" in patch)) patch.flow = wire(clone(draft.flow));
  if (section === "signin") {
    // A typed secret is sent only while the provider is set to bring your own; one click never needs it.
    const google = secrets.googleSecret.trim() && draft.google.mode === "byo" ? secrets.googleSecret.trim() : secrets.googleRemove ? null : undefined;
    if (google !== undefined) patch.google = { ...((patch.google as object | undefined) ?? {}), client_secret: google };
    const apple = secrets.appleKey.trim() && draft.apple.mode === "byo" ? secrets.appleKey.trim() : secrets.appleRemove ? null : undefined;
    if (apple !== undefined) patch.apple = { ...((patch.apple as object | undefined) ?? {}), private_key: apple };
  }
  return patch as SigninConfigPatch;
}

const PATH_LABELS: Record<string, string> = {
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
  flow: "Flow",
  "flow.steps": "Flow pages",
  "flow.review": "Review page",
  "copy.title": "Sign-in title",
  "copy.subtitle": "Sign-in subtitle",
  "copy.signup_title": "Sign-up title",
  "copy.signup_subtitle": "Sign-up subtitle",
  "copy.opening_title": "Opening page title",
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

const COLOUR_NAMES: Record<string, string> = { primary: "primary", primary_foreground: "text on primary", background: "background", surface: "card", foreground: "text", muted: "muted text", border: "border", danger: "error" };
const STEP_FIELD: Record<string, string> = { id: "id", fields: "details", title: "title", subtitle: "subtitle", continue_label: "continue label", layout: "layout" };

/** Labels for leaf paths in history entries and conflict notes ("branding.light.primary" → "Light primary colour"). */
export function pathLabel(path: string): string {
  const exact = PATH_LABELS[path];
  if (exact) return exact;
  const colour = /^branding\.(light|dark)\.(\w+)$/.exec(path);
  if (colour) return `${colour[1] === "light" ? "Light" : "Dark"} ${COLOUR_NAMES[colour[2] ?? ""] ?? colour[2]} colour`;
  const step = /^flow\.steps\[(\d+)\](?:\.(\w+))?/.exec(path);
  if (step) return `Flow page ${Number(step[1]) + 1}${step[2] ? ` ${STEP_FIELD[step[2]] ?? step[2]}` : ""}`;
  const indexed = /^(\w+)\[(\d+)\]$/.exec(path);
  if (indexed) return `${PATH_LABELS[indexed[1] ?? ""] ?? indexed[1]} (item ${Number(indexed[2]) + 1})`;
  return path;
}
