/**
 * Screens of the account app for the landing lab (/__landing), on the mock API (scripts/mock), at 2x:
 *
 *   pnpm tsx scripts/landing-shots.ts [--base http://localhost:9100] [--only home,switcher]
 *
 * Run it against a dev server started without ACCOUNTS_API_URL (as `pnpm screens` starts one): with a real API, the
 * proxy asks it about the mock session and "/" answers with the landing instead of Home.
 *
 * Writes public/landing-lab/<name>.png. The site is light only (lib/theme.ts), so one picture each. The two sign-in
 * screens and the switcher are cropped to the card or menu they show.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { screens as authScreens } from "../components/auth/screens";
import { screens as workScreens } from "../components/work-accounts/screens";
import { mockApi } from "./mock/api";
import type { MockRoute } from "./screens-types";

/** The mock routes of an existing `pnpm screens` spec, so these pictures show what those screens show. */
const routesOf = (name: string): MockRoute[] => [...authScreens, ...workScreens].find(spec => spec.name === name)?.routes ?? [];

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(webRoot, "public", "landing-lab");
const baseIndex = process.argv.indexOf("--base");
const base = (baseIndex > 0 ? process.argv[baseIndex + 1] : undefined) ?? "http://localhost:9100";

interface Shot {
  name: string;
  path: string;
  signedOut?: boolean;
  waitFor?: string;
  /** Crop to this element, with this much room around it. */
  element?: string;
  pad?: number;
  /** Viewport width (default 1440) and height (default 900). */
  width?: number;
  height?: number;
  routes?: MockRoute[];
  prepare?: (page: Page) => Promise<void>;
}

const SHOTS: Shot[] = [
  { name: "home", path: "/", waitFor: "[data-home]" },
  { name: "silicons", path: "/silicons" },
  { name: "apps", path: "/apps" },
  { name: "security", path: "/sign-in-methods" },
  // The same four on a phone, for the tour at phone widths.
  { name: "home-phone", path: "/", waitFor: "[data-home]", width: 390, height: 844 },
  { name: "silicons-phone", path: "/silicons", width: 390, height: 844 },
  { name: "apps-phone", path: "/apps", width: 390, height: 844 },
  { name: "security-phone", path: "/sign-in-methods", width: 390, height: 844 },
  {
    name: "switcher", path: "/", waitFor: "[data-home]", element: '[role="menu"]', pad: 16, routes: routesOf("account-profile-menu"),
    prepare: async page => {
      await page.getByRole("button", { name: /^Accounts, signed in as/ }).click();
      await page.getByRole("menu").waitFor();
      await page.waitForTimeout(700);
    },
  },
  { name: "sign-in", path: "/authorize/flow/briefcase~choose_method", signedOut: true, routes: routesOf("auth-default-choose_method"), waitFor: 'main[data-fonts="ready"]', height: 1000 },
  { name: "consent", path: "/authorize/flow/briefcase~details", signedOut: true, routes: routesOf("auth-default-details"), waitFor: 'main[data-fonts="ready"]', height: 1000 },
  {
    name: "app-page", path: "/apps/briefcase", width: 390, height: 844,
    // The mock's sample values read as a real address and a local host; copy.md's illustrative ones read as samples.
    prepare: page => page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        node.nodeValue = (node.nodeValue ?? "").replace("saketdev12@gmail.com", "you@example.com").replace("127.0.0.1:8593", "briefcase.example");
      }
    }),
  },
];

async function main() {
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch();
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1]?.split(",") : null;
  for (const shot of SHOTS.filter(item => !only || only.includes(item.name))) {
    const context = await browser.newContext({ viewport: { width: shot.width ?? 1440, height: shot.height ?? 900 }, deviceScaleFactor: 2, colorScheme: "light", locale: "en-US", timezoneId: "Asia/Kolkata" });
    if (!shot.signedOut) await context.addCookies([{ name: "sa_session", value: "screens", url: base }]);
    const page = await context.newPage();
    await mockApi(page, { as: shot.signedOut ? "signed-out" : "carbon", routes: shot.routes });
    await page.goto(base + shot.path, { waitUntil: "networkidle", timeout: 120_000 });
    if (shot.waitFor) await page.waitForSelector(shot.waitFor, { timeout: 30_000 });
    await page.evaluate(async () => { await document.fonts.ready; });
    // The dev panel's button is development only; it isn't part of the product.
    await page.addStyleTag({ content: "[aria-label^='Dev tools'], nextjs-portal { display: none !important; }" });
    await page.waitForTimeout(900);
    if (shot.prepare) await shot.prepare(page);
    const file = join(out, `${shot.name}.png`);
    if (shot.element) {
      const box = await page.locator(shot.element).first().boundingBox();
      if (!box) throw new Error(`${shot.element} is not visible on ${shot.path}`);
      const pad = shot.pad ?? 0;
      await page.screenshot({ path: file, clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad } });
    } else await page.screenshot({ path: file });
    console.log(`  ✓ ${file}`);
    await context.close();
  }
  await browser.close();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
