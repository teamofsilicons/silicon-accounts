/**
 * ux-audit: the sign-in buttons an app puts on its own pages (UNDERSTANDING.md "Adding sign-in to an app"):
 *
 *   embed    the iframe buttons (/embed/v1/buttons) on the fake apps' pages, light and dark at 1440 and 390 (an app
 *            that forces a theme in that theme only): axe inside the frame, squircles, the frame as tall as what it
 *            draws, no sideways scroll, "Powered by", every button named and showing keyboard focus, nothing loaded
 *            from another machine; and the SDK's buttons (quill-docs, in a shadow root): names, "Powered by",
 *            squircles, axe over what the SDK draws
 *   intents  "Sign in" and "Sign up" instead of method buttons (build spec 06-v2 §5): the iframe with buttons=intents
 *            and the SDK with data-buttons="intents" on a page of briefcase's allowed origin; "Sign up" opens the
 *            sign-up version of the hosted page
 */
import type { Frame, Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { hostedTitle, json, sleep } from "../../lib";
import { KIT_SOURCE } from "./_kit";
import { POWERED_HREF, VARIANTS, auditContext, axeScript, collectConsole, drainProblems, findingsFor, forcedVariants, saveFindings, settle, tabKey, type Findings, type Theme, type Variant } from "./_audit";

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
async function frameFocus(page: Page, frameSelector: string, frame: Frame, selector: string, index: number): Promise<{ name: string; visible: boolean; differs: boolean | null }> {
  const box = await page.locator(frameSelector).boundingBox();
  const target = (await frame.evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
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

/** The audit of the buttons inside one frame (the iframe on an app's page). */
async function auditFrame(ctx: Ctx, findings: Findings, page: Page, frameSelector: string, label: string, expectedNames: RegExp[], shotName: string): Promise<void> {
  const { env, results } = ctx;
  const element = page.locator(frameSelector);
  await element.scrollIntoViewIfNeeded();
  const frame = await (await element.elementHandle())?.contentFrame();
  if (!frame) {
    results.check(`${label}: the app's page frames the buttons`, false, `no ${frameSelector} frame`);
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
  await element.screenshot({ path: `${env.shots}/${shotName}.png` }).catch(() => undefined);

  const selector = "a[data-method], a[data-intent]";
  const names = (await frame.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(a => a.textContent.trim())`)) as string[];
  results.check(`${label}: renders one named button each (${expectedNames.map(name => name.source).join(", ")})`, ready && names.length === expectedNames.length && expectedNames.every((name, index) => name.test(names[index] ?? "")), `${names.join(" | ") || "(none)"}`);

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
  results.check(`${label}: "Powered by Silicon Accounts" shows in the frame, uncovered, linking to accounts.teamofsilicons.com`, powered.found && !!powered.visible && !!powered.inView && !powered.covered && !powered.overlaps?.length && POWERED_HREF.test(powered.href ?? ""), JSON.stringify(powered).slice(0, 300));

  const words = await frameKit<string>(frame, "words()");
  const banned = words.replace(/teamofsilicons/gi, " ").match(/\b(org|orgs|organi[sz]ations?|teams?|workspaces?|humans?|users?)\b/gi) ?? [];
  results.check(`${label}: vocabulary (no org, team, workspace, human or user words)`, banned.length === 0, banned.join(", "));

  // Keyboard: Tab from the app's page reaches the buttons in the frame, and each shows focus.
  await page.mouse.move(0, 0);
  await page.evaluate("(() => { document.body.setAttribute('tabindex', '-1'); document.body.focus(); document.body.removeAttribute('tabindex'); })()");
  let reached = false;
  for (let i = 0; i < 30 && !reached; i++) {
    await page.keyboard.press(tabKey(env));
    await sleep(120);
    reached = (await frame.evaluate(`document.hasFocus() && !!document.activeElement && document.activeElement.matches(${JSON.stringify(selector)})`).catch(() => false)) === true;
  }
  results.check(`${label}: Tab from the app's page reaches the buttons inside the frame`, reached);
  if (reached) {
    const stops: Array<{ name: string; visible: boolean; differs: boolean | null }> = [];
    for (let index = 0; index < names.length; index++) stops.push(await frameFocus(page, frameSelector, frame, selector, index));
    findings.pages[`${label} focus`] = stops;
    const unseen = stops.filter(stop => stop.differs === false);
    results.check(`${label}: every button in the frame shows keyboard focus (WCAG 2.4.7)`, unseen.length === 0 && stops.every(stop => stop.differs !== null), stops.map(stop => `${stop.name}: ${stop.differs === null ? "unmeasured" : stop.differs ? "shows" : "no change"}${stop.visible ? "" : " (not :focus-visible)"}`).join("; "));
  }
  findings.pages[label] = { shot: `shots/${shotName}.png`, names, fit, axe: axe.violations, squircles: { ...squircles, violations: squircles.violations.slice(0, 10) }, powered };
}

const METHOD_NAME: Record<string, RegExp> = {
  google: /^Continue with Google$/,
  apple: /^Continue with Apple$/,
  email: /^Continue with email$/,
  phone: /^Continue with phone number$/,
};

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
  await auditFrame(ctx, findings, page, "#signin-iframe", label, info.methods.map(method => METHOD_NAME[method] ?? new RegExp(`^Continue with ${method}$`, "i")), `uxa-embed-${entry.app}-${variant.key}`);
  const problems = drainProblems(page);
  results.check(`${label}: no console errors`, problems.console.length === 0, problems.console.slice(0, 4).join(" | "));
  results.check(`${label}: nothing the frame loads leaves this machine`, away.length === 0, away.slice(0, 4).join(" | "));
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
  const names = (await mount.getByRole("button").allInnerTexts()).map(name => name.trim());
  const expected = info.methods.map(method => METHOD_NAME[method] ?? /^Continue with /);
  results.check(`${label}: the SDK draws one named button per method (${info.methods.join(", ")})`, names.length === expected.length && expected.every((name, index) => name.test(names[index] ?? "")), names.join(" | "));
  await sdkLook(ctx, findings, page, "#silicon-accounts", label, shot, names);
  const problems = drainProblems(page);
  results.check(`${label}: no console errors`, problems.console.length === 0, problems.console.slice(0, 4).join(" | "));
  await context.close();
}

/** Powered by, squircles, width and axe of what the SDK drew in `mount`'s shadow root. */
async function sdkLook(ctx: Ctx, findings: Findings, page: Page, mount: string, label: string, shot: string, names: string[]): Promise<void> {
  const { env, results } = ctx;
  const view = (await page.evaluate(`(() => {
    const host = document.querySelector(${JSON.stringify(mount)});
    const root = host && host.shadowRoot;
    if (!root) return null;
    const link = Array.from(root.querySelectorAll("a")).find(a => /Silicon Accounts/.test(a.textContent || ""));
    const shapes = Array.from(root.querySelectorAll("button, [data-powered-by], .w")).map(el => {
      const s = getComputedStyle(el);
      return { el: el.tagName.toLowerCase() + "." + (el.getAttribute("class") || ""), radius: s.borderTopLeftRadius, shape: (s.getPropertyValue("corner-top-left-shape") || s.getPropertyValue("corner-shape") || "").trim() };
    });
    const box = host.getBoundingClientRect();
    return { href: link ? link.getAttribute("href") : null, powered: link ? (link.parentElement || link).textContent.trim() : null, shapes, native: CSS.supports("corner-shape", "squircle"), overflow: Math.round(box.right) > document.documentElement.clientWidth };
  })()`)) as { href: string | null; powered: string | null; shapes: Array<{ el: string; radius: string; shape: string }>; native: boolean; overflow: boolean } | null;
  results.check(`${label}: "Powered by Silicon Accounts" under the buttons links to accounts.teamofsilicons.com`, !!view && /Powered by/.test(view.powered ?? "") && POWERED_HREF.test(view.href ?? ""), JSON.stringify(view ? { href: view.href, powered: view.powered } : null));
  const round = (view?.shapes ?? []).filter(shape => parseFloat(shape.radius) >= 2 && view?.native && !/squircle|superellipse\(2\)/.test(shape.shape));
  results.check(`${label}: the SDK's buttons and pill are squircles (native corner-shape)`, !!view && round.length === 0, `${view?.shapes.length ?? 0} shapes${round.length ? `; drawn round: ${round.map(shape => `${shape.el} r=${shape.radius} shape=${shape.shape || "none"}`).join("; ")}` : ""}`);
  results.check(`${label}: the buttons fit the page's width (no sideways scroll)`, !!view && !view.overflow);
  // axe over the whole page, judged only on what the SDK drew (the app's page is the app's).
  const axe = (await page.evaluate(`window.__uxa.axe({})`)) as { violations?: AxeViolation[]; error?: string };
  const host = mount.replace(/^#/, "");
  const ours = (axe.violations ?? []).map(item => ({ ...item, nodes: item.nodes.filter(node => node.target.includes(host)) })).filter(item => item.nodes.length && (item.impact === "serious" || item.impact === "critical"));
  results.check(`${label}: axe finds no serious or critical violations in what the SDK draws`, !axe.error && ours.length === 0, axe.error ?? (describeAxe(ours) || "none"));
  findings.pages[label] = { shot: shot.replace(`${env.shots}/`, "shots/"), names, view, axe: ours };
}

/**
 * A page on briefcase's allowed origin (the fake apps' origin, answered by the browser itself: the testkit serves no
 * such page) with "Sign in" / "Sign up" buttons: the iframe with buttons=intents and the SDK with data-buttons="intents".
 */
async function auditIntents(ctx: Ctx, findings: Findings, variant: Variant): Promise<void> {
  const { env, results, browser } = ctx;
  const label = `intents briefcase ${variant.key}`;
  const context = await auditContext(browser, { width: variant.width, height: variant.height, dark: variant.theme === "dark" });
  const page = await context.newPage();
  results.watch(page, `intents-${variant.key}`);
  collectConsole(page);
  // The embed address from briefcase's own page (its state and PKCE), with buttons=intents.
  await page.goto(`${env.apps}/briefcase/?theme=${variant.theme}`);
  const src = new URL((await page.locator("#signin-iframe").getAttribute("src")) ?? "", env.site);
  src.searchParams.set("buttons", "intents");
  const redirect = `${env.apps}/briefcase/callback`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Briefcase: intents</title>
<style>body{font:16px system-ui;margin:24px;max-width:560px;color-scheme:${variant.theme}}iframe{width:100%;border:0;display:block;min-height:96px}</style></head>
<body><main><h1>Briefcase</h1>
<section><h2>Embedded buttons</h2><iframe id="intents-iframe" title="Sign in with Silicon Accounts" src="${src.href.replace(/"/g, "&quot;")}"></iframe></section>
<section><h2>SDK</h2><div id="sdk-intents"></div>
<script src="${env.site}/sdk/v1.js" data-app-id="briefcase" data-redirect-uri="${redirect}" data-target="#sdk-intents" data-buttons="intents" data-pkce="S256" data-theme="${variant.theme}" async></script></section></main>
<script>window.addEventListener("message", e => { if (e.data && e.data.type === "silicon-accounts:resize") document.getElementById("intents-iframe").style.height = Math.max(48, Math.ceil(e.data.height)) + "px"; });</script>
</body></html>`;
  const address = `${env.apps}/briefcase/uxa-intents`;
  await page.route(address, route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
  await page.goto(address);
  await auditFrame(ctx, findings, page, "#intents-iframe", `${label} iframe`, [/^Sign in$/, /^Sign up$/], `uxa-intents-iframe-${variant.key}`);
  const mount = page.locator("#sdk-intents");
  await mount.getByRole("button").first().waitFor({ timeout: 20_000 }).catch(() => undefined);
  await settle(page, 400);
  const names = (await mount.getByRole("button").allInnerTexts()).map(name => name.trim());
  results.check(`${label} sdk: data-buttons="intents" draws "Sign in" and "Sign up"`, names.length === 2 && names[0] === "Sign in" && names[1] === "Sign up", names.join(" | "));
  const shot = `${env.shots}/uxa-intents-sdk-${variant.key}.png`;
  await mount.screenshot({ path: shot }).catch(() => undefined);
  await sdkLook(ctx, findings, page, "#sdk-intents", `${label} sdk`, shot, names);
  if (variant.key === VARIANTS[0]!.key) {
    // "Sign up" in the frame opens the sign-up version of our page.
    const frame = page.frameLocator("#intents-iframe");
    await frame.getByRole("link", { name: "Sign up", exact: true }).click();
    await page.waitForURL(url => url.pathname.startsWith("/authorize/flow/"), { timeout: 30_000 });
    const title = await hostedTitle(page);
    results.check(`${label}: the frame's "Sign up" opens the sign-up version of the hosted page`, /^Create your Briefcase account$/.test(title), title);
  }
  const problems = drainProblems(page);
  results.check(`${label}: no console errors`, problems.console.length === 0, problems.console.slice(0, 4).join(" | "));
  await context.close();
}

export const journeys: Journey[] = [
  {
    name: "ux-audit-embed",
    title: "the iframe buttons on briefcase, pixel-studio and orbit-games (light/dark × 1440/390, forced themes alone), the SDK's buttons on quill-docs, and Sign in / Sign up (intents) in both: axe, squircles, fit, Powered by, names, keyboard focus",
    timeoutMs: 1_200_000,
    async run(ctx) {
      const findings = findingsFor(ctx);
      for (const entry of EMBEDS) for (const variant of entry.forced ? forcedVariants(entry.forced) : VARIANTS) await auditEmbed(ctx, findings, entry, variant);
      for (const variant of VARIANTS) await auditSdk(ctx, findings, variant);
      for (const variant of [VARIANTS[0]!, VARIANTS[3]!]) await auditIntents(ctx, findings, variant);
      ctx.results.check("embed: findings saved", true, saveFindings(ctx, findings));
    },
  },
];
