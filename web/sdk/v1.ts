/**
 * Silicon Accounts SDK v1, served at /sdk/v1.js: one dependency-free script that renders an app's sign-in buttons and
 * sends people to the hosted sign-in pages.
 *
 *   <div id="silicon-accounts"></div>
 *   <script src="https://account.teamofsilicons.com/sdk/v1.js" data-app-id="briefcase"
 *           data-redirect-uri="https://briefcase.example/callback" data-target="#silicon-accounts" async></script>
 *
 * Script attributes (data-app-id and data-redirect-uri are required for the automatic buttons):
 *   data-target                   CSS selector of the element to render into (default: right after the script)
 *   data-state                    your state; without it the SDK creates one and keeps it in sessionStorage
 *   data-code-challenge(-method)  your PKCE challenge (S256 or plain)
 *   data-pkce="S256"              have the SDK create PKCE itself (the verifier goes to sessionStorage)
 *   data-scope, data-nonce, data-prompt, data-login-hint, data-method, data-theme (light | dark | auto)
 *
 * window.SiliconAccounts:
 *   authorizeUrl(options)          the /authorize URL for these options (no side effects; options override attributes)
 *   signIn(options)                sends this window to sign in, creating state (and PKCE when asked) if needed
 *   renderButtons(target, options) renders the app's configured buttons into target (inside a Shadow DOM)
 *
 * When the SDK creates the state or the PKCE verifier, it stores {state, code_verifier, nonce, redirect_uri, app_id}
 * as JSON in sessionStorage under "silicon-accounts:auth:<state>" before leaving the page, so the app's callback can
 * check the state and finish the code exchange. The SDK fires "silicon-accounts:ready" on document when it loads.
 */
import { METHOD_LABEL, METHOD_MARK, POWERED_BY_HREF, POWERED_MARK, isButtonMethod, primaryMethod, visibleMethods, type ButtonMethod } from "../embed/methods";

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
  loginHint?: string;
  /** Jump straight to one enabled method. */
  method?: ButtonMethod;
}

export interface SignInOptions extends AuthorizeOptions {
  /** "S256" (or true) creates a PKCE verifier and challenge when no codeChallenge is given. */
  pkce?: boolean | "S256";
}

export interface RenderOptions extends SignInOptions {
  /** Match your page: light, dark, or auto (the app's branding, else the device). */
  theme?: Theme;
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
const DARK: Palette = { primary: "#5B8FE0", primary_foreground: "#FFFDF9", background: "#2A2927", surface: "#353432", foreground: "#FFFDF9", muted: "#B5B0A8", border: "#4A4845", danger: "#F97066" };
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
  loginHint: attribute("login-hint"),
  method: attribute("method") as ButtonMethod | undefined,
  theme: attribute("theme") as Theme | undefined,
  pkce: attribute("pkce") ? attribute("pkce") !== "false" : undefined,
};

/** Defaults from the script tag, overridden by every option that is set. */
function merge<T extends object>(options: T | undefined): RenderOptions & T {
  const out: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(options ?? {})) if (value !== undefined && value !== null && value !== "") out[key] = value;
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
  add("login_hint", o.loginHint);
  add("method", o.method);
  return `${base}/authorize?${query.toString()}`;
}

/** Sends this window to sign in. Creates the state (and PKCE when asked) and remembers them for the callback. */
async function signIn(options?: SignInOptions): Promise<void> {
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
  const url = authorizeUrl(o);
  if (created) {
    const record = { state: o.state, code_verifier: verifier, nonce: o.nonce ?? null, redirect_uri: o.redirectUri, app_id: o.appId, created_at: Date.now() };
    try {
      sessionStorage.setItem(STORAGE_PREFIX + o.state, JSON.stringify(record));
    } catch {
      // Blocked storage: the hosted flow still works; the app's callback must then trust its own state check.
      console.warn(`${TAG} sessionStorage is not available, so the state for this sign-in could not be saved.`);
    }
  }
  location.assign(url);
}

const configs = new Map<string, Promise<PublicApp>>();

