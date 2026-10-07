/**
 * ux-audit: the sign-in buttons an app puts on its own pages, and what a Carbon sees after pressing one.
 *
 *   handoff  "Continue with Google" or "Continue with Apple" pressed on the app's own page (its iframe buttons, or the
 *            SDK's): UNDERSTANDING.md ("Adding sign-in to an app") says we do not jump straight to Google or Apple but
 *            first open our page saying "Opening Google to sign you in to {app name}…", in the app's configured style
 *            and with "Powered by Silicon Accounts" at the bottom, and only then move on. The provider's page is held
 *            back (a route on the mock provider) so the page in between can be read and photographed, then let go.
 *   embed    the iframe buttons (/embed/v1/buttons) on the fake apps' pages, light and dark at 1440 and 390 (an app
 *            that forces a theme in that theme only): axe inside the frame, squircles, the frame as tall as what it
 *            draws, no sideways scroll, "Powered by", every button named and showing keyboard focus, nothing loaded
 *            from another machine; and the SDK's buttons (quill-docs, in a shadow root): names, "Powered by",
 *            squircles, axe over what the SDK draws.
 */
import type { Frame, Page, Route } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { json, sleep } from "../../lib";
import { KIT_SOURCE } from "./_kit";
import { auditContext, axeScript, collectConsole, drainProblems, findingsFor, forcedVariants, saveFindings, settle, tabKey, VARIANTS, type Findings, type Theme, type Variant } from "./_audit";

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface AppInfo {
  name: string;
  methods: string[];
  theme: string | null;
}

