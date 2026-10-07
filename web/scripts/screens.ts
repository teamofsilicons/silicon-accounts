/**
 * Playwright screenshots of the web app for visual review, in both themes at 1440 and 390 px by default.
 *
 *   pnpm screens                         every screen (the foundation's + every components/<area>/screens.ts)
 *   pnpm screens --only kitchen,shell    screens whose name starts with one of these
 *   pnpm screens --widths 390 --themes dark --engine webkit
 *   pnpm screens --live                  no mocks: the server's /v1 proxy talks to the real API (ACCOUNTS_API_URL)
 *   pnpm screens --base http://localhost:8690   a running server (else http://localhost:$PORT|8590, else one is started)
 *   pnpm screens --only kitchen --split 1600    also save tall pages in 1600 px parts for review
 *
 * The server: `--base`, or a server already answering on http://localhost:$PORT (default 8590), or `next dev` started
 * here (and stopped at the end). Next allows one `next dev` per project, so when another is running the script uses
 * it. /__kitchen is development only: against `next start`, set ACCOUNTS_KITCHEN=1 on that server.
 *
 * Mocks: the browser's /v1 requests are answered from scripts/mock (fixtures from testkit/fake-apps.json). A signed-in
 * screen also gets a session cookie, so the server renders it as signed in. The embed page's frame-ancestors comes
 * from the server asking the real API; with mocks, the style guide's iframe samples get frame-ancestors 'self'.
 *
 * Output: web/.screens/<name>--<theme>-<width>.png (git-ignored). Console errors and page errors fail the run.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, webkit, type Browser, type Page } from "@playwright/test";
import { mockApi } from "./mock/api";
import type { ScreenSpec } from "./screens-types";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Options {
  only: string[];
  themes: Array<"light" | "dark">;
  widths: number[];
  out: string;
  base: string | null;
  live: boolean;
  engine: "chromium" | "webkit";
  list: boolean;
  allowErrors: boolean;
  /** Also save the page in parts of this many CSS pixels (easier to review tall pages). */
  split: number | null;
}

const USAGE = "Usage: pnpm screens [--only a,b] [--themes light,dark] [--widths 1440,390] [--engine chromium|webkit] [--live] [--base URL] [--out DIR] [--split PX] [--list] [--allow-errors]";