/** GET /v1/apps/{app_id}/public (CORS *), once per app and page. */
function loadApp(appId: string): Promise<PublicApp> {
  let pending = configs.get(appId);
  if (!pending) {
    pending = fetch(`${base}/v1/apps/${encodeURIComponent(appId)}/public`, { credentials: "omit" })
      .catch(() => {
        throw new Error(`${TAG} could not reach ${base}. Check the connection and that the page may load from it.`);
      })
      .then(async response => {
        const body = (await response.json().catch(() => null)) as (PublicApp & { error?: { code?: string; message?: string; hint?: string } }) | null;
        if (!response.ok || !body || !Array.isArray(body.methods)) {
          const error = body?.error;
          throw new Error(`${TAG} ${error?.message ?? `the sign-in config of "${appId}" could not be loaded (HTTP ${response.status}).`}${error?.hint ? ` ${error.hint}` : ""}`);
        }
        return body;
      });
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
.b{box-sizing:border-box;display:flex;width:100%;min-height:var(--h);align-items:center;justify-content:center;gap:10px;margin:0;padding:0 16px;border:1px solid var(--bd);border-radius:var(--r);background:var(--sf);color:var(--fg);font:inherit;letter-spacing:inherit;white-space:nowrap;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background-color .16s,border-color .16s,box-shadow .16s,transform .12s}
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
.e{display:grid;gap:4px;padding:14px 16px;border:1px solid var(--bd);border-radius:var(--r);background:var(--sfc);color:var(--fg);font-weight:400;line-height:1.45;white-space:normal}
.e strong{color:var(--dg);font-weight:500}
.e span{color:var(--mu)}
.w{display:flex!important;align-items:center;justify-content:center;gap:6px;margin:0;color:#5E5A55!important;font:400 12px/1.4 "Geist Variable",${SANS}!important;white-space:nowrap;visibility:visible!important;opacity:1!important}
.w a{color:#353432!important;font-weight:500;text-decoration:none}
.w a:is(:hover,:focus-visible){outline:none;text-decoration:underline;text-underline-offset:.2em}
.w svg{display:block;flex:none}
.sa[data-theme=dark] .w{color:#C9C4BC!important}
.sa[data-theme=dark] .w a{color:#FFFDF9!important}
@keyframes p{to{opacity:.55}}
@media (prefers-reduced-motion:reduce){.b{transition:none}.b:active{transform:none}.k{animation:none}}
`;

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const POWERED = `<p class="w" data-powered-by="">${POWERED_MARK}<span>Powered by <a href="${POWERED_BY_HREF}" target="_blank" rel="noopener">Silicon Accounts</a></span></p>`;

function paletteFor(app: PublicApp | null, theme: "light" | "dark"): Palette {
  return { ...(theme === "dark" ? DARK : LIGHT), ...(app?.branding?.[theme] ?? {}) };
}

/** Paints colours, radius, font and styles of the app's branding onto the root inside the shadow. */
function paint(root: HTMLElement, app: PublicApp | null, requested: Theme | undefined, media: MediaQueryList): void {
  const branding = app?.branding ?? {};
  const forced = requested === "light" || requested === "dark" ? requested : branding.theme === "light" || branding.theme === "dark" ? branding.theme : null;
  const theme = forced ?? (media.matches ? "dark" : "light");
  const p = paletteFor(app, theme);
  const mix = (a: string, percent: number, b: string) => `color-mix(in oklab,${a} ${percent}%,${b})`;
  const vars: Record<string, string> = {
    "--pr": p.primary,
    "--prh": mix(p.primary, 90, p.foreground),
    "--pf": p.primary_foreground,
    "--ink": theme === "dark" ? mix(p.primary, 80, p.foreground) : p.primary,
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
  const repaint = () => paint(root, app, o.theme, media);
  const reset = () => {
    busy = false;
  };
  repaint();

  const fail = (message: string, hint: string): Error => {
    root.removeAttribute("aria-busy");
    root.innerHTML = `<div class="e" role="alert"><strong>These sign-in buttons are not set up correctly</strong>${escapeHtml(message.replace(TAG, "").trim())}${hint ? `<span>${escapeHtml(hint)}</span>` : ""}</div>${POWERED}`;
    return new Error(`${message.startsWith(TAG) ? "" : `${TAG} `}${message}${hint ? ` ${hint}` : ""}`);
  };

  if (!o.appId) throw fail("data-app-id is missing.", 'Add data-app-id="<your app id>" to the script tag, or pass { appId }.');
  if (!o.redirectUri) throw fail("data-redirect-uri is missing.", "Add the callback URL registered for the app as data-redirect-uri, or pass { redirectUri }.");
  try {
    app = await loadApp(o.appId);
  } catch (error) {
    throw fail(error instanceof Error ? error.message : String(error), "");
  }
  const methods = visibleMethods(app.methods, o.method);
  repaint();
  media.addEventListener("change", repaint);
  if (methods.length === 0) {
    throw fail(o.method ? `${app.name} does not offer sign-in with "${o.method}".` : `${app.name} has no sign-in methods turned on.`, "Turn the method on in the app's sign-in settings, or remove the method option.");
  }

  const primary = primaryMethod(methods);
  root.removeAttribute("aria-busy");
  root.innerHTML =
    `<div class="g" role="group" aria-label="${escapeHtml(`Sign in to ${app.name}`)}">` +
    methods
      .map(method => `<button type="button" class="b${method === primary ? " p" : ""}" part="button" data-method="${method}">${METHOD_MARK[method]}<span>${METHOD_LABEL[method]}</span></button>`)
      .join("") +
    `</div>${POWERED}`;
  root.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button[data-method]");
    if (!button || busy) return;
    busy = true;
    signIn({ ...o, method: button.dataset.method as ButtonMethod }).catch(error => {
      busy = false;
      console.error(error instanceof Error ? error.message : error);
    });
  });
  // Coming back with the browser's back button restores this page from memory: the buttons work again.
  window.addEventListener("pageshow", reset);
  return {
    app,
    destroy() {
      media.removeEventListener("change", repaint);
      window.removeEventListener("pageshow", reset);
      shadow.innerHTML = "";
    },
  };
}

const api = { version: __ACCOUNTS_WEB_VERSION__, authorizeUrl, signIn, renderButtons };
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