/** The app's public sign-in config: its name, methods and forced theme. */
async function appInfo(ctx: Ctx, app: string): Promise<AppInfo> {
  const answer = await json<{ name?: string; methods?: string[]; branding?: { theme?: string } }>(`${ctx.env.site}/v1/apps/${app}/public`);
  return { name: answer.body.name ?? app, methods: answer.body.methods ?? [], theme: answer.body.branding?.theme ?? null };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The page between the app's button and Google or Apple                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

interface HandoffCase {
  app: string;
  provider: "Google" | "Apple";
  /** Where the button is on the app's page: its iframe buttons or the SDK's. */
  via: "iframe" | "sdk";
  forced?: Theme;
}

const HANDOFFS: HandoffCase[] = [
  { app: "briefcase", provider: "Google", via: "iframe" },
  { app: "acme-notes", provider: "Google", via: "iframe", forced: "dark" },
  { app: "orbit-games", provider: "Apple", via: "iframe", forced: "dark" },
  { app: "quill-docs", provider: "Google", via: "sdk" },
];

/**
 * Presses the app's own button, then holds the page's request that starts Google or Apple (POST
 * /v1/flows/{id}/oauth/{provider}): while it is held, the page in between is what a Carbon sees while we open the
 * provider. (Holding the provider's page itself would freeze Playwright's view of the page: it waits for that
 * navigation before it evaluates or photographs anything.) Then the request goes on and the provider's page opens.
 */
async function handoff(ctx: Ctx, findings: Findings, entry: HandoffCase, width: number): Promise<void> {
  const { env, results, browser } = ctx;
  const info = await appInfo(ctx, entry.app);
  const theme: Theme = entry.forced ?? (width < 640 ? "dark" : "light");
  const label = `handoff ${entry.app} ${entry.provider} (${entry.via}) ${width}`;
  const context = await auditContext(browser, { width, height: width < 640 ? 844 : 900, dark: theme === "dark" });
  const page = await context.newPage();
  results.watch(page, `handoff-${entry.app}-${width}`);
  collectConsole(page);
  const provider = new URL(env.oidc).origin;
  const site = new URL(env.site).origin;
  const START = /^\/v1\/flows\/[^/]+\/oauth\/(google|apple)$/;
  const held: Route[] = [];
  const isStart = (url: URL) => url.origin === site && START.test(url.pathname);
  await context.route(isStart, route => {
    if (route.request().method() !== "POST") return void route.continue();
    held.push(route);
  });
  const startedAt = Date.now();
  let flowShownAt = 0;
  page.on("framenavigated", frame => {
    if (frame === page.mainFrame() && /\/authorize\/flow\//.test(frame.url()) && !flowShownAt) flowShownAt = Date.now();
  });
  await page.goto(`${env.apps}/${entry.app}/?theme=${theme}`);
  const button = entry.via === "iframe"
    ? page.frameLocator("#signin-iframe").getByRole("link", { name: `Continue with ${entry.provider}` })
    : page.locator("#silicon-accounts").getByRole("button", { name: `Continue with ${entry.provider}` });
  await button.click({ timeout: 30_000 });
  // The moment the page asks to start Google or Apple (held here) it shows the page in between.
  for (let i = 0; i < 150 && held.length === 0; i++) await sleep(100);
  const askedAfter = flowShownAt ? Date.now() - flowShownAt : null;
  const asked = held.length > 0;
  await sleep(700);
  const onSite = page.url().startsWith(env.site);
  const shot = `${env.shots}/uxa-handoff-${entry.app}-${entry.provider.toLowerCase()}-${width}.png`;
  await page.screenshot({ path: shot, timeout: 15_000 }).catch(() => undefined);
  const view = (await page.evaluate(`(() => {
    const main = document.querySelector("main");
    const heading = document.querySelector("main h1, main h2, [role=heading]");
    const powered = window.__uxa ? window.__uxa.poweredBy() : null;
    const paint = document.querySelector("[data-paint]");
    return {
      text: ((main && main.innerText) || "").replace(/\\s+/g, " ").trim().slice(0, 600),
      heading: heading ? heading.textContent.replace(/\\s+/g, " ").trim() : null,
      busy: Array.from(document.querySelectorAll("main button[aria-busy=true], main button[data-loading], main [data-provider][disabled], main [data-provider][aria-disabled=true]")).map(b => (b.textContent || "").trim() || b.getAttribute("aria-label") || b.getAttribute("data-provider")),
      status: Array.from(document.querySelectorAll("main [role=status], main [aria-live]")).map(n => (n.textContent || "").replace(/\\s+/g, " ").trim()).filter(Boolean),
      powered,
      paint: paint ? paint.getAttribute("data-paint") : null,
    };
  })()`).catch(() => null)) as { text: string; heading: string | null; busy: string[]; status: string[]; powered: { found: boolean; inView?: boolean; href?: string; covered?: string | null } | null; paint: string | null } | null;
  findings.pages[label] = { shot: shot.replace(`${env.shots}/`, "shots/"), asked, askedAfterMs: askedAfter, url: page.url(), ...view };
  results.check(`${label}: our page opens first and starts ${entry.provider} from there`, asked && onSite, `${asked ? `held ${held[0]?.request().method()} ${new URL(held[0]!.request().url()).pathname}` : "never asked to start the provider"}; page ${page.url().replace(env.site, "").slice(0, 60)}; started ${askedAfter ?? "?"} ms after the flow page appeared, ${Date.now() - startedAt} ms after the press`);
  const words = new RegExp(`Opening ${entry.provider} to sign you in to ${escapeRe(info.name)}`, "i");
  results.check(`${label}: it says "Opening ${entry.provider} to sign you in to ${info.name}…" (UNDERSTANDING.md, Adding sign-in to an app)`, !!view && words.test(`${view.text} ${view.status.join(" ")}`), view ? `heading "${view.heading}"; status ${JSON.stringify(view.status)}; text: ${view.text.slice(0, 300)}${view.busy.length ? `; busy: ${view.busy.join(", ")}` : ""}` : "page not readable");
  results.check(`${label}: in the app's look (${entry.forced ? `its forced ${entry.forced} theme` : `the visitor's ${theme}`}, its name on the page)`, !!view && view.paint === theme && view.text.includes(info.name), view ? `data-paint=${view.paint}; names ${info.name}: ${view.text.includes(info.name)}` : "page not readable");
  results.check(`${label}: "Powered by Silicon Accounts" is at the bottom, in view, linking to account.teamofsilicons.com`, !!view?.powered?.found && !!view.powered.inView && !view.powered.covered && /^https:\/\/account\.teamofsilicons\.com\/?$/.test(view.powered.href ?? ""), JSON.stringify(view?.powered ?? null).slice(0, 300));
  // Then Google or Apple opens.
  for (const route of held.splice(0)) await route.continue().catch(() => undefined);
  const opened = await page.waitForURL(url => url.origin === provider, { timeout: 20_000, waitUntil: "commit" }).then(() => true, () => false);
  results.check(`${label}: then ${entry.provider} opens`, opened, page.url().slice(0, 120));
  await context.unroute(isStart).catch(() => undefined);
  const problems = drainProblems(page);
  results.check(`${label}: no console errors`, problems.console.length === 0, problems.console.slice(0, 4).join(" | "));
  await context.close();
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* The embedded buttons                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  count: number;
  nodes: Array<{ target: string; html: string }>;
}

/** The kit (and axe) in a frame that addInitScript did not reach. */
async function frameKit<T>(frame: Frame, call: string): Promise<T> {
  if (!(await frame.evaluate("!!window.__uxa").catch(() => false))) await frame.evaluate(KIT_SOURCE);
  if (!(await frame.evaluate("!!window.axe").catch(() => false))) await frame.evaluate(axeScript());
  return (await frame.evaluate(`window.__uxa.${call}`)) as T;
}

const describeAxe = (list: AxeViolation[]) => list.map(entry => `${entry.impact} ${entry.id} ×${entry.count} (${entry.help}): ${entry.nodes.slice(0, 2).map(node => `${node.target} ${node.html}`).join(" | ")}`).join(" || ");

/** The pixels around a control in the frame, focused (from the keyboard) and not: whether focus shows. */
async function frameFocus(page: Page, frame: Frame, index: number): Promise<{ name: string; visible: boolean; differs: boolean | null }> {
  const box = await page.locator("#signin-iframe").boundingBox();
  const target = (await frame.evaluate(`(() => {
    const el = document.querySelectorAll("a[data-method]")[${index}];
    if (!el) return null;
    el.focus();
    const r = el.getBoundingClientRect();
    return { name: el.textContent.trim(), visible: el.matches(":focus-visible"), x: r.left, y: r.top, w: r.width, h: r.height };
  })()`)) as { name: string; visible: boolean; x: number; y: number; w: number; h: number } | null;
  if (!box || !target) return { name: target?.name ?? "?", visible: false, differs: null };
  await sleep(300);
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  const x = Math.max(0, box.x + target.x - 10);
  const y = Math.max(0, box.y + target.y - 10);
  const clip = { x, y, width: Math.min(viewport.width - x, target.w + 20), height: Math.min(viewport.height - y, target.h + 20) };
  const focused = await page.screenshot({ clip, animations: "disabled" }).catch(() => null);
  await frame.evaluate(`document.activeElement && document.activeElement.blur()`);
  await sleep(300);
  const rest = await page.screenshot({ clip, animations: "disabled" }).catch(() => null);
  return { name: target.name, visible: target.visible, differs: focused && rest ? !focused.equals(rest) : null };
}

interface EmbedCase {
  app: string;
  forced?: Theme;
}

const EMBEDS: EmbedCase[] = [{ app: "briefcase" }, { app: "pixel-studio", forced: "light" }, { app: "orbit-games", forced: "dark" }];

async function auditEmbed(ctx: Ctx, findings: Findings, entry: EmbedCase, variant: Variant): Promise<void> {
  const { env, results, browser } = ctx;
  const info = await appInfo(ctx, entry.app);
  const label = `embed ${entry.app} ${variant.key}`;
  const context = await auditContext(browser, { width: variant.width, height: variant.height, dark: variant.theme === "dark" });
  const page = await context.newPage();
  results.watch(page, `embed-${entry.app}-${variant.key}`);
  collectConsole(page);
  const away: string[] = [];
  page.on("request", request => {
    if (request.frame() === page.mainFrame()) return;
    const host = new URL(request.url()).host;
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) && !request.url().startsWith("data:")) away.push(request.url().slice(0, 100));
  });
  await page.goto(`${env.apps}/${entry.app}/?theme=${variant.theme}`);
  const element = page.locator("#signin-iframe");
  await element.scrollIntoViewIfNeeded();
  const frame = await (await element.elementHandle())?.contentFrame();
  if (!frame) {
    results.check(`${label}: the app's page frames the buttons`, false, "no #signin-iframe frame");
    await context.close();
    return;
  }
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    ready = (await frame.evaluate(`!!document.querySelector("main[data-ready]")`).catch(() => false)) === true;
    if (!ready) await sleep(200);
  }
  await settle(page, 600);
  await element.scrollIntoViewIfNeeded();
  await sleep(300);
  const shot = `${env.shots}/uxa-embed-${entry.app}-${variant.key}.png`;
  await element.screenshot({ path: shot }).catch(() => undefined);

  const names = (await frame.evaluate(`Array.from(document.querySelectorAll("a[data-method]")).map(a => a.textContent.trim())`)) as string[];
  const expectedNames = info.methods.map(method => `Continue with ${method === "email" ? "email" : method === "phone" ? "phone" : method[0]!.toUpperCase() + method.slice(1)}`);
  results.check(`${label}: renders one named button per method of the app (${info.methods.join(", ")})`, ready && names.length === info.methods.length && names.every(name => /^Continue with \S/.test(name)), `${names.join(" | ") || "(none)"}; expected about ${expectedNames.join(" | ")}`);

  const fit = (await frame.evaluate(`({ scroll: document.documentElement.scrollHeight, client: document.documentElement.clientHeight, wide: document.documentElement.scrollWidth, width: document.documentElement.clientWidth })`)) as { scroll: number; client: number; wide: number; width: number };
  results.check(`${label}: the frame is as tall as what it draws (nothing cut off, no scrollbar inside the app's page)`, fit.scroll <= fit.client + 1, `content ${fit.scroll}px, frame ${fit.client}px`);
  results.check(`${label}: no sideways scroll inside the frame`, fit.wide <= fit.width + 1, `content ${fit.wide}px, frame ${fit.width}px`);

  const axe = await frameKit<{ violations?: AxeViolation[]; error?: string }>(frame, `axe({})`);
  const severe = (axe.violations ?? []).filter(item => item.impact === "serious" || item.impact === "critical");
  results.check(`${label}: axe finds no serious or critical violations inside the frame`, !axe.error && severe.length === 0, axe.error ?? (describeAxe(severe) || `${axe.violations?.length ?? 0} lesser: ${(axe.violations ?? []).map(item => `${item.impact} ${item.id}`).join(", ") || "none"}`));

  const squircles = await frameKit<{ native: boolean; checked: number; marked: number; violations: Array<{ el: string; w: number; h: number; radius: string; primary: boolean }>; nativeMismatch: Array<{ el: string; shape: string }> }>(frame, "squircles()");
  const primary = squircles.violations.filter(item => item.primary);
  results.check(`${label}: every primary rounded surface in the frame is a squircle`, primary.length === 0 && squircles.nativeMismatch.length === 0, `${squircles.checked} rounded, ${squircles.marked} squircles${primary.length ? `; not: ${primary.map(item => `${item.el} r=${item.radius}`).join("; ")}` : ""}${squircles.nativeMismatch.length ? `; drawn round: ${squircles.nativeMismatch.map(item => item.el).join("; ")}` : ""}`);

  const powered = await frameKit<{ found: boolean; inView?: boolean; visible?: boolean; covered?: string | null; overlaps?: string[]; href?: string; text?: string }>(frame, "poweredBy()");
  results.check(`${label}: "Powered by Silicon Accounts" shows in the frame, uncovered, linking to account.teamofsilicons.com`, powered.found && !!powered.visible && !!powered.inView && !powered.covered && !powered.overlaps?.length && /^https:\/\/account\.teamofsilicons\.com\/?$/.test(powered.href ?? ""), JSON.stringify(powered).slice(0, 300));

  const words = await frameKit<string>(frame, "words()");
  const banned = words.replace(/teamofsilicons/gi, " ").match(/\b(org|orgs|organi[sz]ations?|teams?|workspaces?|humans?|users?)\b/gi) ?? [];
  results.check(`${label}: vocabulary (no org, team, workspace, human or user words)`, banned.length === 0, banned.join(", "));

  // Keyboard: Tab from the app's page reaches the buttons in the frame, and each shows focus.
  await page.mouse.move(0, 0);
  await page.evaluate("(() => { document.body.setAttribute('tabindex', '-1'); document.body.focus(); document.body.removeAttribute('tabindex'); })()");
  let reached = false;
  for (let i = 0; i < 25 && !reached; i++) {
    await page.keyboard.press(tabKey(env));
    await sleep(120);
    reached = (await frame.evaluate(`document.hasFocus() && !!document.activeElement && document.activeElement.matches("a[data-method]")`).catch(() => false)) === true;
  }
  results.check(`${label}: Tab from the app's page reaches the buttons inside the frame`, reached);
  if (reached) {
    const stops: Array<{ name: string; visible: boolean; differs: boolean | null }> = [];
    for (let index = 0; index < names.length; index++) stops.push(await frameFocus(page, frame, index));
    findings.pages[`${label} focus`] = stops;
    const unseen = stops.filter(stop => stop.differs === false);
    results.check(`${label}: every button in the frame shows keyboard focus (WCAG 2.4.7)`, unseen.length === 0 && stops.every(stop => stop.differs !== null), stops.map(stop => `${stop.name}: ${stop.differs === null ? "unmeasured" : stop.differs ? "shows" : "no change"}${stop.visible ? "" : " (not :focus-visible)"}`).join("; "));
  }

  const problems = drainProblems(page);
  results.check(`${label}: no console errors`, problems.console.length === 0, problems.console.slice(0, 4).join(" | "));
  results.check(`${label}: nothing the frame loads leaves this machine`, away.length === 0, away.slice(0, 4).join(" | "));
  findings.pages[label] = { shot: shot.replace(`${env.shots}/`, "shots/"), names, fit, axe: axe.violations, squircles: { ...squircles, violations: squircles.violations.slice(0, 10) }, powered };
  await context.close();
}

