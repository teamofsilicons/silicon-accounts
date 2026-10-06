/**
 * Interaction smoke test for the web foundation: drives every component on /__kitchen and the account shell with the
 * mock API, and fails on any console error, page error or failed expectation.
 *
 *   pnpm smoke                    chromium
 *   pnpm smoke --engine webkit
 *   pnpm smoke --reduced-motion   the same with prefers-reduced-motion: reduce
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit, expect, type Page } from "@playwright/test";
import { build, createServer, type Plugin } from "vite";
import { mockApi } from "./mock/api";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const engine = args.includes("--engine") && args[args.indexOf("--engine") + 1] === "webkit" ? webkit : chromium;
const reducedMotion = args.includes("--reduced-motion") ? "reduce" : "no-preference";
const only = args.includes("--only") ? (args[args.indexOf("--only") + 1] ?? "").split(",") : [];

type Check = {
  name: string;
  path: string;
  run: (page: Page, base: string) => Promise<void>;
  as?: "carbon" | "signed-out";
  width?: number;
  /** Extra routes before the first navigation (host pages on another origin, the built SDK). */
  setup?: (page: Page, base: string) => Promise<void>;
  /** Where to start instead of `base + path`. */
  url?: (base: string) => string;
  /** Console errors this check expects (a configuration error the page reports on purpose). */
  allowConsole?: RegExp[];
};

/** An app's page on another origin than Silicon Accounts: the dev server's own address under "localhost". */
const appOrigin = (base: string) => base.replace("127.0.0.1", "localhost");

