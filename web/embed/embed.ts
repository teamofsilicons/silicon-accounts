/**
 * The embedded sign-in buttons, served at `/embed/v1/buttons` for apps to put in an iframe:
 *
 *   <iframe src="https://account.teamofsilicons.com/embed/v1/buttons?app_id=briefcase
 *     &redirect_uri=https%3A%2F%2Fbriefcase.example%2Fcallback&state=…&code_challenge=…&code_challenge_method=S256
 *     &theme=light" title="Sign in with Silicon Accounts" style="border:0;width:100%"></iframe>
 *
 * The page reads the authorize parameters from its own query, loads the app's public sign-in config
 * (GET /v1/apps/{app_id}/public) and renders one button per enabled method in the app's branding. Each button is a
 * plain link with target=_top, so choosing a method takes the whole window to /authorize?…&method=<method>. The page
 * reports its height to the parent as {type: "silicon-accounts:resize", height} so the iframe can fit it exactly.
 * A broken embed URL or app shows a configuration error inside the frame, in the server's own words.
 *
 * The server sends `frame-ancestors 'self' <the app's allowed_origins>` with this page, so other sites cannot frame
 * it. `theme` (light | dark | auto) should match the app's page; without it the app's branding or the device decides.
 */
import "@fontsource-variable/geist/index.css";
import "../src/arc/foundation.css";
import "../src/styles/tokens.css";
import "../src/arc/lib/squircle.css";
import "../src/branding/branding.css";
import "./embed.css";
import type { AppPublic } from "../src/api/types";
import { attachSquircle } from "../src/arc/lib/squircle-core";
import { applyBranding, resolveBrandTheme, type PaintTheme } from "../src/branding/apply";
import { normalizeBranding } from "../src/branding/defaults";
import { loadBrandingFonts } from "../src/branding/fonts";
import { AUTHORIZE_PARAMS, METHOD_LABEL, METHOD_MARK, POWERED_BY_HREF, POWERED_MARK, primaryMethod, visibleMethods, type ButtonMethod } from "./methods";

const root = document.getElementById("silicon-accounts-embed") as HTMLElement;
const query = new URLSearchParams(location.search);
const appId = (query.get("app_id") ?? query.get("client_id") ?? "").trim();
const redirectUri = (query.get("redirect_uri") ?? "").trim();
const themeParam = query.get("theme");
const onlyMethod = query.get("method");
const framed = window.parent !== window;
const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");

/** The app's page theme wins (it knows what surrounds the frame), then the branding's forced theme, then the device. */
function paintTheme(app: AppPublic | null): PaintTheme {
  if (themeParam === "light" || themeParam === "dark") return themeParam;
  return resolveBrandTheme(app?.branding?.theme, darkMedia.matches ? "dark" : "light");
}