/** The SDK's buttons on quill-docs (its main integration), drawn in a shadow root on the app's page. */
async function auditSdk(ctx: Ctx, findings: Findings, variant: Variant): Promise<void> {
  const { env, results, browser } = ctx;
  const info = await appInfo(ctx, "quill-docs");
  const label = `sdk quill-docs ${variant.key}`;
  const context = await auditContext(browser, { width: variant.width, height: variant.height, dark: variant.theme === "dark" });
  const page = await context.newPage();
  results.watch(page, `sdk-${variant.key}`);
  collectConsole(page);
  await page.goto(`${env.apps}/quill-docs/?theme=${variant.theme}`);
  const mount = page.locator("#silicon-accounts");
  await mount.getByRole("button").first().waitFor({ timeout: 20_000 }).catch(() => undefined);
  await settle(page, 500);
  await mount.scrollIntoViewIfNeeded();
  const shot = `${env.shots}/uxa-sdk-quill-docs-${variant.key}.png`;
  await mount.screenshot({ path: shot }).catch(() => undefined);
  const names = await mount.getByRole("button").allInnerTexts();
  results.check(`${label}: the SDK draws one named button per method (${info.methods.join(", ")})`, names.length === info.methods.length && names.every(name => /^Continue with \S/.test(name.trim())), names.join(" | "));
  const view = (await page.evaluate(`(() => {
    const root = document.querySelector("#silicon-accounts").shadowRoot;
    if (!root) return null;
    const link = Array.from(root.querySelectorAll("a")).find(a => /Silicon Accounts/.test(a.textContent || ""));
    const shapes = Array.from(root.querySelectorAll("button, [data-powered-by], .w")).map(el => {
      const s = getComputedStyle(el);
      return { el: el.tagName.toLowerCase() + "." + (el.getAttribute("class") || ""), radius: s.borderTopLeftRadius, shape: (s.getPropertyValue("corner-top-left-shape") || s.getPropertyValue("corner-shape") || "").trim() };
    });
    const host = document.querySelector("#silicon-accounts").getBoundingClientRect();
    return { href: link ? link.getAttribute("href") : null, powered: link ? (link.parentElement || link).textContent.trim() : null, shapes, native: CSS.supports("corner-shape", "squircle"), overflow: Math.round(host.right) > document.documentElement.clientWidth };
  })()`)) as { href: string | null; powered: string | null; shapes: Array<{ el: string; radius: string; shape: string }>; native: boolean; overflow: boolean } | null;
  results.check(`${label}: "Powered by Silicon Accounts" under the buttons links to account.teamofsilicons.com`, !!view && /Powered by/.test(view.powered ?? "") && /^https:\/\/account\.teamofsilicons\.com\/?$/.test(view.href ?? ""), JSON.stringify(view ? { href: view.href, powered: view.powered } : null));
  const round = (view?.shapes ?? []).filter(shape => parseFloat(shape.radius) >= 2 && view?.native && !/squircle|superellipse\(2\)/.test(shape.shape));
  results.check(`${label}: the SDK's buttons and pill are squircles (native corner-shape)`, !!view && round.length === 0, `${view?.shapes.length ?? 0} shapes${round.length ? `; drawn round: ${round.map(shape => `${shape.el} r=${shape.radius} shape=${shape.shape || "none"}`).join("; ")}` : ""}`);
  results.check(`${label}: the buttons fit the page's width (no sideways scroll)`, !!view && !view.overflow);
  // axe over the whole page, judged only on what the SDK drew (the app's page is the app's).
  const axe = (await page.evaluate(`window.__uxa.axe({})`)) as { violations?: AxeViolation[]; error?: string };
  const ours = (axe.violations ?? []).map(item => ({ ...item, nodes: item.nodes.filter(node => /silicon-accounts/.test(node.target)) })).filter(item => item.nodes.length && (item.impact === "serious" || item.impact === "critical"));
  results.check(`${label}: axe finds no serious or critical violations in what the SDK draws`, !axe.error && ours.length === 0, axe.error ?? (describeAxe(ours) || "none"));
  const problems = drainProblems(page);
  results.check(`${label}: no console errors`, problems.console.length === 0, problems.console.slice(0, 4).join(" | "));
  findings.pages[label] = { shot: shot.replace(`${env.shots}/`, "shots/"), names, view, axe: ours };
  await context.close();
}