let sdkBundle: Promise<string> | undefined;
/** sdk/v1.ts built the way `pnpm build` ships it (one IIFE), so the check loads it with a plain script tag. */
function sdkCode(): Promise<string> {
  sdkBundle ??= (async () => {
    const outDir = await mkdtemp(join(tmpdir(), "accounts-sdk-"));
    try {
      await build({
        configFile: false,
        root: webRoot,
        logLevel: "error",
        publicDir: false,
        define: { __ACCOUNTS_WEB_VERSION__: JSON.stringify("smoke") },
        build: { outDir, emptyOutDir: true, target: "es2019", minify: true, copyPublicDir: false, lib: { entry: resolve(webRoot, "sdk/v1.ts"), formats: ["iife"], name: "SiliconAccountsSdk", fileName: () => "v1.js" } },
      });
      return await readFile(join(outDir, "v1.js"), "utf8");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  })();
  return sdkBundle;
}

const html = (body: string) => ({ status: 200, contentType: "text/html", body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>App</title></head><body>${body}</body></html>` });

/**
 * Stand-ins for an app's own pages, served by the dev server itself under /__smoke/ (a real loopback page, so Chrome's
 * local network checks let it frame and call the dev server the way a deployed app frames Silicon Accounts).
 */
const appPages = new Map<string, string>();
const appPagesPlugin: Plugin = {
  name: "smoke:app-pages",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const body = appPages.get((request.url ?? "").split("?")[0] ?? "");
      if (body === undefined) return next();
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(html(body).body);
    });
  },
};

const section = (page: Page, title: string) => page.locator(`section[aria-label="${title}"]`);

const checks: Check[] = [
  {
    name: "buttons, action button, copy button",
    path: "/__kitchen",
    run: async page => {
      const block = section(page, "Button: one primary per surface");
      await block.getByRole("button", { name: "Save changes" }).click();
      await expect(block.getByRole("button", { name: "Saved" })).toBeVisible();
      const actions = section(page, "ActionButton and CopyButton");
      await actions.getByRole("button", { name: /Save profile/ }).click();
      await expect(actions.getByRole("status").first()).toHaveText("Saving");
      await expect(actions.getByRole("status").first()).toHaveText("Saved", { timeout: 4000 });
      await actions.getByRole("button", { name: "Copy id" }).click();
      await expect(actions.getByText("Copy id: copied")).toBeAttached({ timeout: 3000 });
    },
  },
  {
    name: "confirm morph and hold to confirm",
    path: "/__kitchen",
    run: async page => {
      const block = section(page, "ConfirmMorph and HoldToConfirm: destructive actions");
      await block.getByRole("button", { name: "Remove access" }).click();
      await expect(block.getByText("Remove Briefcase's access?").first()).toBeVisible();
      await block.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(block.getByText("Removed").first()).toBeVisible({ timeout: 4000 });
      await block.getByRole("button", { name: "Revoke proof" }).click();
      await block.getByRole("button", { name: "Revoke", exact: true }).click();
      await expect(block.getByRole("button", { name: "Retry" })).toBeVisible({ timeout: 4000 });
      const hold = block.getByRole("button", { name: "Hold to rotate the STK" });
      await hold.scrollIntoViewIfNeeded();
      const box = await hold.boundingBox();
      if (!box) throw new Error("hold button not laid out");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(1500);
      await page.mouse.up();
      await expect(block.getByRole("button", { name: "Rotated" })).toBeVisible();
    },
  },
  {
    name: "dropdown, tooltip, popover",
    path: "/__kitchen",
    run: async page => {
      const block = section(page, "DropdownMenu, Tooltip and Popover");
      await block.getByRole("button", { name: "Manage" }).click();
      await expect(page.getByRole("menuitem", { name: /Copy si:id/ })).toBeVisible();
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await block.getByRole("button", { name: "Sign out" }).hover();
      await expect(page.getByText("Signs this browser out")).toBeVisible();
      await block.getByRole("button", { name: "What is a uuid?" }).click();
      await expect(page.getByText(/Your uuid never changes/)).toBeVisible();
      await page.keyboard.press("Escape");
    },
  },
  {
    name: "feedback: counters, progress, alert dismiss, toasts",
    path: "/__kitchen",
    run: async page => {
      const counters = section(page, "TextMorph, SlotText and AnimatedCounter");
      await counters.getByRole("button", { name: /Pending/ }).click();
      const progress = section(page, "Progress and Skeleton");
      await progress.getByRole("button", { name: "Advance" }).click();
      const alerts = section(page, "Alert: next to its cause");
      await alerts.getByRole("button", { name: "Dismiss: Webhook delivered" }).click();
      const toasts = section(page, "Toasts: results of background work");
      await toasts.getByRole("button", { name: "Error" }).click();
      await expect(page.getByText("c:saket is taken by another account.", { exact: false }).last()).toBeVisible();
      await toasts.getByRole("button", { name: "Loading → done" }).click();
      await expect(page.getByText("STK rotated")).toBeVisible({ timeout: 4000 });
    },
  },
  {
    name: "identity card flips and card quick look",
    path: "/__kitchen",
    run: async page => {
      const look = section(page, "Card with a quick look");
      await look.getByRole("button", { name: "Briefcase" }).click();
      await expect(page.getByText(/Briefcase can see your name/)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByText(/Briefcase can see your name/)).toHaveCount(0, { timeout: 3000 });
    },
  },
  {
    name: "fields: select, combobox, morph select, phone, date picker",
    path: "/__kitchen",
    run: async page => {
      const block = section(page, "PhoneInput, Select, Combobox (time zones) and MorphSelect");
      await expect(block.getByRole("combobox", { name: "Timezone" })).toHaveValue(/Kolkata/);
      await block.getByRole("button", { name: /Theme/ }).click();
      await page.getByRole("option", { name: "Dark" }).click();
      await expect(block.getByRole("button", { name: /Theme/ })).toContainText("Dark");
      const tz = block.getByRole("combobox", { name: "Timezone" });
      await tz.click();
      await tz.fill("tokyo");
      await page.getByRole("option", { name: /Tokyo/ }).first().click();
      await expect(tz).toHaveValue(/Tokyo/);
      await block.getByRole("combobox", { name: "App" }).click();
      await page.getByRole("option", { name: /Remind/ }).click();
      await expect(block.getByRole("combobox", { name: "App" })).toContainText("Remind");
      const phone = block.getByRole("textbox", { name: "Phone number" });
      await phone.fill("9876543210");
      await expect(phone).toHaveValue("98765-43210");
      await block.getByRole("button", { name: /^Country/ }).click();
      await page.keyboard.type("united k");
      await page.keyboard.press("Enter");
      await expect(block.getByRole("button", { name: /^Country, United Kingdom/ })).toBeAttached();
      const dates = section(page, "DatePicker (date of birth, year grid) and Calendar");
      // A <label for> names the trigger after the field; the chosen date is in its text.
      const trigger = dates.getByRole("button", { name: "Date of birth" });
      await expect(trigger).toContainText("Mar 14, 1998");
      await trigger.click();
      const calendar = page.getByRole("dialog", { name: "Date of birth calendar" });
      await expect(calendar).toBeVisible();
      await calendar.getByRole("gridcell", { name: /March 20, 1998/ }).click();
      await expect(trigger).toContainText("Mar 20, 1998", { timeout: 3000 });
    },
  },
  {
    name: "fields: otp, inline edit, tags, chips",
    path: "/__kitchen",
    run: async page => {
      const block = section(page, "OtpInput and InlineEdit");
      await block.getByRole("textbox", { name: /digit 1 of 6/ }).click();
      await page.keyboard.type("123450");
      await expect(block.getByText(/That code is not right/).first()).toBeAttached();
      await block.getByRole("button", { name: /Saket Dev/ }).click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.type("Saket");
      await page.keyboard.press("Enter");
      await expect(block.getByText("Saket", { exact: true }).first()).toBeVisible({ timeout: 4000 });
      const tags = section(page, "TagInput and ChipGroup");
      const input = tags.getByRole("textbox", { name: "Redirect URIs" });
      await input.fill("ftp://nope");
      await page.keyboard.press("Enter");
      await expect(tags.getByText("Use https, or http on localhost.").first()).toBeAttached();
      await input.fill("https://briefcase.example/second");
      await page.keyboard.press("Enter");
      await expect(tags.getByText("https://briefcase.example/second", { exact: true })).toBeVisible();
      await tags.getByRole("button", { name: "Remove https://briefcase.example/second" }).click();
      await tags.getByRole("button", { name: "Phone" }).click();
      await expect(tags.getByRole("button", { name: "Phone" })).toHaveAttribute("aria-pressed", "true");
    },
  },
  {
    name: "choices: checkbox, switch, segmented, radios",
    path: "/__kitchen",
    run: async page => {
      const block = section(page, "Checkbox, Switch and SegmentedControl");
      await block.getByText("Remember this browser").click();
      await block.getByText("Allow sign up").click();
      await block.getByRole("button", { name: "Month" }).click();
      await expect(block.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
      const radios = section(page, "RadioGroup");
      await radios.getByText("Phone").click();
      await expect(radios.getByRole("radio", { name: /Phone/ })).toBeChecked();
      const cards = section(page, "RadioCards (grid and list)");
      await cards.getByRole("radio", { name: /Bring your own/ }).click();
      await page.keyboard.press("ArrowLeft");
      await expect(cards.getByRole("radio", { name: /One click/ })).toHaveAttribute("aria-checked", "true");
    },
  },
  {
    name: "structure: tabs, stepper, pagination, accordion, timeline",
    path: "/__kitchen",
    run: async page => {
      const tabs = section(page, "Tabs");
      await tabs.getByRole("tab", { name: "Users" }).click();
      await expect(tabs.getByText("Every Carbon and Silicon that signed in.")).toBeVisible();
      const stepper = section(page, "Stepper (import wizard) and Pagination");
      await stepper.getByRole("button", { name: "Next", exact: true }).click();
      await stepper.getByRole("button", { name: /Page 4|^4$/ }).first().click();
      const accordion = section(page, "Accordion");
      await accordion.getByRole("button", { name: "What does an app see?" }).click();
      await expect(accordion.getByText(/Your uuid, id, name and photo/)).toBeVisible();
      const timeline = section(page, "Timeline (activity by day)");
      await timeline.getByRole("button", { name: /changed your id/ }).click();
      await expect(timeline.getByText(/account.id_changed/)).toBeVisible();
    },
  },
  {
    name: "data: filters, table sort and selection, json viewer",
    path: "/__kitchen",
    run: async page => {
      const block = section(page, "FilterToolbar and SortableDataTable (the user base)");
      await block.getByRole("button", { name: "Add filter" }).click();
      await page.getByRole("menuitem", { name: /Kind/ }).click();
      await page.getByRole("menuitemradio", { name: "Silicon" }).click();
      await expect(block.getByRole("button", { name: "Remove Kind: Silicon" })).toBeVisible();
      await block.getByRole("button", { name: "Remove Status: Active" }).click();
      await block.getByRole("button", { name: /Sort by Sign-ins/ }).click();
      await block.getByRole("button", { name: /Sort by Sign-ins, currently ascending/ }).click();
      await block.getByRole("checkbox", { name: "Select Scout" }).check();
      await expect(block.getByText("1 selected").first()).toBeAttached();
      await block.getByRole("button", { name: "Clear selection" }).click();
      const json = section(page, "JsonViewer (webhook payload)");
      await json.getByRole("searchbox").fill("new_id");
    },
  },
  {
    name: "overlays: dialog, drawer, sheet",
    path: "/__kitchen",
    run: async page => {
      await page.getByRole("button", { name: "Delete your account" }).click();
      await expect(page.getByRole("dialog", { name: "Delete your account?" })).toBeVisible();
      await page.getByRole("button", { name: "Keep my account" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 3000 });
      await page.getByRole("button", { name: "Open user details" }).click();
      await expect(page.getByRole("dialog", { name: "Saket Dev" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 3000 });
      await page.getByRole("button", { name: "Open sheet" }).click();
      await expect(page.getByRole("dialog", { name: "Transfer si:scout" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 3000 });
    },
  },
  {
    name: "sign-in block sample flow",
    path: "/__kitchen",
    run: async page => {
      const block = page.getByRole("region", { name: "Sign in (sample)" });
      await block.getByRole("textbox", { name: "Email" }).fill("ada.okafor@example.test");
      await block.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(block.getByText("Check your email")).toBeVisible({ timeout: 4000 });
      await block.getByRole("textbox", { name: /digit 1 of 6/ }).click();
      await page.keyboard.type("123456");
      await expect(block.getByText("Welcome, Ada")).toBeVisible({ timeout: 4000 });
    },
  },
  {
    name: "shell: dock, number keys, palette, identity flip, sign out",
    path: "/identity",
    run: async page => {
      await expect(page.getByRole("heading", { level: 1, name: "Your identity" })).toBeVisible();
      await page.getByRole("button", { name: "Details" }).click();
      await expect(page.getByRole("heading", { name: "Details" })).toBeVisible();
      await page.keyboard.press("3");
      await expect(page).toHaveURL(/\/apps$/);
      await page.getByRole("navigation", { name: "Account sections" }).getByRole("link", { name: "Silicons" }).click();
      await expect(page).toHaveURL(/\/silicons$/);
      await page.keyboard.press("ControlOrMeta+k");
      await page.keyboard.type("proofs");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/proofs$/);
      await page.getByRole("button", { name: /Account menu/ }).click();
      await page.getByRole("menuitem", { name: "Settings" }).click();
      await expect(page).toHaveURL(/\/settings$/);
      await page.getByRole("button", { name: /Account menu/ }).click();
      await page.getByRole("menuitem", { name: "Sign out" }).click();
      await expect(page).toHaveURL(/\/$/);
    },
  },
  {
    name: "shell on a phone: navigation sheet",
    path: "/apps",
    width: 390,
    run: async page => {
      await page.getByRole("button", { name: /Apps/ }).first().click();
      await page.getByRole("dialog").getByRole("link", { name: /Activity/ }).click();
      await expect(page).toHaveURL(/\/activity$/);
    },
  },
  {
    name: "developer tabs live in the URL",
    path: "/developer/briefcase",
    run: async page => {
      await page.getByRole("tab", { name: "Webhooks" }).click();
      await expect(page).toHaveURL(/\/developer\/briefcase\/webhooks$/);
    },
  },
  {
    name: "signed out: landing, protected page sends to sign-in",
    path: "/",
    as: "signed-out",
    run: async page => {
      await expect(page.getByRole("heading", { level: 1 })).toContainText("One account for every Carbon and Silicon");
      await page.goto(page.url().replace(/\/$/, "/apps"));
      await page.waitForURL(/\/authorize\?|\/sign-in/, { timeout: 5000 });
    },
  },
  {
    name: "embed: branded buttons, resize message, top-window sign-in",
    path: "/__smoke/embed-host",
    url: base => `${appOrigin(base)}/__smoke/embed-host`,
    setup: async (page, base) => {
      const query = new URLSearchParams({
        app_id: "briefcase",
        redirect_uri: "http://127.0.0.1:8593/briefcase/callback",
        response_type: "code",
        state: "st-embed",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        theme: "light",
        utm_source: "not-forwarded",
      });
      appPages.set(
        "/__smoke/embed-host",
        `<script>window.heights=[];addEventListener("message",function(e){if(e.data&&e.data.type==="silicon-accounts:resize")heights.push(e.data.height)})</script><iframe id="embed" title="Sign in" src="${base}/embed/buttons.html?${query.toString()}" style="width:360px;border:0"></iframe>`,
      );
      await page.route(url => url.pathname === "/authorize", route => route.fulfill(html("<p>Hosted sign-in</p>")));
    },
    run: async (page, base) => {
      const frame = page.frameLocator("#embed");
      const group = frame.getByRole("group", { name: "Sign in to Briefcase" });
      await expect(group.getByRole("link")).toHaveText(["Continue with Google", "Continue with Apple", "Continue with email", "Continue with phone"]);
      await expect(group.getByRole("link", { name: "Continue with email" })).toHaveAttribute("data-variant", "primary");
      await expect(frame.locator("[data-powered-by]")).toContainText("Powered by Silicon Accounts");
      await expect.poll(() => page.evaluate(() => (window as unknown as { heights: number[] }).heights.at(-1) ?? 0)).toBeGreaterThan(200);
      await group.getByRole("link", { name: "Continue with email" }).click();
      await page.waitForURL(url => url.pathname === "/authorize");
      const url = new URL(page.url());
      expect(url.origin).toBe(base);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        app_id: "briefcase",
        redirect_uri: "http://127.0.0.1:8593/briefcase/callback",
        response_type: "code",
        state: "st-embed",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        method: "email",
      });
    },
  },
  {
    name: "embed: configuration errors in the server's words",
    path: "/embed/buttons.html?app_id=nope&redirect_uri=https%3A%2F%2Fapp.example%2Fcallback",
    allowConsole: [/^Silicon Accounts embed: /, /^Failed to load resource: .*404/],
    run: async page => {
      const alert = page.getByRole("alert");
      await expect(alert).toContainText("No app with app_id 'nope' exists.");
      await expect(alert).toHaveAttribute("data-error-code", "unknown_app");
      await page.goto(page.url().replace(/\?.*$/, "?redirect_uri=https%3A%2F%2Fapp.example%2Fcallback"));
      await expect(page.getByRole("alert")).toHaveAttribute("data-error-code", "missing_app_id");
      await page.goto(page.url().replace(/\?.*$/, "?app_id=orbit-games&redirect_uri=x&method=email"));
      await expect(page.getByRole("alert")).toHaveAttribute("data-error-code", "method_not_enabled");
    },
  },
  {
    name: "sdk: script tag renders buttons; sign-in stores state and PKCE",
    path: "/__smoke/sdk-host",
    url: base => `${appOrigin(base)}/__smoke/sdk-host`,
    setup: async (page, base) => {
      const code = await sdkCode();
      await page.route(`${base}/sdk/v1.js`, route => route.fulfill({ status: 200, contentType: "text/javascript", headers: { "access-control-allow-origin": "*" }, body: code }));
      appPages.set(
        "/__smoke/sdk-host",
        `<main><div id="silicon-accounts"></div></main><script src="${base}/sdk/v1.js" data-app-id="quill-docs" data-redirect-uri="${appOrigin(base)}/callback" data-target="#silicon-accounts" data-pkce="S256" data-scope="openid email" data-theme="dark" async></script>`,
      );
      await page.route(url => url.pathname === "/authorize", route => route.fulfill(html("<p>Hosted sign-in</p>")));
    },
    run: async (page, base) => {
      const host = page.locator("#silicon-accounts");
      const group = host.getByRole("group", { name: "Sign in to Quill Docs" });
      await expect(group.getByRole("button")).toHaveText(["Continue with email", "Continue with Google"]);
      await expect(host.locator("[data-powered-by]")).toContainText("Powered by Silicon Accounts");
      expect(await page.evaluate(() => typeof (window as unknown as { SiliconAccounts?: { authorizeUrl?: unknown } }).SiliconAccounts?.authorizeUrl)).toBe("function");
      await group.getByRole("button", { name: "Continue with email" }).click();
      await page.waitForURL(url => url.pathname === "/authorize");
      const url = new URL(page.url());
      const query = url.searchParams;
      expect(url.origin).toBe(base);
      expect(query.get("app_id")).toBe("quill-docs");
      expect(query.get("redirect_uri")).toBe(`${appOrigin(base)}/callback`);
      expect(query.get("method")).toBe("email");
      expect(query.get("scope")).toBe("openid email");
      expect(query.get("code_challenge_method")).toBe("S256");
      expect(query.get("nonce")).toMatch(/^[\w-]{16,}$/);
      const state = query.get("state") ?? "";
      expect(state).toMatch(/^[\w-]{43}$/);
      await page.goBack();
      const stored = await page.evaluate(key => sessionStorage.getItem(key), `silicon-accounts:auth:${state}`);
      const record = JSON.parse(stored ?? "null") as { state: string; code_verifier: string; nonce: string; redirect_uri: string } | null;
      expect(record).toMatchObject({ state, nonce: query.get("nonce"), redirect_uri: `${appOrigin(base)}/callback` });
      expect(createHash("sha256").update(record?.code_verifier ?? "").digest("base64url")).toBe(query.get("code_challenge"));
    },
  },
];

const server = await createServer({ configFile: resolve(webRoot, "vite.config.ts"), root: webRoot, logLevel: "error", plugins: [appPagesPlugin], server: { port: 6200 + Math.floor(Math.random() * 300), strictPort: false, host: "127.0.0.1" } });
await server.listen();
const base = (server.resolvedUrls?.local[0] ?? "").replace(/\/$/, "");
const browser = await engine.launch();
let failures = 0;
for (const check of checks.filter(entry => !only.length || only.some(name => entry.name.includes(name)))) {
  const context = await browser.newContext({ viewport: { width: check.width ?? 1440, height: 900 }, reducedMotion, permissions: engine === chromium ? ["clipboard-read", "clipboard-write"] : [] });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    const source = message.location().url ?? "";
    if (message.text().startsWith("Failed to load resource") && /\/v1\/session/.test(source) && message.text().includes("401")) return;
    if (check.allowConsole?.some(pattern => pattern.test(message.text()))) return;
    problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", error => problems.push(`page error: ${error.message}`));
  // Errors that never reach the console (ResizeObserver loops, rejected handlers) still fail the check.
  await page.addInitScript(() => window.addEventListener("error", event => console.error(`window error: ${event.message}`)));
  await mockApi(page, { as: check.as ?? "carbon" });
  try {
    await check.setup?.(page, base);
    await page.goto(check.url ? check.url(base) : base + check.path, { waitUntil: "networkidle" });
    if (check.path.startsWith("/__kitchen")) await page.waitForSelector("[data-kitchen-ready]");
    await check.run(page, base);
  } catch (error) {
    problems.push(`failed: ${error instanceof Error ? error.message.split("\n").slice(0, 6).join(" | ") : String(error)}`);
  }
  await context.close();
  if (problems.length) {
    failures++;
    console.log(`✗ ${check.name}\n${problems.map(problem => `    ${problem}`).join("\n")}`);
  } else console.log(`✓ ${check.name}`);
}
await browser.close();
await server.close();
if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exitCode = 1;
} else console.log("\nAll checks passed with no console errors.");