/** Matches the frame's canvas to the theme, so a light page never gets a dark backdrop (or the reverse). */
function paintDocument(theme: PaintTheme): void {
  const html = document.documentElement;
  html.setAttribute("data-theme", theme);
  html.style.colorScheme = theme;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

/** Trusted, static SVG markup (methods.ts) as a node. */
function mark(svg: string): Element {
  const holder = document.createElement("span");
  holder.innerHTML = svg;
  return holder.firstElementChild ?? holder;
}

/** The /authorize URL for one method: the embed's own authorize parameters plus `method`. */
function authorizeHref(method: ButtonMethod): string {
  const params = new URLSearchParams();
  for (const key of AUTHORIZE_PARAMS) {
    const value = query.get(key);
    if (value) params.set(key, value);
  }
  params.set("method", method);
  return `${location.origin}/authorize?${params.toString()}`;
}

function poweredBy(theme: PaintTheme): HTMLElement {
  const link = element("a", { href: POWERED_BY_HREF, target: "_blank", rel: "noopener" }, "Silicon Accounts");
  return element("p", { class: "embed-powered", "data-powered-by": "", "data-tone": theme }, mark(POWERED_MARK), element("span", {}, "Powered by ", link));
}

interface Problem {
  code: string;
  message: string;
  hint?: string | null;
}

/**
 * GET /v1/apps/{app_id}/public. A plain fetch rather than the account site's API client keeps this page small; errors
 * keep the server's own code, message and hint.
 */
async function loadApp(id: string): Promise<AppPublic> {
  let response: Response;
  try {
    response = await fetch(`/v1/apps/${encodeURIComponent(id)}/public`, { headers: { Accept: "application/json" } });
  } catch {
    throw { code: "network_error", message: "Silicon Accounts could not be reached.", hint: "Check the connection, then reload the page." } satisfies Problem;
  }
  const body = (await response.json().catch(() => null)) as (AppPublic & { error?: Partial<Problem> }) | null;
  if (response.ok && body && Array.isArray(body.methods)) return body;
  const error = body?.error;
  throw {
    code: error?.code ?? `http_${response.status}`,
    message: error?.message ?? `The sign-in config of "${id}" could not be loaded (HTTP ${response.status}).`,
    hint: error?.hint ?? "Reload the page. If it keeps happening, check the app's status in Developer.",
  } satisfies Problem;
}

const asProblem = (raw: unknown): Problem =>
  raw && typeof raw === "object" && "code" in raw && "message" in raw
    ? (raw as Problem)
    : { code: "embed_error", message: `The sign-in buttons failed to load: ${raw instanceof Error ? raw.message : String(raw)}`, hint: "Reload the page." };

let lastHeight = -1;
function reportHeight(): void {
  if (!framed) return;
  const height = Math.ceil(root.getBoundingClientRect().height);
  if (height === lastHeight) return;
  lastHeight = height;
  // The height is not a secret and the embedding origin is already limited by frame-ancestors.
  window.parent.postMessage({ type: "silicon-accounts:resize", height }, "*");
}

function renderButtons(app: AppPublic, methods: ButtonMethod[], theme: PaintTheme): void {
  const primary = primaryMethod(methods);
  const group = element("div", { class: "embed-buttons", role: "group", "aria-label": `Sign in to ${app.name}` });
  for (const method of methods) {
    const link = element(
      "a",
      { class: "embed-button", href: authorizeHref(method), target: "_top", "data-method": method, "data-variant": method === primary ? "primary" : "secondary" },
      mark(METHOD_MARK[method]),
      element("span", {}, METHOD_LABEL[method]),
    );
    attachSquircle(link);
    group.append(link);
  }
  root.replaceChildren(group, poweredBy(theme));
  root.removeAttribute("aria-busy");
  root.setAttribute("data-ready", "");
}

function renderProblem(problem: Problem, theme: PaintTheme): void {
  const box = element(
    "div",
    { class: "embed-problem", role: "alert", "data-error-code": problem.code },
    element("strong", {}, "These sign-in buttons are not set up correctly"),
    element("p", {}, problem.message),
  );
  if (problem.hint) box.append(element("p", { class: "embed-hint" }, problem.hint));
  box.append(element("code", {}, problem.code));
  attachSquircle(box);
  root.replaceChildren(box, poweredBy(theme));
  root.removeAttribute("aria-busy");
  root.setAttribute("data-ready", "");
  // Developers integrating the embed read the console too.
  console.error(`Silicon Accounts embed: ${problem.message}${problem.hint ? ` ${problem.hint}` : ""} (${problem.code})`);
}

async function start(): Promise<void> {
  paintDocument(paintTheme(null));
  if (!appId) {
    renderProblem({ code: "missing_app_id", message: "The embed URL has no app_id.", hint: "Add app_id=<your app id> to the iframe src. Your app's Embed tab in Developer has the exact snippet." }, paintTheme(null));
    return;
  }
  if (!redirectUri) {
    renderProblem({ code: "missing_redirect_uri", message: "The embed URL has no redirect_uri.", hint: "Add redirect_uri=<a callback URL registered for the app>, URL-encoded." }, paintTheme(null));
    return;
  }

  let app: AppPublic;
  try {
    app = await loadApp(appId);
  } catch (raw) {
    renderProblem(asProblem(raw), paintTheme(null));
    return;
  }

  const methods = visibleMethods(app.methods, onlyMethod);
  const paint = () => {
    const theme = paintTheme(app);
    paintDocument(theme);
    applyBranding(root, app.branding, theme);
    return theme;
  };
  root.classList.add("sa-brand");
  const theme = paint();
  await loadBrandingFonts(normalizeBranding(app.branding));

  if (methods.length === 0) {
    renderProblem(
      onlyMethod
        ? { code: "method_not_enabled", message: `${app.name} does not offer sign-in with "${onlyMethod}".`, hint: "Remove method= from the embed URL, or turn that method on in the app's sign-in settings." }
        : { code: "no_methods", message: `${app.name} has no sign-in methods turned on.`, hint: "Turn on at least one method in the app's sign-in settings." },
      theme,
    );
    return;
  }
  renderButtons(app, methods, theme);

  // Follow the device theme while neither the app's page nor its branding picks one.
  darkMedia.addEventListener("change", () => {
    const next = paint();
    root.querySelector(".embed-powered")?.setAttribute("data-tone", next);
  });
}

if (typeof ResizeObserver !== "undefined") new ResizeObserver(reportHeight).observe(root);
start()
  .catch(raw => renderProblem(asProblem(raw), paintTheme(null)))
  .finally(reportHeight);