export const journeys: Journey[] = [
  {
    name: "ux-audit-provider-handoff",
    title: "Continue with Google/Apple on the app's own page (iframe buttons, SDK): our page says \"Opening Google to sign you in to {app}…\" in the app's look with Powered by, then the provider opens — 1440 and 390",
    async run(ctx) {
      const findings = findingsFor(ctx);
      for (const entry of HANDOFFS) for (const width of [1440, 390]) await handoff(ctx, findings, entry, width);
      ctx.results.check("handoff: findings saved", true, saveFindings(ctx, findings));
    },
  },
  {
    name: "ux-audit-embed",
    title: "the iframe buttons on briefcase, pixel-studio and orbit-games (light/dark × 1440/390, forced themes alone) and the SDK's buttons on quill-docs: axe, squircles, fit, Powered by, names, keyboard focus",
    timeoutMs: 900_000,
    async run(ctx) {
      const findings = findingsFor(ctx);
      for (const entry of EMBEDS) for (const variant of entry.forced ? forcedVariants(entry.forced) : VARIANTS) await auditEmbed(ctx, findings, entry, variant);
      for (const variant of VARIANTS) await auditSdk(ctx, findings, variant);
      ctx.results.check("embed: findings saved", true, saveFindings(ctx, findings));
    },
  },
];
