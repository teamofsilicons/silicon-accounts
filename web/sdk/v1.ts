/**
 * Silicon Accounts SDK v1, served at /sdk/v1.js: one dependency-free script that renders an app's sign-in buttons and
 * sends people to the hosted sign-in pages.
 *
 *   <div id="silicon-accounts"></div>
 *   <script src="https://accounts.teamofsilicons.com/sdk/v1.js" data-app-id="briefcase"
 *           data-redirect-uri="https://briefcase.example/callback" data-target="#silicon-accounts" async></script>
 *
 * Script attributes (data-app-id and data-redirect-uri are required for the automatic buttons):
 *   data-target                   CSS selector of the element to render into (default: right after the script)
 *   data-state                    your state; without it the SDK creates one and keeps it in sessionStorage
 *   data-code-challenge(-method)  your PKCE challenge (S256 or plain)
 *   data-pkce="S256"              have the SDK create PKCE itself (the verifier goes to sessionStorage)
 *   data-buttons                  methods (default: "Continue with Google", "Continue with email"… one per method the
 *                                 app turned on, each opening our pages on that method) or intents ("Sign in" and
 *                                 "Sign up"; our pages then show every method)
 *   data-intent                   signin (default) | signup: which of our pages opens (the sign-in or the sign-up
 *                                 version); with data-buttons="intents" it keeps just that button
 *   data-method                   google | apple | email | phone: show just that method's button
 *   data-scope, data-nonce, data-prompt, data-theme (light | dark | auto)
 *
 * An app never passes a Carbon's email or phone: there is no login hint. The Carbon always types it on our pages
 * (data-login-hint and any email or phone option are ignored, with a warning on the console).
 *
 * window.SiliconAccounts:
 *   authorizeUrl(options)          the /authorize URL for these options (no side effects; options override attributes)
 *   signIn(options)                sends this window to sign in, creating state (and PKCE when asked) if needed
 *   renderButtons(target, options) renders the app's configured buttons into target (inside a Shadow DOM)
 *   mountFrame(target, options)    the iframe version (/embed/v1/buttons), sized to its content
 *   handleCallback(url?)           on the callback page: checks the state, returns {code, codeVerifier, nonce, …}
 *
 * Embedded button frames on the page (also ones pasted as HTML) follow the height they report.
 *
 * When the SDK creates the state or the PKCE verifier, it stores {state, code_verifier, nonce, redirect_uri, app_id}
 * as JSON in sessionStorage under "silicon-accounts:auth:<state>" before leaving the page, so the app's callback can
 * check the state and finish the code exchange. The SDK fires "silicon-accounts:ready" on document when it loads.
 *
 * Theme: `theme` (data-theme) light or dark paints the buttons that way. Otherwise the app's branding decides when it
 * forces a theme, and else the page itself: the first opaque background behind the buttons (or, with none, the page's
 * color-scheme), read again when the page changes its theme. Everything the SDK draws is opaque, the "Powered by
 * Silicon Accounts" pill included, so it reads on any page.
 */
import {
  INTENT_LABEL, METHOD_LABEL, METHOD_MARK, POWERED_BY_HREF, POWERED_MARK, isButtonIntent, isButtonMethod, isButtonSet, primaryMethod, visibleIntents,
  visibleMethods, type ButtonIntent, type ButtonMethod, type ButtonSet,
} from "./methods";

type Theme = "light" | "dark" | "auto";
type Prompt = "login" | "consent" | "select_account" | "none";

export interface AuthorizeOptions {
  appId?: string;
  redirectUri?: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: "S256" | "plain";
  /** Space-separated, for example "openid email". */
  scope?: string;
  nonce?: string;
  prompt?: Prompt;
  /** Which of our pages opens: the sign-in (default) or the sign-up version. */
  intent?: ButtonIntent;
  /**
   * Open our pages on one enabled method: google and apple first show "Opening Google…" and move on to the provider,
   * email and phone open on their empty field. null leaves out the script tag's data-method.
   */
  method?: ButtonMethod | null;
}

export interface SignInOptions extends AuthorizeOptions {
  /** "S256" (or true) creates a PKCE verifier and challenge when no codeChallenge is given. */
  pkce?: boolean | "S256";
}

export interface RenderOptions extends SignInOptions {
  /** Match your page: light, dark, or auto (the app's branding, else the device). */
  theme?: Theme;
  /** methods (default): a button per method; intents: "Sign in" and "Sign up" (narrowed by `intent`). */
  buttons?: ButtonSet;
}

export interface RenderedButtons {
  /** The app's public sign-in config the buttons were drawn from. */
  app: PublicApp;
  /** Removes the buttons. */
  destroy(): void;
}