function parseArgs(argv: string[]): Options {
  const options: Options = { only: [], themes: ["light", "dark"], widths: [1440, 390], out: join(webRoot, ".screens"), base: null, live: false, engine: "chromium", list: false, allowErrors: false, split: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value. ${USAGE}`);
      return value;
    };
    if (arg === "--only") options.only = next().split(",").map(item => item.trim()).filter(Boolean);
    else if (arg === "--themes") options.themes = next().split(",").filter((item): item is "light" | "dark" => item === "light" || item === "dark");
    else if (arg === "--widths") options.widths = next().split(",").map(Number).filter(value => Number.isFinite(value) && value > 0);
    else if (arg === "--out") options.out = resolve(next());
    else if (arg === "--base") options.base = next().replace(/\/$/, "");
    else if (arg === "--live") options.live = true;
    else if (arg === "--engine") options.engine = next() === "webkit" ? "webkit" : "chromium";
    else if (arg === "--list") options.list = true;
    else if (arg === "--allow-errors") options.allowErrors = true;
    else if (arg === "--split") options.split = Math.max(200, Number(next()) || 1600);
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--") continue;
    else if (arg) throw new Error(`Unknown option ${arg}. ${USAGE}`);
  }
  return options;
}

const EMBED_QUERY = (appId: string, redirect: string) => `app_id=${appId}&redirect_uri=${encodeURIComponent(redirect)}&state=screens`;

/** The foundation's own screens: the style guide, the landing page, the account shell and the embed. */
const foundationScreens: ScreenSpec[] = [
  { name: "kitchen", path: "/__kitchen", waitFor: "[data-kitchen-ready]", settle: 1200 },
  { name: "kitchen-compare", path: "/__kitchen?compare=1", waitFor: "[data-kitchen-ready]", widths: [1440], themes: ["light"], settle: 1200 },
  { name: "kitchen-squircle-fallback", path: "/__kitchen?squircle=fallback", waitFor: "[data-kitchen-ready]", widths: [1440], themes: ["light"], settle: 1200 },
  { name: "landing", path: "/", as: "signed-out" },
  { name: "shell-home", path: "/", waitFor: "[data-identity-card]" },
  { name: "shell-identity-card", path: "/", waitFor: "[data-identity-card]", element: "[data-identity-card]" },
  { name: "shell-identity-card-details", path: "/", waitFor: "[data-identity-card]", element: "[data-identity-card]", prepare: async page => {
    await page.getByRole("button", { name: "Details" }).click();
    await page.waitForTimeout(1100);
  } },
  { name: "shell-palette", path: "/", waitFor: "[data-identity-card]", fullPage: false, prepare: async page => {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    await page.waitForTimeout(600);
  } },
  { name: "shell-nav-sheet", path: "/silicons", widths: [390], fullPage: false, prepare: async page => {
    await page.locator("[data-vt='dock'] button[aria-haspopup='dialog']").first().click();
    await page.waitForTimeout(900);
  } },
  { name: "embed-buttons", path: `/embed/v1/buttons?${EMBED_QUERY("briefcase", "http://127.0.0.1:8593/briefcase/callback")}`, as: "signed-out", waitFor: "#silicon-accounts-embed[data-ready]", widths: [390] },
  { name: "embed-buttons-branded", path: `/embed/v1/buttons?${EMBED_QUERY("pixel-studio", "http://127.0.0.1:8593/pixel-studio/callback")}&theme=light`, as: "signed-out", waitFor: "#silicon-accounts-embed[data-ready]", widths: [390], themes: ["light"] },
  { name: "not-found", path: "/no-such-page", as: "signed-out", status: 404 },
];

async function discoverAreaScreens(): Promise<ScreenSpec[]> {
  const componentsDir = join(webRoot, "components");
  const out: ScreenSpec[] = [];
  for (const area of await readdir(componentsDir)) {
    for (const file of ["screens.ts", "screens.tsx"]) {
      const candidate = join(componentsDir, area, file);
      if (!existsSync(candidate)) continue;
      const loaded = (await import(pathToFileURL(candidate).href)) as { screens?: ScreenSpec[] };
      for (const spec of loaded.screens ?? []) out.push(spec);
    }
  }
  return out;
}

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(4000) });
    return response.status > 0;
  } catch {
    return false;
  }
}

/** Starts `next dev` (or finds the one already running for this project). */
async function startServer(port: number): Promise<{ url: string; child: ChildProcess | null }> {
  // The style guide's SDK samples load the built /sdk/v1.js.
  if (!existsSync(join(webRoot, "public", "sdk", "v1.js"))) {
    await new Promise<void>((done, fail) => spawn(process.execPath, [join(webRoot, "sdk", "build.mjs")], { cwd: webRoot, stdio: "inherit" }).on("exit", code => (code ? fail(new Error("pnpm build:sdk failed")) : done())));
  }
  const child = spawn(join(webRoot, "node_modules", ".bin", "next"), ["dev", "--port", String(port)], { cwd: webRoot, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let output = "";
  const existing = new Promise<string | null>(resolveExisting => {
    const read = (chunk: Buffer) => {
      output += chunk.toString();
      if (/Another next dev server is already running/.test(output)) {
        const match = /existing server at (https?:\/\/\S+?)[,\s]/.exec(output);
        if (match?.[1]) resolveExisting(match[1].replace(/\/$/, ""));
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("exit", () => resolveExisting(null));
  });
  const url = `http://localhost:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const other = await Promise.race([existing, new Promise<undefined>(done => setTimeout(() => done(undefined), 400))]);
    if (typeof other === "string") {
      console.log(`Using the next dev server already running for this project at ${other}.`);
      return { url: other, child: null };
    }
    if (other === null) throw new Error(`next dev exited before it was ready:\n${output.slice(-2000)}`);
    if (await reachable(url)) return { url, child };
  }
  stop(child);
  throw new Error(`next dev did not answer on ${url} within 2 minutes:\n${output.slice(-2000)}`);
}

