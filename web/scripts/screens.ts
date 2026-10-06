/**
 * Playwright screenshots of the web app for visual review, in both themes at 1440 and 390 px by default.
 *
 *   pnpm screens                         every screen (foundation + every src/pages/<area>/screens.ts)
 *   pnpm screens --only kitchen,shell    screens whose name starts with one of these
 *   pnpm screens --widths 390 --themes dark --engine webkit
 *   pnpm screens --live                  no mocks: talk to the API behind the dev proxy (ACCOUNTS_API_URL, default :8590)
 *   pnpm screens --base http://localhost:5190   use a running server instead of starting one
 *   pnpm screens --only kitchen --split 1600    also save tall pages in 1600 px parts for review
 *
 * Output: web/.screens/<name>--<theme>-<width>.png (git-ignored). Console errors and page errors fail the run.
 */
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, webkit, type Browser, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
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

function parseArgs(argv: string[]): Options {
  const options: Options = { only: [], themes: ["light", "dark"], widths: [1440, 390], out: join(webRoot, ".screens"), base: null, live: false, engine: "chromium", list: false, allowErrors: false, split: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${arg} needs a value. Run with --help to see the options.`);
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
      console.log(readUsage());
      process.exit(0);
    } else if (arg) throw new Error(`Unknown option ${arg}. Run with --help to see the options.`);
  }
  return options;
}

function readUsage(): string {
  return "Usage: pnpm screens [--only a,b] [--themes light,dark] [--widths 1440,390] [--engine chromium|webkit] [--live] [--base URL] [--out DIR] [--split PX] [--list] [--allow-errors]";
}

/** The foundation's own screens: the style guide, the landing page and the account shell. */
const foundationScreens: ScreenSpec[] = [
  { name: "kitchen", path: "/__kitchen", waitFor: "[data-kitchen-ready]" },
  { name: "kitchen-squircle-fallback", path: "/__kitchen?squircle=fallback", waitFor: "[data-kitchen-ready]", widths: [1440], themes: ["light"] },
  { name: "landing", path: "/", as: "signed-out" },
  { name: "shell-identity", path: "/identity" },
  { name: "shell-identity-details", path: "/identity", prepare: async page => {
    await page.getByRole("button", { name: "Details" }).click();
    await page.waitForTimeout(900);
  } },
  { name: "shell-apps", path: "/apps" },
  { name: "shell-developer-app", path: "/developer/briefcase/branding" },
  { name: "shell-palette", path: "/identity", fullPage: false, prepare: async page => {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+K" : "Control+K");
    await page.waitForTimeout(500);
  } },
  { name: "shell-nav-sheet", path: "/silicons", widths: [390], fullPage: false, prepare: async page => {
    await page.getByRole("button", { name: /Silicons/ }).first().click();
    await page.waitForTimeout(800);
  } },
  { name: "hosted-flow-frame", path: "/authorize/flow/flow_acme-notes", as: "signed-out" },
  // The embed's source page (production serves the build at /embed/v1/buttons); an iframe is about phone-wide.
  { name: "embed-buttons", path: "/embed/buttons.html?app_id=briefcase&redirect_uri=https%3A%2F%2Fbriefcase.example%2Fcallback&state=screens", as: "signed-out", waitFor: "#silicon-accounts-embed[data-ready]", widths: [390] },
  { name: "embed-buttons-branded", path: "/embed/buttons.html?app_id=pixel-studio&redirect_uri=https%3A%2F%2Fpixel.example%2Fcallback&state=screens", as: "signed-out", waitFor: "#silicon-accounts-embed[data-ready]", widths: [390] },
  { name: "not-found", path: "/no-such-page" },
];

async function discoverAreaScreens(): Promise<ScreenSpec[]> {
  const pagesDir = join(webRoot, "src", "pages");
  const out: ScreenSpec[] = [];
  for (const area of await readdir(pagesDir)) {
    for (const file of ["screens.ts", "screens.tsx"]) {
      const candidate = join(pagesDir, area, file);
      try {
        await stat(candidate);
      } catch {
        continue;
      }
      const module = (await import(pathToFileURL(candidate).href)) as { screens?: ScreenSpec[] };
      for (const spec of module.screens ?? []) out.push(spec);
    }
  }
  return out;
}

async function startServer(): Promise<{ url: string; server: ViteDevServer }> {
  const port = 5600 + Math.floor(Math.random() * 300);
  const server = await createServer({
    configFile: join(webRoot, "vite.config.ts"),
    root: webRoot,
    logLevel: "error",
    // Mocked runs answer /v1 inside the browser (Playwright routes), so the dev proxy only matters with --live.
    server: { port, strictPort: false, host: "127.0.0.1" },
  });
  await server.listen();
  const address = server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${port}/`;
  return { url: address.replace(/\/$/, ""), server };
}

async function shoot(browser: Browser, base: string, spec: ScreenSpec, theme: "light" | "dark", width: number, options: Options): Promise<string[]> {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: theme, deviceScaleFactor: width < 600 ? 2 : 1, locale: "en-US", timezoneId: "Asia/Kolkata" });
  const page: Page = await context.newPage();
  const problems: string[] = [];
  page.on("console", message => {
    if (message.type() !== "error") return;
    // A signed-out browser asking GET /v1/session gets 401 by design; Chromium logs every non-2xx fetch.
    const source = message.location().url ?? "";
    if (message.text().startsWith("Failed to load resource") && /\/v1\/session(\?|$)/.test(source) && message.text().includes("401")) return;
    problems.push(`console: ${message.text()}${source ? ` (${source})` : ""}`);
  });
  page.on("pageerror", error => problems.push(`page error: ${error.message}`));
  if (!options.live) await mockApi(page, { as: spec.as ?? "carbon", routes: spec.routes });
  try {
    await page.goto(base + spec.path, { waitUntil: "networkidle" });
    if (spec.waitFor) await page.waitForSelector(spec.waitFor, { timeout: 10_000 });
    await page.evaluate(async () => { await document.fonts.ready; });
    if (spec.scroll !== false && (spec.fullPage ?? true)) {
      // Visit every screenful once so in-view animations (counters, reveals) have run, then return to the top.
      await page.evaluate(async () => {
        const step = Math.max(200, window.innerHeight * 0.8);
        for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise(resolve => setTimeout(resolve, 60));
        }
        window.scrollTo(0, 0);
      });
    }
    await page.waitForTimeout(spec.settle ?? 700);
    if (spec.prepare) await spec.prepare(page);
    const file = join(options.out, `${spec.name}--${theme}-${width}.png`);
    await page.screenshot({ path: file, fullPage: spec.fullPage ?? true, animations: "allow" });
    if (options.split && (spec.fullPage ?? true)) {
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
  const started = options.base ? null : await startServer();
  const base = options.base ?? started?.url ?? "";
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
    await started?.server.close();
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