interface Palette { primary: string; primary_foreground: string; background: string; surface: string; foreground: string; muted: string; border: string; danger: string }
interface PublicApp {
  app_id: string;
  name: string;
  methods: string[];
  branding?: { theme?: Theme; radius?: number; corner_style?: string; button_style?: string; density?: string; font_family?: string; light?: Partial<Palette>; dark?: Partial<Palette> };
}

const TAG = "Silicon Accounts:";
const STORAGE_PREFIX = "silicon-accounts:auth:";
const LIGHT: Palette = { primary: "#1F5FB8", primary_foreground: "#FFFDF9", background: "#FFFDF9", surface: "#FFFFFF", foreground: "#353432", muted: "#6F6B66", border: "#E8E3DA", danger: "#B42318" };
/**
 * The default dark palette (crates/core `default_dark`, lib/branding/defaults.ts DEFAULT_DARK): filled buttons are the
 * brand blue #1F5FB8 under paper white (6.1:1); accent-coloured text uses the lighter ink below (`--ink`).
 */
const DARK: Palette = { primary: "#1F5FB8", primary_foreground: "#FFFDF9", background: "#2A2927", surface: "#353432", foreground: "#FFFDF9", muted: "#B5B0A8", border: "#4A4845", danger: "#FF8A80" };
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const FONTS: Record<string, string> = {
  Geist: `"Geist Variable", "Geist", ${SANS}`,
  Inter: `"Inter Variable", "Inter", ${SANS}`,
  "IBM Plex Sans": `"IBM Plex Sans Variable", "IBM Plex Sans", ${SANS}`,
  "DM Sans": `"DM Sans Variable", "DM Sans", ${SANS}`,
  "Space Grotesk": `"Space Grotesk Variable", "Space Grotesk", ${SANS}`,
  "Source Serif 4": `"Source Serif 4 Variable", "Source Serif 4", ui-serif, Georgia, serif`,
  Fraunces: `"Fraunces Variable", "Fraunces", ui-serif, Georgia, serif`,
  "Instrument Serif": `"Instrument Serif", ui-serif, Georgia, serif`,
  "JetBrains Mono": `"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace`,
  System: SANS,
};

const script = document.currentScript instanceof HTMLScriptElement ? document.currentScript : null;
/** Silicon Accounts lives where this script came from. */
const base = (() => {
  try {
    return new URL(script?.src || location.href, location.href).origin;
  } catch {
    return location.origin;
  }
})();

const attribute = (name: string): string | undefined => script?.getAttribute(`data-${name}`)?.trim() || undefined;
const defaults: RenderOptions = {
  appId: attribute("app-id"),
  redirectUri: attribute("redirect-uri"),
  state: attribute("state"),
  codeChallenge: attribute("code-challenge"),
  codeChallengeMethod: attribute("code-challenge-method") as AuthorizeOptions["codeChallengeMethod"],
  scope: attribute("scope"),
  nonce: attribute("nonce"),
  prompt: attribute("prompt") as Prompt | undefined,
  intent: attribute("intent") as ButtonIntent | undefined,
  method: attribute("method") as ButtonMethod | undefined,
  buttons: attribute("buttons") as ButtonSet | undefined,
  theme: attribute("theme") as Theme | undefined,
  pkce: attribute("pkce") ? attribute("pkce") !== "false" : undefined,
};

/** Options an app may try that would hand us the Carbon's email or phone: never forwarded. */
const CONTACT_OPTIONS = ["loginHint", "login_hint", "email", "phone"];
let warnedContact = false;
function warnContact(): void {
  if (warnedContact) return;
  warnedContact = true;
  console.warn(`${TAG} an email or phone (login hint) passed by the app is ignored: the Carbon always types it on the Silicon Accounts pages.`);
}
if (script?.hasAttribute("data-login-hint") || script?.hasAttribute("data-email") || script?.hasAttribute("data-phone")) warnContact();

/** Defaults from the script tag, overridden by every option that is set. */
function merge<T extends object>(options: T | undefined): RenderOptions & T {
  const out: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(options ?? {})) {
    if (CONTACT_OPTIONS.includes(key)) {
      if (value) warnContact();
      continue;
    }
    // null: leave the script tag's value out (an intent button opens no particular method).
    if (value === null) delete out[key];
    else if (value !== undefined && value !== "") out[key] = value;
  }
  return out as RenderOptions & T;
}

function randomToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64url(data);
}