function stop(child: ChildProcess | null) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function shoot(browser: Browser, base: string, spec: ScreenSpec, theme: "light" | "dark", width: number, options: Options): Promise<string[]> {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: width < 600 ? 2 : 1, locale: "en-US", timezoneId: "Asia/Kolkata" });
  const signedIn = (spec.as ?? "carbon") === "carbon";
  // The root layout decides "signed out for sure" from the absence of a session cookie, like it does in production.
  if (signedIn && !options.live) await context.addCookies([{ name: "sa_session", value: "screens", url: base }]);
  const page: Page = await context.newPage();
  const problems: string[] = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    // A signed-out browser asking GET /v1/session gets 401 by design; Chromium logs every non-2xx fetch.
    const source = message.location().url ?? "";
    const text = message.text();
    if (text.startsWith("Failed to load resource") && text.includes("401")) return;
    // The page itself answering its expected status (a 404 page) is not a problem.
    if (text.startsWith("Failed to load resource") && source === base + spec.path && text.includes(`status of ${spec.status ?? 200}`)) return;
    // Dev only: the hot-reload socket of an iframe whose document the mock layer served (local network checks).
    if (/WebSocket connection to '[^']*\/_next\/(webpack-)?hmr/.test(text)) return;
    problems.push(`console: ${text}${source ? ` (${source})` : ""}`);
  });
  page.on("pageerror", error => problems.push(`page error: ${error.message}`));
  if (!options.live) {
    await mockApi(page, { as: spec.as ?? "carbon", routes: spec.routes });
    // The style guide frames the embed page; its frame-ancestors come from the real API, which mocks cannot answer.
    await page.route(url => url.pathname === "/embed/v1/buttons", async route => {
      if (route.request().frame() === page.mainFrame()) return route.continue();
      const response = await route.fetch();
      const headers = { ...response.headers() };
      if (headers["content-security-policy"]) headers["content-security-policy"] = headers["content-security-policy"].replace(/frame-ancestors [^;]*/, "frame-ancestors 'self'");
      delete headers["x-frame-options"];
      return route.fulfill({ response, headers });
    });
  }
  try {
    const response = await page.goto(base + spec.path, { waitUntil: "networkidle", timeout: 120_000 });
    if (response && response.status() !== (spec.status ?? 200)) problems.push(`HTTP ${response.status()} for ${spec.path} (expected ${spec.status ?? 200})`);
    if (spec.waitFor) await page.waitForSelector(spec.waitFor, { timeout: 30_000 });
    await page.evaluate(async () => { await document.fonts.ready; });
    if (spec.scroll !== false && (spec.fullPage ?? true) && !spec.element) {
      // Visit every screenful once so in-view animations (counters, reveals) have run, then return to the top.
      await page.evaluate(async () => {
        const step = Math.max(200, window.innerHeight * 0.8);
        for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise(done => setTimeout(done, 60));
        }
        window.scrollTo(0, 0);
      });
    }
    await page.waitForTimeout(spec.settle ?? 700);
    if (spec.prepare) await spec.prepare(page);
    const file = join(options.out, `${spec.name}--${theme}-${width}.png`);
    if (!spec.element && (spec.fullPage ?? true)) {
      // Grow the viewport to the page, so fixed parts (the dock) sit where they would at the end of the page instead of
      // over the middle of a full-page capture.
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      if (height > (page.viewportSize()?.height ?? 0)) {
        await page.setViewportSize({ width, height: Math.min(height, 20_000) });
        await page.waitForTimeout(250);
      }
    }
    if (spec.element) {
      // The element with room around it, so its shadow and any part drawn past its box (a flipped face) show too.
      const box = await page.locator(spec.element).first().boundingBox();
      if (!box) throw new Error(`${spec.element} is not visible`);
      const pad = 24;
      const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
      const x = Math.max(0, box.x + scroll.x - pad);
      const y = Math.max(0, box.y + scroll.y - pad);
      await page.screenshot({ path: file, fullPage: true, clip: { x, y, width: Math.min(width - x, box.width + 2 * pad), height: box.height + 2 * pad }, animations: "allow" });
    } else await page.screenshot({ path: file, fullPage: spec.fullPage ?? true, animations: "allow" });
    if (options.split && (spec.fullPage ?? true) && !spec.element) {
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let part = 0, y = 0; y < height; part++, y += options.split) {
        await page.screenshot({ path: file.replace(/\.png$/, `.part${part}.png`), fullPage: true, clip: { x: 0, y, width, height: Math.min(options.split, height - y) }, animations: "allow" });
      }
    }
    console.log(`  ${problems.length ? "!" : "✓"} ${file.replace(`${webRoot}/`, "")}`);
  } catch (error) {
    problems.push(`screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await context.close();
  }
  return problems.map(problem => `${spec.name} (${theme}, ${width}px): ${problem}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const specs = [...foundationScreens, ...(await discoverAreaScreens())]
    .filter(spec => !options.only.length || options.only.some(prefix => spec.name.startsWith(prefix)));
  if (options.list) {
    for (const spec of specs) console.log(`${spec.name}  ${spec.path}`);
    return;
  }
  if (!specs.length) throw new Error(`No screen matches --only ${options.only.join(",")}. Run with --list to see every screen.`);
  await mkdir(options.out, { recursive: true });

  const port = Number(process.env.PORT ?? 8590);
  let base = options.base;
  let child: ChildProcess | null = null;
  if (!base) {
    const candidate = `http://localhost:${port}`;
    if (await reachable(candidate)) base = candidate;
    else ({ url: base, child } = await startServer(port));
  }
  const cleanup = () => stop(child);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  const browser = await (options.engine === "webkit" ? webkit : chromium).launch();
  const problems: string[] = [];
  console.log(`Screens from ${base} (${options.engine}, ${options.live ? "live API" : "mock API"}) into ${options.out}`);
  try {
    for (const spec of specs) {
      for (const theme of spec.themes ?? options.themes) {
        if (!options.themes.includes(theme)) continue;
        for (const width of spec.widths ?? options.widths) {
          if (!options.widths.includes(width) && !spec.widths) continue;
          problems.push(...(await shoot(browser, base, spec, theme, width, options)));
        }
      }
    }
  } finally {
    await browser.close();
    cleanup();
  }
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n${problems.map(problem => `  - ${problem}`).join("\n")}`);
    if (!options.allowErrors) process.exitCode = 1;
  } else console.log("\nNo console errors.");
}

main().catch(error => {
  console.error(`screens: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