function base64url(data: Uint8Array): string {
  let text = "";
  for (const byte of data) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function s256(verifier: string): Promise<string> {
  if (!crypto.subtle) throw new Error(`${TAG} PKCE needs a secure page (https, or http://localhost while developing).`);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** The /authorize URL for these options. Throws when app id or redirect URI is missing. */
function authorizeUrl(options?: AuthorizeOptions): string {
  const o = merge(options);
  if (!o.appId) throw new Error(`${TAG} appId is missing. Set data-app-id on the script tag or pass { appId }.`);
  if (!o.redirectUri) throw new Error(`${TAG} redirectUri is missing. Set data-redirect-uri on the script tag or pass { redirectUri } (a callback URL registered for the app).`);
  if (o.method && !isButtonMethod(o.method)) throw new Error(`${TAG} method must be google, apple, email or phone (got "${o.method}").`);
  if (o.intent && !isButtonIntent(o.intent)) throw new Error(`${TAG} intent must be signin or signup (got "${o.intent}").`);
  const query = new URLSearchParams({ app_id: o.appId, redirect_uri: o.redirectUri, response_type: "code" });
  const add = (key: string, value: string | undefined) => {
    if (value) query.set(key, value);
  };
  add("state", o.state);
  add("code_challenge", o.codeChallenge);
  if (o.codeChallenge) add("code_challenge_method", o.codeChallengeMethod ?? "S256");
  add("scope", o.scope);
  add("nonce", o.nonce);
  add("prompt", o.prompt);
  // The sign-in page is the default: only the sign-up page needs saying.
  if (o.intent === "signup") add("intent", o.intent);
  add("method", o.method ?? undefined);
  return `${base}/authorize?${query.toString()}`;
}

/**
 * Fills in what the app left out (state, and PKCE when asked) and remembers it for the callback: JSON
 * {state, code_verifier, nonce, redirect_uri, app_id} in sessionStorage["silicon-accounts:auth:<state>"].
 */
async function prepare<T extends SignInOptions>(options?: T): Promise<RenderOptions & T> {
  const o = merge(options);
  let created = false;
  let verifier: string | null = null;
  if (!o.state) {
    o.state = randomToken();
    created = true;
  }
  if (!o.codeChallenge && (o.pkce === true || o.pkce === "S256")) {
    verifier = randomToken(48);
    o.codeChallenge = await s256(verifier);
    o.codeChallengeMethod = "S256";
    created = true;
  }
  if (created && !o.nonce && /(^|\s)openid(\s|$)/.test(o.scope ?? "")) o.nonce = randomToken(16);
  authorizeUrl(o); // Validates app id, redirect URI and method before anything is stored.
  if (created) {
    const record = { state: o.state, code_verifier: verifier, nonce: o.nonce ?? null, redirect_uri: o.redirectUri, app_id: o.appId, created_at: Date.now() };
    try {
      sessionStorage.setItem(STORAGE_PREFIX + o.state, JSON.stringify(record));
    } catch {
      // Blocked storage: the hosted flow still works; the app's callback must then trust its own state check.
      console.warn(`${TAG} sessionStorage is not available, so the state for this sign-in could not be saved.`);
    }
  }
  return o;
}

/** Sends this window to sign in. Creates the state (and PKCE when asked) and remembers them for the callback. */
async function signIn(options?: SignInOptions): Promise<void> {
  location.assign(authorizeUrl(await prepare(options)));
}

/** What the app's callback page needs to finish a sign-in this SDK started. */
export interface CallbackResult {
  /** Exchange it on the app's server: POST /v1/oauth/token with grant_type=authorization_code. */
  code: string;
  state: string;
  /** The PKCE verifier the SDK created (send it as code_verifier), or null when the app made its own. */
  codeVerifier: string | null;
  /** The OpenID Connect nonce the id_token must carry, when one was sent. */
  nonce: string | null;
  redirectUri: string | null;
  appId: string | null;
}

/** An error with a stable `code` (access_denied, login_required, not_a_callback, missing_state, unknown_state…). */
function sdkError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${TAG} ${message}`), { code });
}

/**
 * On the app's callback page: reads `?code=…&state=…` (or `?error=…`), matches the state to a sign-in this SDK
 * started in this tab, and returns the code with its PKCE verifier and nonce. The stored record is removed, so a
 * callback works once. Throws an Error with a `code` when the sign-in did not finish or the state is not ours.
 */
function handleCallback(url?: string): CallbackResult {
  const query = new URL(url ?? location.href, location.href).searchParams;
  const state = query.get("state");
  const error = query.get("error");
  if (error) {
    const description = query.get("error_description");
    throw sdkError(error, `the sign-in ended without signing in (${error}${description ? `: ${description}` : ""}).`);
  }
  const code = query.get("code");
  if (!code) throw sdkError("not_a_callback", "this address has no ?code=, so it is not the end of a sign-in.");
  if (!state) throw sdkError("missing_state", "the callback has no state, so it cannot be matched to a sign-in this browser started.");
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(STORAGE_PREFIX + state);
    sessionStorage.removeItem(STORAGE_PREFIX + state);
  } catch {
    raw = null;
  }
  let record: { state?: string; code_verifier?: string | null; nonce?: string | null; redirect_uri?: string | null; app_id?: string | null } | null = null;
  try {
    record = raw ? JSON.parse(raw) : null;
  } catch {
    record = null;
  }
  if (!record || record.state !== state) {
    throw sdkError("unknown_state", "no sign-in with this state was started in this browser tab, or it was already finished. Start the sign-in again (never reuse a callback address).");
  }
  return { code, state, codeVerifier: record.code_verifier ?? null, nonce: record.nonce ?? null, redirectUri: record.redirect_uri ?? null, appId: record.app_id ?? null };
}

export interface FrameOptions extends RenderOptions {
  /** The iframe's accessible name. */
  title?: string;
}

export interface MountedFrame {
  iframe: HTMLIFrameElement;
  /** Removes the iframe. */
  destroy(): void;
}

/**
 * Drops the embedded buttons (/embed/v1/buttons) into `target` as an iframe that sizes itself to its content. The
 * state (and PKCE when asked) is created and remembered here, because choosing a method happens inside the frame.
 * The app's origin must be in its allowed_origins, or browsers refuse to show the frame.
 */
async function mountFrame(target: Element | string, options?: FrameOptions): Promise<MountedFrame> {
  const host = typeof target === "string" ? document.querySelector(target) : target;
  if (!host) throw new Error(`${TAG} mountFrame: "${String(target)}" matches no element on this page.`);
  const o = await prepare(options);
  const query = new URL(authorizeUrl(o)).searchParams;
  if (o.theme) query.set("theme", o.theme);
  if (o.buttons && isButtonSet(o.buttons)) query.set("buttons", o.buttons);
  const iframe = document.createElement("iframe");
  iframe.src = `${base}/embed/v1/buttons?${query.toString()}`;
  iframe.title = options?.title ?? "Sign in with Silicon Accounts";
  iframe.style.cssText = "display:block;width:100%;height:60px;border:0;background:transparent";
  host.append(iframe);
  return { iframe, destroy: () => iframe.remove() };
}

/** Any frame of /embed/v1/buttons on this page follows the height it reports, also ones pasted as HTML. */
window.addEventListener("message", event => {
  const data = event.data as { type?: unknown; height?: unknown } | null;
  if (event.origin !== base || !data || data.type !== "silicon-accounts:resize" || typeof data.height !== "number" || !Number.isFinite(data.height)) return;
  for (const frame of Array.from(document.getElementsByTagName("iframe"))) {
    if (frame.contentWindow === event.source) {
      frame.style.height = `${Math.max(40, Math.min(2000, Math.ceil(data.height)))}px`;
      break;
    }
  }
});

const configs = new Map<string, Promise<PublicApp>>();

/**
 * Waits between tries of a read the browser cut off: Safari cancels a page's requests the moment it starts navigating
 * away (before pagehide), either before the answer (the fetch rejects) or after its headers (the status says 200, but
 * reading the body fails), and networks blip. Two more tries before reporting, so a page that is leaving never logs an
 * error, and a real outage still does after about two seconds.
 */
const NETWORK_RETRY_MS = [500, 1500];

type ConfigBody = (PublicApp & { error?: { code?: string; message?: string; hint?: string } }) | null;
/** One GET of the app's public config: its status and JSON body, or `cut` (with the status, if one came). */
type ConfigRead = { cut: false; ok: boolean; status: number; body: ConfigBody } | { cut: true; status: number | null };

async function readConfig(url: string): Promise<ConfigRead> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "omit" });
  } catch {
    return { cut: true, status: null };
  }
  try {
    return { cut: false, ok: response.ok, status: response.status, body: (await response.json()) as ConfigBody };
  } catch {
    return { cut: true, status: response.status };
  }
}

/** GET /v1/apps/{app_id}/public (CORS *), once per app and page. */
function loadApp(appId: string): Promise<PublicApp> {
  let pending = configs.get(appId);
  if (!pending) {
    pending = (async () => {
      const url = `${base}/v1/apps/${encodeURIComponent(appId)}/public`;
      let read = await readConfig(url);
      for (const wait of NETWORK_RETRY_MS) {
        if (!read.cut) break;
        await new Promise(done => setTimeout(done, wait));
        read = await readConfig(url);
      }
      if (read.cut) {
        throw new Error(read.status === null
          ? `${TAG} could not reach ${base}. Check the connection and that the page may load from it.`
          : `${TAG} the sign-in config of "${appId}" could not be read (HTTP ${read.status}, the answer was cut off or was not JSON). Reload the page.`);
      }
      const { ok, status, body } = read;
      if (!ok || !body || !Array.isArray(body.methods)) {
        const error = body?.error;
        throw new Error(`${TAG} ${error?.message ?? `the sign-in config of "${appId}" could not be loaded (HTTP ${status}).`}${error?.hint ? ` ${error.hint}` : ""}`);
      }
      return body;
    })();
    pending.catch(() => configs.delete(appId));
    configs.set(appId, pending);
  }
  return pending;
}

const STYLE = `
:host{display:block}
.sa,.g{display:grid;gap:var(--gap)}
.sa{--r:18px;--gap:10px;--h:48px;padding:3px;color:var(--fg);font:500 14px/1.2 var(--font);letter-spacing:-.005em;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.sa[data-density=compact]{--gap:8px;--h:44px}
.b{position:relative;box-sizing:border-box;display:flex;width:100%;min-height:var(--h);align-items:center;justify-content:center;gap:10px;margin:0;padding:0 16px;border:1px solid var(--bd);border-radius:var(--r);background:var(--sf);color:var(--fg);font:inherit;letter-spacing:inherit;white-space:nowrap;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background-color .16s,border-color .16s,box-shadow .16s,transform .12s}
.b svg{display:block;flex:none}
.b:focus-visible{outline:none}
.b:is(:hover,:focus-visible){--sf:var(--sfh);--bd:var(--bdh);box-shadow:0 1px 2px rgb(0 0 0/.06)}
.b:active{transform:scale(.985)}
.b.p{--sf:var(--pr);--bd:var(--pr);color:var(--pf)}
.b.p:is(:hover,:focus-visible){--sf:var(--prh);--bd:var(--prh)}
.sa[data-button=soft] .b.p{--sf:color-mix(in oklab,var(--pr) 14%,var(--sfc));--bd:color-mix(in oklab,var(--pr) 20%,var(--sfc));color:var(--ink)}
.sa[data-button=soft] .b.p:is(:hover,:focus-visible){--sf:color-mix(in oklab,var(--pr) 20%,var(--sfc));--bd:color-mix(in oklab,var(--pr) 28%,var(--sfc))}
.sa[data-button=outline] .b.p{--sf:transparent;--bd:var(--pr);color:var(--ink)}
.sa[data-button=outline] .b.p:is(:hover,:focus-visible){--sf:color-mix(in oklab,var(--pr) 8%,transparent)}
@supports (corner-shape:squircle){.sa[data-corner=squircle] :is(.b,.e){corner-shape:squircle;border-radius:calc(var(--r)*1.6)}}
.sa[data-corner=sharp] :is(.b,.e){border-radius:0}
.k{height:var(--h);border-radius:var(--r);background:var(--mt);animation:p 1.2s ease-in-out infinite alternate}
.e{position:relative;display:grid;gap:4px;padding:14px 16px;border:1px solid var(--bd);border-radius:var(--r);background:var(--sfc);color:var(--fg);font-weight:400;line-height:1.45;white-space:normal}
.e strong{color:var(--dg);font-weight:500}
.e span{color:var(--mu)}
[data-fb]{background:transparent!important;border-color:transparent!important;box-shadow:none!important;isolation:isolate}
[data-fb]::before,[data-fb]::after{content:"";position:absolute;inset:-1px;z-index:-1;pointer-events:none}
[data-fb]::before{background:var(--sf);clip-path:var(--p)}
.e[data-fb]::before{background:var(--sfc)}
[data-fb]::after{background:var(--bd);clip-path:var(--q)}
.w{display:flex!important;justify-self:center!important;align-items:center!important;gap:6px;min-height:26px;margin:0;padding:0 11px!important;border:1px solid #E8E3DA!important;border-radius:999px!important;background:#FFFDF9!important;color:#5E5A55!important;font:400 12px/1.4 "Geist Variable",${SANS}!important;white-space:nowrap;visibility:visible!important;opacity:1!important;transform:none!important;filter:none!important;clip-path:none!important}
@supports (corner-shape:squircle){.w{corner-shape:squircle}}
.w a{color:#353432!important;font-weight:500;text-decoration:none}
.w a:is(:hover,:focus-visible){outline:none;text-decoration:underline;text-underline-offset:.2em}
.w svg{display:block;flex:none}
.sa[data-theme=dark] .w{border-color:#4A4845!important;background:#2A2927!important;color:#C9C4BC!important}
.sa[data-theme=dark] .w a{color:#FFFDF9!important}
@keyframes p{to{opacity:.55}}
@media (prefers-reduced-motion:reduce){.b{transition:none}.b:active{transform:none}.k{animation:none}}
`;

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const POWERED = `<p class="w" data-powered-by="">${POWERED_MARK}<span>Powered by <a href="${POWERED_BY_HREF}" target="_blank" rel="noopener">Silicon Accounts</a></span></p>`;

function paletteFor(app: PublicApp | null, theme: "light" | "dark"): Palette {
  return { ...(theme === "dark" ? DARK : LIGHT), ...(app?.branding?.[theme] ?? {}) };
}

let probe: CanvasRenderingContext2D | null | undefined;

/** [r, g, b, alpha] of a computed CSS colour (rgb(), or any other syntax through a 1 px canvas); null when unreadable. */
function rgbaOf(color: string): [number, number, number, number] | null {
  const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(color);
  if (match) return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4]) / (match[5] ? 100 : 1)];
  if (!color || color === "transparent") return null;
  try {
    if (probe === undefined) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      probe = canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!probe) return null;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "rgba(0,0,0,0)";
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  } catch {
    return null;
  }
}

/** WCAG relative luminance of an sRGB colour. */
function luminance([r, g, b]: [number, number, number, number]): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * Whether the page behind the buttons is dark: the first mostly opaque background from the host element up, else
 * the canvas, whose colour follows the page's color-scheme. (Not the device's preference alone: a light page stays
 * light on a dark-mode device.) Below 0.179 luminance, white text reads better than black: that page is dark.
 */
function backdrop(host: Element, media: MediaQueryList): "light" | "dark" {
  for (let node: Element | null = host; node; node = node.parentElement) {
    const rgba = rgbaOf(getComputedStyle(node).backgroundColor);
    if (rgba && rgba[3] >= 0.5) return luminance(rgba) < 0.179 ? "dark" : "light";
  }
  const scheme = getComputedStyle(document.documentElement).colorScheme || "";
  if (!/dark/.test(scheme)) return "light";
  return /light/.test(scheme) && !media.matches ? "light" : "dark";
}

/** Paints colours, radius, font and styles of the app's branding onto the root inside the shadow. */
function paint(root: HTMLElement, host: Element, app: PublicApp | null, requested: Theme | undefined, media: MediaQueryList): void {
  const branding = app?.branding ?? {};
  const forced = requested === "light" || requested === "dark" ? requested : branding.theme === "light" || branding.theme === "dark" ? branding.theme : null;
  const theme = forced ?? backdrop(host, media);
  const p = paletteFor(app, theme);
  const mix = (a: string, percent: number, b: string) => `color-mix(in oklab,${a} ${percent}%,${b})`;
  const vars: Record<string, string> = {
    "--pr": p.primary,
    "--prh": mix(p.primary, 90, p.foreground),
    "--pf": p.primary_foreground,
    // Accent-coloured text on dark needs a lighter ink than a fill (the hosted pages' --accent-ink: 5.5:1 for the
    // default blue on the dark card).
    "--ink": theme === "dark" ? mix(p.primary, 50, p.foreground) : p.primary,
    "--sfc": p.surface,
    "--sf": p.surface,
    "--sfh": mix(p.foreground, theme === "dark" ? 9 : 5, p.surface),
    "--bd": p.border,
    "--bdh": mix(p.border, 74, p.foreground),
    "--fg": p.foreground,
    "--mu": p.muted,
    "--mt": mix(p.foreground, theme === "dark" ? 12 : 7, p.surface),
    "--dg": p.danger,
    "--r": `${Math.max(0, Math.min(40, Number(branding.radius ?? 18)))}px`,
    "--font": FONTS[branding.font_family ?? "Geist"] ?? FONTS.Geist!,
  };
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.style.colorScheme = theme;
  root.dataset.theme = theme;
  root.dataset.corner = branding.corner_style ?? "squircle";
  root.dataset.button = branding.button_style ?? "solid";
  root.dataset.density = branding.density ?? "comfortable";
}

/** True where the browser draws squircles itself (Chromium); elsewhere the SDK draws them (see `shapes`). */
const nativeSquircles = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("corner-shape", "squircle");

/**
 * A smoothed rounded rectangle (Figma's squircle construction, 60 % corner smoothing: the same shape the account site
 * draws), `w` by `h` with corner radius `radius`, offset by `o` on both axes.
 */
function squirclePath(w: number, h: number, radius: number, o = 0): string {
  const n = (value: number) => Math.round(value * 100) / 100;
  const budget = Math.min(w, h) / 2;
  const r = Math.max(0, Math.min(radius, budget));
  if (!r) return `M${n(o)} ${n(o)}h${n(w)}v${n(h)}h${n(-w)}Z`;
  let smoothing = 0.6;
  let p = (1 + smoothing) * r;
  if (p > budget) {
    smoothing = Math.max(0, Math.min(smoothing, budget / r - 1));
    p = Math.min(p, budget);
  }
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const arcMeasure = 90 * (1 - smoothing);
  const arc = Math.sin(rad(arcMeasure / 2)) * r * Math.SQRT2;
  const c = r * Math.tan(rad((90 - arcMeasure) / 4)) * Math.cos(rad(45 * smoothing));
  const d = c * Math.tan(rad(45 * smoothing));
  const b = (p - arc - c - d) / 3;
  const a = 2 * b;
  const [A, AB, ABC, BC, D, C, ARC, R] = [a, a + b, a + b + c, b + c, d, c, arc, r].map(n) as [number, number, number, number, number, number, number, number];
  return (
    `M${n(o + w - p)} ${n(o)}c${A} 0 ${AB} 0 ${ABC} ${D}a${R} ${R} 0 0 1 ${ARC} ${ARC}c${D} ${C} ${D} ${BC} ${D} ${ABC}` +
    `L${n(o + w)} ${n(o + h - p)}c0 ${A} 0 ${AB} ${-D} ${ABC}a${R} ${R} 0 0 1 ${-ARC} ${ARC}c${-C} ${D} ${-BC} ${D} ${-ABC} ${D}` +
    `L${n(o + p)} ${n(o + h)}c${-A} 0 ${-AB} 0 ${-ABC} ${-D}a${R} ${R} 0 0 1 ${-ARC} ${-ARC}c${-D} ${-C} ${-D} ${-BC} ${-D} ${-ABC}` +
    `L${n(o)} ${n(o + p)}c0 ${-A} 0 ${-AB} ${D} ${-ABC}a${R} ${R} 0 0 1 ${ARC} ${-ARC}c${C} ${-D} ${BC} ${-D} ${ABC} ${-D}Z`
  );
}

/**
 * Squircle buttons and error box where the browser cannot draw them (Safari, Firefox): the element's own fill and
 * border go transparent and two pseudo-elements paint the curve (the fill, and the 1 px ring as outer minus inner
 * path), recomputed only when the element's size changes. Returns a function that stops watching.
 */
function shapes(root: HTMLElement): () => void {
  if (nativeSquircles || typeof ResizeObserver === "undefined") return () => undefined;
  const shape = (el: HTMLElement, width: number, height: number) => {
    if (root.dataset.corner !== "squircle" || width <= 0 || height <= 0) {
      el.removeAttribute("data-fb");
      return;
    }
    const radius = parseFloat(getComputedStyle(root).getPropertyValue("--r")) || 0;
    const outer = squirclePath(width, height, radius);
    el.style.setProperty("--p", `path("${outer}")`);
    el.style.setProperty("--q", `path(evenodd,"${outer} ${squirclePath(width - 2, height - 2, Math.max(0, radius - 1), 1)}")`);
    el.setAttribute("data-fb", "");
  };
  const observer = new ResizeObserver(entries => {
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      const box = entry.borderBoxSize?.[0];
      shape(el, box ? box.inlineSize : el.offsetWidth, box ? box.blockSize : el.offsetHeight);
    }
  });
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(".b,.e"))) observer.observe(el, { box: "border-box" });
  return () => observer.disconnect();
}

let sheet: CSSStyleSheet | null = null;

/**
 * Styles for a shadow root. A constructed stylesheet is not subject to the host page's style-src policy, so the
 * buttons keep their look on sites with a strict Content-Security-Policy; older browsers get a <style> element.
 */
function adoptStyles(shadow: ShadowRoot): string {
  try {
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
    }
    shadow.adoptedStyleSheets = [sheet];
    return "";
  } catch {
    return `<style>${STYLE}</style>`;
  }
}

/** Renders the app's sign-in buttons into `target` inside a Shadow DOM. Rejects (after showing why) when it cannot. */
async function renderButtons(target: Element | string, options?: RenderOptions): Promise<RenderedButtons> {
  const host = typeof target === "string" ? document.querySelector(target) : target;
  if (!host) throw new Error(`${TAG} renderButtons: "${String(target)}" matches no element on this page.`);
  let shadow: ShadowRoot;
  try {
    shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  } catch {
    throw new Error(`${TAG} renderButtons needs a container element such as a <div> (a <${host.tagName.toLowerCase()}> cannot hold the buttons).`);
  }
  const o = merge(options);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let app: PublicApp | null = null;
  let busy = false;
  shadow.innerHTML = `${adoptStyles(shadow)}<div class="sa" part="root" aria-busy="true"><div class="k"></div></div>`;
  const root = shadow.querySelector(".sa") as HTMLElement;
  const repaint = () => paint(root, host, app, o.theme, media);
  const reset = () => {
    busy = false;
  };
  repaint();
  let unshape: () => void = () => undefined;
  const reshape = () => {
    unshape();
    unshape = shapes(root);
  };

  // "auto" follows the page: read its backdrop again once its styles have loaded, and whenever it switches theme
  // (a class or data attribute on <html> or <body>, or the device's scheme for pages that follow it).
  let frame = 0;
  const follow = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(repaint);
  };
  const watcher = typeof MutationObserver === "undefined" ? null : new MutationObserver(follow);
  for (const node of [document.documentElement, document.body]) {
    if (node) watcher?.observe(node, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-mode", "data-color-scheme"] });
  }
  if (document.readyState !== "complete") window.addEventListener("load", follow, { once: true });
  media.addEventListener("change", follow);

  const fail = (message: string, hint: string): Error => {
    root.removeAttribute("aria-busy");
    root.innerHTML = `<div class="e" role="alert"><strong>These sign-in buttons are not set up correctly</strong>${escapeHtml(message.replace(TAG, "").trim())}${hint ? `<span>${escapeHtml(hint)}</span>` : ""}</div>${POWERED}`;
    reshape();
    return new Error(`${message.startsWith(TAG) ? "" : `${TAG} `}${message}${hint ? ` ${hint}` : ""}`);
  };

  if (!o.appId) throw fail("data-app-id is missing.", 'Add data-app-id="<your app id>" to the script tag, or pass { appId }.');
  if (!o.redirectUri) throw fail("data-redirect-uri is missing.", "Add the callback URL registered for the app as data-redirect-uri, or pass { redirectUri }.");
  try {
    app = await loadApp(o.appId);
  } catch (error) {
    throw fail(error instanceof Error ? error.message : String(error), "");
  }
  if (o.buttons && !isButtonSet(o.buttons)) throw fail(`buttons must be "methods" or "intents" (got "${o.buttons}").`, 'Use data-buttons="methods" for a button per sign-in method, or "intents" for Sign in and Sign up.');
  if (o.intent && !isButtonIntent(o.intent)) throw fail(`intent must be "signin" or "signup" (got "${o.intent}").`, "");
  const intents = o.buttons === "intents";
  const methods = intents ? [] : visibleMethods(app.methods, o.method);
  repaint();
  if (!intents && methods.length === 0) {
    throw fail(o.method ? `${app.name} does not offer sign-in with "${o.method}".` : `${app.name} has no sign-in methods turned on.`, "Turn the method on in the app's sign-in setup on the developer site, or remove the method option.");
  }

  const primary = primaryMethod(methods);
  const label = o.intent === "signup" ? `Sign up for ${app.name}` : `Sign in to ${app.name}`;
  root.removeAttribute("aria-busy");
  root.innerHTML =
    `<div class="g" role="group" aria-label="${escapeHtml(intents ? app.name : label)}">` +
    (intents
      ? visibleIntents(o.intent).map((intent, index) => `<button type="button" class="b${index === 0 ? " p" : ""}" part="button" data-intent="${intent}"><span>${INTENT_LABEL[intent]}</span></button>`).join("")
      : methods.map(method => `<button type="button" class="b${method === primary ? " p" : ""}" part="button" data-method="${method}">${METHOD_MARK[method]}<span>${METHOD_LABEL[method]}</span></button>`).join("")) +
    `</div>${POWERED}`;
  reshape();
  root.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-method], button[data-intent]");
    if (!button || busy) return;
    busy = true;
    const choice: SignInOptions = button.dataset.intent
      ? { ...o, intent: button.dataset.intent as ButtonIntent, method: null }
      : { ...o, method: button.dataset.method as ButtonMethod };
    signIn(choice).catch(error => {
      busy = false;
      console.error(error instanceof Error ? error.message : error);
    });
  });
  // Coming back with the browser's back button restores this page from memory: the buttons work again.
  window.addEventListener("pageshow", reset);
  return {
    app,
    destroy() {
      media.removeEventListener("change", follow);
      window.removeEventListener("load", follow);
      window.removeEventListener("pageshow", reset);
      watcher?.disconnect();
      cancelAnimationFrame(frame);
      unshape();
      shadow.innerHTML = "";
    },
  };
}

const api = { version: __ACCOUNTS_WEB_VERSION__, authorizeUrl, signIn, renderButtons, mountFrame, handleCallback };
(window as unknown as { SiliconAccounts: typeof api }).SiliconAccounts = api;
document.dispatchEvent(new CustomEvent("silicon-accounts:ready", { detail: api }));

// The script tag's own buttons.
if (script && defaults.appId) {
  const run = () => {
    const selector = script.getAttribute("data-target");
    let host: Element | null = selector ? document.querySelector(selector) : null;
    if (selector && !host) {
      console.error(`${TAG} data-target "${selector}" matches no element on this page.`);
      return;
    }
    if (!host) {
      host = document.createElement("div");
      script.after(host);
    }
    renderButtons(host).catch(error => console.error(error instanceof Error ? error.message : error));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true });
  else run();
}
