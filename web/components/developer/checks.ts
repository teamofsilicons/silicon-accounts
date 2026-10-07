/**
 * Live interaction checks of the developer pages, in a real browser against a running site and accounts-api: tabs that
 * switch without the server, saving with expected_version, conflicts (both ways out, and an automatic rebase), text
 * typed into a list field and ⌘S, the leave guard (links, the phone dock's sheet, number keys, the command palette, the
 * user menu's Settings and signing out) and its kept draft,
 * focus after Save, Discard, a conflict's choice and a revoke, local refusals, version history, the branding preview
 * and contrast rule, the embed preview after a save, the import wizard through "Import for real", the user base,
 * webhook deliveries (retries, attempts, replays, a rotated secret) and ATA proofs. Each check fails on a broken
 * expectation, a page error, or a console error other than the 409s it provokes.
 * Screenshots of the same pages, from mocks, are in ./screens.ts.
 *
 *   pnpm -C web exec tsx components/developer/checks.ts --live http://localhost:8590
 *   … --only webhooks                   checks whose name contains "webhooks"
 *   CHECKS_SHOTS=<dir>                  screenshots of the page of a check that failed
 *
 * Needs the dev outbox (scripts/dev.sh sets ACCOUNTS_EXPOSE_DEV_OUTBOX=true) to sign in, a database seeded from
 * testkit/fake-apps.json, and the testkit's fake app server (LIVE_APP_ORIGIN, default http://127.0.0.1:8593), which
 * receives the app's webhooks and lets a check make it fail or learn a new secret. LIVE_EMAIL (default
 * saketdev12@example.test) owns LIVE_APP (default briefcase) and remind, the proof's audience. The checks change that
 * app's setup, users, webhook and proofs: run them against a scratch database.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect, type Browser, type BrowserContext, type Page, type Request } from "@playwright/test";

const APP = process.env.LIVE_APP ?? "briefcase";
const EMAIL = process.env.LIVE_EMAIL ?? "saketdev12@example.test";
const APP_ORIGIN = (process.env.LIVE_APP_ORIGIN ?? "http://127.0.0.1:8593").replace(/\/$/, "");

interface Env {
  base: string;
  browser: Browser;
  /** The owner's signed-in browser, shared by the checks (the editor keeps drafts per tab of it). */
  context: BrowserContext;
  page: Page;
  /** A tag unique to this run, so values always differ from what is stored. */
  run: string;
}

interface Check {
  name: string;
  run: (env: Env) => Promise<void>;
}

const problems: string[] = [];
/** When the browser asked "Leave site?" (see signIn). */
const unloadQuestions: number[] = [];
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const tab = (env: Env, name: string) => `${env.base}/developer/${APP}/${name}`;
const saveBar = (page: Page) => page.getByRole("region", { name: "Unsaved changes" });
const conflictTitle = /Someone saved version \d+ while you edited version \d+/;

/** What has focus, for messages: its tag, id and text. */
const focused = (page: Page) => page.evaluate(() => {
  const active = document.activeElement as HTMLElement | null;
  return active && active !== document.body ? `${active.tagName.toLowerCase()}${active.id ? `#${active.id}` : ""} ${(active.getAttribute("aria-label") ?? active.textContent ?? "").trim().slice(0, 40)}` : "the page (body)";
});

async function storedVersion(page: Page): Promise<number> {
  const text = (await page.getByText(/^Stored version \d+$/).first().textContent()) ?? "";
  return Number(/\d+/.exec(text)?.[0] ?? Number.NaN);
}

/** Another writer: a second tab of the same Carbon PATCHes the sign-in setup. */
async function theirPatch(env: Env, body: Record<string, unknown>): Promise<number> {
  const other = await env.context.newPage();
  try {
    await other.goto(`${env.base}/developer`, { waitUntil: "domcontentloaded" });
    const result = await other.evaluate(async ({ app, payload }) => {
      const response = await fetch(`/v1/apps/${app}/signin-config`, { method: "PATCH", headers: { "Content-Type": "application/json", Accept: "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(payload) });
      const json = (await response.json().catch(() => null)) as { config_version?: number } | null;
      return { status: response.status, version: json?.config_version ?? null };
    }, { app: APP, payload: body });
    if (result.status !== 200 || result.version === null) throw new Error(`their PATCH answered ${result.status}`);
    return result.version;
  } finally {
    await other.close();
  }
}

/** Tells the fake app's webhook receiver to fail the next deliveries, or (0) to stop failing. */
async function webhookFaults(failNext: number, status = 500): Promise<void> {
  const response = await fetch(`${APP_ORIGIN}/${APP}/_webhook-faults`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fail_next: failNext, status }) });
  if (!response.ok) throw new Error(`the fake app's _webhook-faults answered ${response.status}: is the testkit's fake app server at ${APP_ORIGIN}?`);
}

/** Gives the fake app's receiver the secret the page just revealed. */
async function webhookSecret(secret: string): Promise<void> {
  const response = await fetch(`${APP_ORIGIN}/${APP}/_webhook-secret`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) });
  if (!response.ok) throw new Error(`the fake app's _webhook-secret answered ${response.status}`);
}

async function revealedSecret(page: Page, label: string): Promise<string> {
  await page.getByRole("button", { name: `Show the ${label.toLowerCase()}` }).click();
  const value = ((await page.locator("code[data-shown]").first().textContent()) ?? "").trim();
  if (!value) throw new Error(`no ${label} was revealed`);
  return value;
}

/** The newest delivery row, after asking the list again (a delivery goes out within a few seconds). */
async function newestDelivery(page: Page, until: RegExp): Promise<string> {
  let text = "";
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.getByRole("button", { name: "Refresh deliveries" }).click();
    await sleep(900);
    text = (await page.locator("table tbody tr").first().textContent()) ?? "";
    if (until.test(text)) return text;
  }
  throw new Error(`the newest delivery never matched ${until}: ${text.slice(0, 120)}`);
}

/** Signs the owner in through the site's own sign-in, reading the code from the dev outbox. */
async function signIn(base: string, browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("console", message => {
    if (message.type() === "error" && !/status of 409/.test(message.text())) problems.push(`console: ${message.text().slice(0, 300)}`);
  });
  page.on("pageerror", failure => problems.push(`page error: ${failure.message.slice(0, 300)}`));
  // The browser's own "Leave site?" (a reload or a page load while a draft is unsaved): noted, and answered with leave,
  // so a check that left a draft behind never stalls the next one.
  page.on("dialog", dialog => {
    if (dialog.type() === "beforeunload") unloadQuestions.push(Date.now());
    void (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss());
  });
  await page.goto(`${base}/developer`);
  await page.getByRole("textbox", { name: "Email" }).fill(EMAIL);
  const sentAt = Date.now() - 2000;
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Check your email" })).toBeVisible();
  let code = "";
  for (let attempt = 0; attempt < 60 && !code; attempt++) {
    const response = await fetch(`${base}/v1/dev/outbox?to=${encodeURIComponent(EMAIL)}&limit=5`);
    if (!response.ok) throw new Error(`GET /v1/dev/outbox answered ${response.status}: start the API with ACCOUNTS_EXPOSE_DEV_OUTBOX=true.`);
    const body = (await response.json()) as { items: Array<{ code: string | null; created_at: string }> };
    code = body.items.find(item => item.code && Date.parse(item.created_at) > sentAt)?.code ?? "";
    if (!code) await sleep(250);
  }
  if (!code) throw new Error(`no code reached the dev outbox for ${EMAIL}`);
  await page.getByRole("textbox", { name: /digit 1 of 6/ }).click();
  await page.keyboard.type(code);
  await expect(page.getByRole("heading", { level: 1, name: "Your apps" })).toBeVisible({ timeout: 15_000 });
  return { context, page };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Checks                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

const checks: Check[] = [
  {
    name: "tabs: a switch, and Back and Forward between tabs, ask nothing of the server; the title follows",
    run: async env => {
      const { page } = env;
      await page.goto(`${env.base}/developer/${APP}`);
      await expect(page.getByRole("tab", { name: /^Overview/ })).toHaveAttribute("aria-selected", "true");
      const asked: string[] = [];
      const onRequest = (request: Request) => {
        if (request.url().includes("_rsc=")) asked.push(request.url());
      };
      page.on("request", onRequest);
      try {
        for (const name of ["Sign-in", "Webhooks", "Proofs"]) {
          await page.getByRole("tab", { name: new RegExp(`^${name}`) }).click();
          await expect(page.getByRole("tab", { name: new RegExp(`^${name}`) })).toHaveAttribute("aria-selected", "true");
        }
        await expect(page).toHaveTitle(new RegExp(`^Proofs · ${APP} · `));
        await page.goBack();
        await expect(page).toHaveURL(new RegExp(`/developer/${APP}/webhooks$`));
        await expect(page.getByRole("tab", { name: /^Webhooks/ })).toHaveAttribute("aria-selected", "true");
        await page.goForward();
        await expect(page.getByRole("tab", { name: /^Proofs/ })).toHaveAttribute("aria-selected", "true");
        expect(asked, "requests to the server for a tab switch").toEqual([]);
      } finally {
        page.off("request", onRequest);
      }
    },
  },
  {
    name: "tabs: an address that names no tab answers 404 with the not-found page; a real tab answers 200",
    run: async env => {
      const { page } = env;
      // The 404s are the point here: the browser logs them as console errors, which this check expects.
      const before = problems.length;
      for (const path of ["no-such-tab", "sign-in/extra"]) {
        const response = await page.goto(`${env.base}/developer/${APP}/${path}`);
        expect(response?.status(), path).toBe(404);
        await expect(page.getByText("Nothing lives at this address")).toBeVisible();
      }
      problems.splice(before);
      const response = await page.goto(`${env.base}/developer/${APP}/webhooks`);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("tab", { name: /^Webhooks/ })).toHaveAttribute("aria-selected", "true");
    },
  },
  {
    name: "tabs: when the window narrows to a phone's width, the selected tab scrolls into view in the tab strip",
    run: async env => {
      const { page } = env;
      // How much of the selected tab its scrolling strip shows, in px, and its width.
      const shown = () => page.evaluate(() => {
        const tab = document.querySelector<HTMLElement>("[role=tablist] [role=tab][data-state=active]");
        if (!tab) return { shown: -1, width: 0 };
        let strip = tab.parentElement;
        while (strip && getComputedStyle(strip).overflowX === "visible") strip = strip.parentElement;
        const t = tab.getBoundingClientRect();
        const s = (strip ?? document.documentElement).getBoundingClientRect();
        return { shown: Math.round(Math.max(0, Math.min(t.right, s.right) - Math.max(t.left, s.left))), width: Math.round(t.width) };
      });
      try {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(tab(env, "embed"));
        await expect(page.getByRole("tab", { name: /^Embed/ })).toHaveAttribute("aria-selected", "true");
        await page.setViewportSize({ width: 390, height: 844 });
        // It used to stay where the wide strip had it: past the strip's right edge, 0 px of it shown.
        await expect.poll(async () => { const now = await shown(); return now.shown >= now.width - 2 && now.width > 0; }, { timeout: 5000 }).toBe(true);
      } finally {
        await page.setViewportSize({ width: 1440, height: 900 });
      }
    },
  },
  {
    name: "sign-in: a toggle saves as the next version",
    run: async env => {
      const { page } = env;
      await page.goto(tab(env, "sign-in"));
      const version = await storedVersion(page);
      const phone = page.getByRole("switch", { name: /^Phone/ });
      const before = await phone.getAttribute("aria-checked");
      await phone.click();
      await expect(saveBar(page)).toContainText("1 unsaved change");
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(saveBar(page)).toContainText(`Saved as version ${version + 1}`);
      await expect(page.getByText(`Stored version ${version + 1}`)).toBeVisible();
      expect(await phone.getAttribute("aria-checked")).not.toBe(before);
    },
  },
  {
    name: "sign-in: a bring-your-own secret's field says it is stored again after Save, Discard and Keep, with focus on its Replace",
    run: async env => {
      const { page, run } = env;
      await page.goto(tab(env, "sign-in"));
      const google = page.getByRole("region", { name: "Google" });
      const byo = google.getByRole("radio", { name: /^Bring your own/ });
      const stored = google.getByText("A client secret is stored");
      const replace = google.getByRole("button", { name: "Replace" });
      const wasByo = (await byo.getAttribute("aria-checked")) === "true";
      if (!wasByo || !(await stored.count())) {
        // Bring your own Google with a stored secret first (a first save closes the field by itself).
        await byo.click();
        await google.getByRole("textbox", { name: "Client ID" }).fill(`checks-${run}.apps.googleusercontent.com`);
        await google.getByLabel("Client secret").fill(`GOCSPX-checks-${run}-first`);
        await saveBar(page).getByRole("button", { name: "Save changes" }).click();
        await expect(stored).toBeVisible();
      }
      // Replace, a new secret, Save: the field closes back to "stored" (it used to stay an empty replace field, as if
      // nothing were stored), and focus goes to its Replace, not to the start of the page.
      const version = await storedVersion(page);
      await replace.click();
      await google.getByLabel("Client secret").fill(`GOCSPX-checks-${run}-second`);
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(saveBar(page)).toContainText(`Saved as version ${version + 1}`);
      await expect(stored).toBeVisible();
      await expect(google.getByRole("button", { name: "Keep the stored secret" })).toHaveCount(0);
      await expect(replace, `focus is on ${await focused(page)}`).toBeFocused();
      // Replace, a new secret, Discard: the same, and nothing is saved.
      await replace.click();
      await google.getByLabel("Client secret").fill(`GOCSPX-checks-${run}-third`);
      await saveBar(page).getByRole("button", { name: "Discard" }).click();
      await expect(stored).toBeVisible();
      await expect(replace, `focus is on ${await focused(page)}`).toBeFocused();
      expect(await storedVersion(page)).toBe(version + 1);
      // "Keep the stored secret" closes it as well.
      await replace.click();
      await google.getByRole("button", { name: "Keep the stored secret" }).click();
      await expect(stored).toBeVisible();
      await expect(replace, `focus is on ${await focused(page)}`).toBeFocused();
      if (!wasByo) {
        // Back to one click, as the other checks found it.
        await google.getByRole("radio", { name: /^One click/ }).click();
        await saveBar(page).getByRole("button", { name: "Save changes" }).click();
        await expect(saveBar(page)).toContainText(`Saved as version ${version + 2}`);
      }
    },
  },
  {
    name: "sign-in: an overlapping save by someone else asks, brings the choice into view, and saves mine on top",
    run: async env => {
      const { page, run } = env;
      await page.goto(tab(env, "sign-in"));
      const version = await storedVersion(page);
      const title = page.getByRole("textbox", { name: "Title", exact: true });
      await title.fill(`Mine ${run}`);
      await theirPatch(env, { expected_version: version, copy: { title: `Theirs ${run}` } });
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText(conflictTitle)).toBeVisible();
      await expect(saveBar(page).getByRole("button", { name: "Review" })).toBeVisible();
      await expect(page.locator(":focus")).toHaveAttribute("id", "signin-conflict");
      await page.getByRole("button", { name: "Save mine on top" }).click();
      await expect(saveBar(page)).toContainText(`Saved as version ${version + 2}`);
      await expect(title).toHaveValue(`Mine ${run}`);
      // The choice left with the conflict; focus went back to the field, not to the start of the page.
      await expect(title, `focus is on ${await focused(page)}`).toBeFocused();
    },
  },
  {
    name: "sign-in: a save by someone else that does not overlap is rebased and saved, and the page says so",
    run: async env => {
      const { page, run } = env;
      await page.goto(tab(env, "sign-in"));
      const version = await storedVersion(page);
      await page.getByRole("textbox", { name: "Subtitle", exact: true }).fill(`Mine ${run}: every file, one place.`);
      await theirPatch(env, { expected_version: version, copy: { support_email: `help-${run}@example.test` } });
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(saveBar(page)).toContainText(`Saved as version ${version + 2}`);
      await expect(page.getByRole("textbox", { name: "Support email", exact: true })).toHaveValue(`help-${run}@example.test`);
      await expect(page.getByText(`Saved on top of version ${version + 1}`)).toBeVisible();
    },
  },
  {
    name: "sign-in: a newer version read while editing raises the conflict before saving; load theirs",
    run: async env => {
      const { page, run } = env;
      await page.goto(tab(env, "sign-in"));
      const version = await storedVersion(page);
      const title = page.getByRole("textbox", { name: "Title", exact: true });
      await title.fill(`Draft ${run}`);
      await theirPatch(env, { expected_version: version, copy: { title: `Newer ${run}` } });
      // The app is read again on focus once its 30 s stale time has passed.
      await sleep(31_000);
      await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await expect(page.getByText(conflictTitle)).toBeVisible();
      await page.getByRole("button", { name: "Discard mine, load theirs" }).click();
      await expect(title).toHaveValue(`Newer ${run}`);
      await expect(saveBar(page)).toHaveCount(0);
    },
  },
  {
    name: "sign-in: a refused redirect URI says why and keeps its text",
    run: async env => {
      const { page } = env;
      await page.goto(tab(env, "sign-in"));
      const field = page.getByRole("textbox", { name: "Redirect URIs" });
      await field.fill("ftp://example.com/callback");
      await field.press("Enter");
      await expect(page.locator("#signin-redirects ul[aria-live='polite'] li").first()).toContainText("ftp scheme");
      await expect(field).toHaveValue("ftp://example.com/callback");
      await field.fill("");
    },
  },
  {
    name: "sign-in: text typed in a list field is unsaved, ⌘S adds and saves it, refused text blocks the save; focus stays",
    run: async env => {
      const { page, run } = env;
      await page.goto(tab(env, "sign-in"));
      const version = await storedVersion(page);
      const field = page.getByRole("textbox", { name: "Redirect URIs" });
      // A comma belongs to the URI (its query), and nothing is added until Enter, ⌘S or leaving the field.
      const uri = `https://typed-${run}.example/cb?scopes=a,b`;
      await field.click();
      await page.keyboard.type(uri);
      await expect(saveBar(page)).toContainText("1 unsaved change");
      await page.keyboard.press("ControlOrMeta+s");
      await expect(saveBar(page)).toContainText(`Saved as version ${version + 1}`);
      await expect(page.locator(`#signin-redirects [data-tag="${uri}"]`)).toHaveCount(1);
      await expect(field).toHaveValue("");
      await expect(field).toBeFocused();
      // A path that differs only in case is another redirect URI (they match exactly).
      const upper = uri.replace("/cb?", "/CB?");
      await page.keyboard.type(upper);
      await page.keyboard.press("Enter");
      await expect(page.locator(`#signin-redirects [data-tag="${upper}"]`)).toHaveCount(1);
      // Text that can't be added is not saved silently: the save waits, and both the field and the alert say why.
      await page.keyboard.type("ftp://nope.example/cb");
      await page.keyboard.press("ControlOrMeta+s");
      await expect(saveBar(page)).toContainText("1 problem blocks saving");
      await expect(page.locator("#signin-redirects ul[aria-live='polite'] li").first()).toContainText("ftp scheme");
      await expect(page.getByText("Some settings need fixing")).toBeVisible();
      await saveBar(page).getByRole("button", { name: "Discard" }).click();
      await expect(field).toHaveValue("");
      await expect(page.locator(`#signin-redirects [data-tag="${upper}"]`)).toHaveCount(0);
      await expect(field, `focus is on ${await focused(page)}`).toBeFocused();
      await page.getByRole("button", { name: `Remove ${uri}` }).click();
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(saveBar(page)).toContainText(`Saved as version ${version + 2}`);
      await expect(field, `focus is on ${await focused(page)}`).toBeFocused();
    },
  },
  {
    name: "leave guard: a link and a number key ask, focus comes back, a kept draft is announced and returns, a reload asks",
    run: async env => {
      const { page, run } = env;
      await page.goto(tab(env, "sign-in"));
      const title = page.getByRole("textbox", { name: "Title", exact: true });
      const stored = await title.inputValue();
      await title.fill(`Kept ${run}`);
      const dialog = page.getByRole("dialog", { name: "Leave with unsaved changes?" });
      const yourApps = page.getByRole("link", { name: "Your apps" });
      await yourApps.click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Keep editing" }).click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/developer/${APP}/sign-in$`));
      await expect(yourApps, `focus is on ${await focused(page)}`).toBeFocused();
      // A section's number key (from a switch, where a key is not typing) asks as well.
      const phone = page.getByRole("switch", { name: /^Phone/ });
      await phone.focus();
      await page.keyboard.press("3");
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(phone).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`/developer/${APP}/sign-in$`));
      // Leaving with the draft: the next page says where it is, and Return brings it back.
      await yourApps.click();
      await dialog.getByRole("button", { name: "Leave, keep the draft" }).click();
      await expect(page).toHaveURL(`${env.base}/developer`);
      const notice = page.getByText(/^Unsaved draft of /);
      await expect(notice).toBeVisible();
      await page.getByRole("button", { name: "Return" }).click();
      await expect(page).toHaveURL(new RegExp(`/developer/${APP}/sign-in$`));
      await expect(title).toHaveValue(`Kept ${run}`);
      await expect(notice).toHaveCount(0);
      // Kept and away from the app, a reload asks first (answered with leave here, so the draft goes).
      await yourApps.click();
      await dialog.getByRole("button", { name: "Leave, keep the draft" }).click();
      await expect(page).toHaveURL(`${env.base}/developer`);
      const asked = unloadQuestions.length;
      await page.reload();
      expect(unloadQuestions.length, "the browser asked before reloading").toBeGreaterThan(asked);
      await page.goto(tab(env, "sign-in"));
      await expect(title).toHaveValue(stored);
      await expect(saveBar(page)).toHaveCount(0);
    },
  },
  {
    name: "leave guard through the shell: the command palette, the user menu's Settings and signing out ask too",
    run: async env => {
      const { page, run } = env;
      await page.goto(tab(env, "sign-in"));
      const title = page.getByRole("textbox", { name: "Title", exact: true });
      const stored = await title.inputValue();
      await title.fill(`Shell ${run}`);
      const dialog = page.getByRole("dialog", { name: "Leave with unsaved changes?" });
      // The palette's "Go to" commands ask (they used to leave without asking and only keep the draft).
      await page.keyboard.press("ControlOrMeta+k");
      await page.keyboard.type("Apps", { delay: 15 });
      await page.keyboard.press("Enter");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Keep editing" }).click();
      await expect(dialog).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/developer/${APP}/sign-in$`));
      await expect(title).toHaveValue(`Shell ${run}`);
      // The user menu's Settings asks.
      const menu = page.locator("nav[aria-label='Account sections']").getByRole("button").last();
      await menu.click();
      await page.getByRole("menuitem", { name: "Settings" }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Keep editing" }).click();
      await expect(dialog).toBeHidden();
      // Signing out asks, and offers no draft to keep (nothing in this tab survives it); staying keeps the session.
      await menu.click();
      await page.getByRole("menuitem", { name: /Sign out/ }).click();
      const signOut = page.getByRole("dialog", { name: "Sign out with unsaved changes?" });
      await expect(signOut).toBeVisible();
      await expect(signOut.getByRole("button", { name: "Leave, keep the draft" })).toHaveCount(0);
      await signOut.getByRole("button", { name: "Keep editing" }).click();
      await expect(signOut).toBeHidden();
      expect((await page.request.get(`${env.base}/v1/session`)).status(), "still signed in").toBe(200);
      // Discarding through the palette leaves without a draft, and without the browser's own question.
      const asked = unloadQuestions.length;
      await page.keyboard.press("ControlOrMeta+k");
      await page.keyboard.type("Silicons", { delay: 15 });
      await page.keyboard.press("Enter");
      await dialog.getByRole("button", { name: "Discard and leave" }).click();
      await expect(page).toHaveURL(`${env.base}/silicons`);
      expect(unloadQuestions.length, "no Leave site? after discarding").toBe(asked);
      await page.goto(tab(env, "sign-in"));
      await expect(title).toHaveValue(stored);
    },
  },
  {
    name: "leave guard on a phone: the dock's Go to sheet closes before the question and stays closed after leaving",
    run: async env => {
      const { page, run } = env;
      await page.setViewportSize({ width: 390, height: 844 });
      try {
        await page.goto(tab(env, "sign-in"));
        await page.getByRole("textbox", { name: "Subtitle", exact: true }).fill(`Phone ${run}`);
        const menu = page.locator("button[aria-haspopup='dialog']", { hasText: "Developer" });
        const sheet = page.getByRole("dialog", { name: "Go to" });
        const dialog = page.getByRole("dialog", { name: "Leave with unsaved changes?" });
        await menu.click();
        await sheet.getByRole("link", { name: /^Apps/ }).click();
        await expect(dialog).toBeVisible();
        await expect(sheet).toBeHidden();
        await dialog.getByRole("button", { name: "Keep editing" }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(menu, `focus is on ${await focused(page)}`).toBeFocused();
        await menu.click();
        await sheet.getByRole("link", { name: /^Apps/ }).click();
        await dialog.getByRole("button", { name: "Discard and leave" }).click();
        await expect(page).toHaveURL(`${env.base}/apps`);
        await expect(page.getByRole("dialog")).toHaveCount(0);
      } finally {
        await page.setViewportSize({ width: 1440, height: 900 });
      }
    },
  },
  {
    name: "sign-in: history lists versions and puts an earlier value back in the draft",
    run: async env => {
      const { page } = env;
      await page.goto(tab(env, "sign-in"));
      const version = await storedVersion(page);
      await page.getByRole("button", { name: /^History/ }).filter({ visible: true }).first().click();
      const drawer = page.getByRole("dialog", { name: "Version history" });
      await expect(drawer).toContainText(`Version ${version} is stored now`);
      const undo = drawer.getByRole("button", { name: /^Undo version \d+ in your draft$/ }).first();
      await undo.click();
      await expect(drawer).toBeHidden();
      await expect(saveBar(page)).toContainText("unsaved change");
      await saveBar(page).getByRole("button", { name: "Discard" }).click();
    },
  },
  {
    name: "sign-in: the method order moves with the arrow keys",
    run: async env => {
      const { page } = env;
      await page.goto(tab(env, "sign-in"));
      const list = page.getByRole("list", { name: "Sign-in methods, in the order they are shown" });
      const first = ((await list.getByRole("listitem").first().textContent()) ?? "").slice(0, 6);
      await list.getByRole("button", { name: /^Move \w+, position 1 of/ }).focus();
      await page.keyboard.press("ArrowDown");
      await expect(list.getByRole("listitem").nth(1)).toContainText(first.trim());
      await saveBar(page).getByRole("button", { name: "Discard" }).click();
    },
  },
  {
    name: "branding: the preview follows the draft, a low contrast blocks saving, the embed preview uses the saved look",
    run: async env => {
      const { page } = env;
      await page.goto(tab(env, "branding"));
      const version = await storedVersion(page);
      await page.getByRole("button", { name: "Light palette", exact: true }).click();
      const setPrimary = async (hex: string) => {
        await page.getByRole("button", { name: /^Primary/ }).first().click();
        const panel = page.getByRole("dialog", { name: "Primary color" });
        await panel.locator("input").fill(hex);
        await panel.locator("input").press("Enter");
        await panel.getByRole("button", { name: "Done" }).click();
      };
      const original = ((await page.getByRole("button", { name: /^Primary/ }).first().textContent()) ?? "").match(/#[0-9A-F]{6}/i)?.[0] ?? "#1F5FB8";
      await setPrimary("#9AB8F0");
      await expect(page.getByRole("row", { name: /Button text on primary/ })).toContainText("Too low");
      await expect(saveBar(page)).toContainText("1 problem blocks saving");
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByText("Some settings need fixing")).toBeVisible();
      await setPrimary("#B4232C");
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(saveBar(page)).toContainText(`Saved as version ${version + 1}`);
      await page.getByRole("tab", { name: /Embed/ }).click();
      await expect.poll(async () => page.evaluate(() => {
        for (const host of document.querySelectorAll("*")) {
          const button = host.shadowRoot && [...host.shadowRoot.querySelectorAll("a, button")].find(node => /email/i.test(node.textContent ?? ""));
          if (button) return getComputedStyle(button).backgroundColor;
        }
        return null;
      }), { timeout: 15_000 }).toBe("rgb(180, 35, 44)");
      await page.getByRole("tab", { name: /Branding/ }).click();
      await page.getByRole("button", { name: "Light palette", exact: true }).click();
      await setPrimary(original);
      await saveBar(page).getByRole("button", { name: "Save changes" }).click();
      await expect(saveBar(page)).toContainText(`Saved as version ${version + 2}`);
    },
  },
  {
    name: "import: unknown columns, a dry run with its report, Import for real, recent imports; users: search and drawer",
    run: async env => {
      const { page, run } = env;
      await page.goto(tab(env, "import"));
      const csv = [
        "email,display_name,external_id,favourite_colour",
        `ada.${run}@example.com,Ada Okafor,ext-ada-${run},blue`,
        `grace.${run}@example.com,Grace Hopper,ext-grace-${run},green`,
        "not-an-email,Bad Row,,red",
        `ada.${run}@example.com,Ada Again,,blue`,
      ].join("\n");
      await page.getByRole("button", { name: "Paste instead" }).click();
      await page.getByLabel("Paste CSV or JSON").fill(csv);
      await page.getByRole("button", { name: "Check columns", exact: true }).click();
      await expect(page.getByText(/favourite_colour/).first()).toBeVisible();
      const next = page.getByRole("button", { name: "Continue to options" });
      await expect(next).toBeDisabled();
      await page.getByRole("button", { name: "Ignore them and continue" }).click();
      await next.click();
      await page.getByRole("button", { name: "Do a dry run", exact: true }).click();
      await expect(page.getByText("Dry run finished", { exact: true })).toBeVisible({ timeout: 30_000 });
      await page.locator("button", { has: page.locator("code", { hasText: "invalid_email" }) }).first().click();
      await expect(page.locator("table tbody tr")).toHaveCount(1);
      await page.getByRole("button", { name: "Import for real" }).click();
      await expect(page.getByRole("button", { name: "Import for real" })).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByText("Import finished", { exact: true })).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Start another import" }).first().click();
      await expect(page.getByRole("region", { name: "Recent imports" })).toContainText("Dry run");
      // An older dry run opened from the list offers no Import for real: its file is not loaded.
      await page.getByRole("region", { name: "Recent imports" }).getByRole("button").filter({ hasText: "Dry run" }).first().click();
      await expect(page.getByText("Dry run finished", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Import for real" })).toHaveCount(0);
      await page.getByRole("tab", { name: /Users/ }).click();
      await page.getByRole("searchbox").fill(`grace.${run}`);
      await expect(page.locator("table tbody tr")).toHaveCount(1, { timeout: 10_000 });
      await page.locator("[data-open-user]").first().click();
      await expect(page.getByRole("dialog")).toContainText(`ext-grace-${run}`);
      await page.keyboard.press("Escape");
    },
  },
  {
    name: "webhooks: a ping is delivered, a failing one retries with its attempts, a retrying one is not replayed, a rotated secret signs",
    run: async env => {
      const { page } = env;
      await page.goto(tab(env, "webhooks"));
      await webhookFaults(0);
      await page.getByRole("button", { name: "Send test ping" }).click();
      await newestDelivery(page, /Delivered/);
      await webhookFaults(50, 503);
      await page.getByRole("button", { name: "Send test ping" }).click();
      await newestDelivery(page, /Retrying/);
      const first = page.locator("table tbody tr").first();
      await first.getByRole("button", { name: /^Open delivery/ }).click();
      const drawer = page.getByRole("dialog");
      await expect(drawer.getByRole("region", { name: "Attempts" })).toContainText("503");
      await expect(drawer.getByRole("region", { name: "Payload" })).toContainText("event_id");
      await expect(drawer.getByRole("button", { name: "Replay this delivery" })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await first.getByRole("checkbox").click();
      await page.getByRole("button", { name: /Replay 1 selected/ }).click();
      await expect(page.getByText("Nothing was replayed")).toBeVisible();
      await expect(page.getByText(/still pending/).first()).toBeVisible();
      await webhookFaults(0);
      await page.getByRole("button", { name: "Rotate secret" }).click();
      await page.getByRole("button", { name: "Rotate", exact: true }).click();
      const reveal = page.getByRole("group", { name: "Your new webhook signing secret" });
      await expect(reveal).toBeFocused();
      await webhookSecret(await revealedSecret(page, "Signing secret"));
      await page.getByRole("button", { name: "I've stored it" }).click();
      await expect(reveal).toHaveCount(0);
      await page.getByRole("button", { name: "Send test ping" }).click();
      await newestDelivery(page, /Delivered/);
      await page.getByRole("button", { name: "Change URL" }).click();
      await page.getByRole("textbox", { name: "New webhook URL" }).fill("ftp://example.com/hook");
      await page.getByRole("button", { name: "Save the new URL" }).click();
      await expect(page.getByText(/must use https/).first()).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByRole("button", { name: "Change URL" })).toBeFocused();
    },
  },
  {
    name: "webhooks: the drawer keeps naming its event after a replay takes the delivery out of the filter shown",
    run: async env => {
      const { page } = env;
      await page.goto(tab(env, "webhooks"));
      await webhookFaults(0);
      await page.getByRole("button", { name: "Send test ping" }).click();
      await newestDelivery(page, /Delivered/);
      const filter = page.getByRole("group", { name: "Show deliveries" });
      await filter.getByRole("button", { name: "Delivered" }).click();
      await page.locator("table tbody tr").first().getByRole("button", { name: /^Open delivery .+ of ping$/ }).click();
      const drawer = page.getByRole("dialog");
      await expect(drawer.getByRole("heading").first()).toHaveText("ping");
      await drawer.getByRole("button", { name: "Replay this delivery" }).click();
      // Queued again it is pending, so the Delivered list read again leaves it out; the drawer still names it (its
      // title used to come from that list and turned into "Delivery").
      await expect(drawer.getByText(/replayed 1 time/)).toBeVisible({ timeout: 15_000 });
      await expect(drawer.getByRole("heading").first()).toHaveText("ping");
      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await filter.getByRole("button", { name: "All" }).click();
    },
  },
  {
    name: "proofs: refusals say why, an ATA proof is shown once, then listed, revoked with its reason, and filtered",
    run: async env => {
      const { page } = env;
      await page.goto(tab(env, "proofs"));
      const audiences = page.getByRole("textbox", { name: "Apps that may verify it" });
      await audiences.fill("Not An App!");
      await audiences.press("Enter");
      await expect(page.locator("ul[aria-live='polite'] li").first()).toContainText("is not an app id");
      // A refused value comes back into the field (on the next frame) so it can be fixed instead of retyped.
      await expect(audiences).toHaveValue("Not An App!");
      await audiences.fill(APP);
      await audiences.press("Enter");
      await expect(page.locator("ul[aria-live='polite'] li").first()).toContainText("is the app issuing the proof");
      await expect(audiences).toHaveValue(APP);
      await audiences.fill("remind");
      await audiences.press("Enter");
      await expect(page.locator('[data-tag="remind"]')).toHaveCount(1);
      const scopes = page.getByRole("textbox", { name: "Scopes (optional)" });
      await scopes.fill("notify.send");
      await scopes.press("Enter");
      await page.getByRole("button", { name: "5 minutes", exact: true }).click();
      await page.getByRole("button", { name: "Issue the proof" }).click();
      const reveal = page.getByRole("group", { name: "Your proof" });
      await expect(reveal).toBeFocused();
      expect(await revealedSecret(page, "Proof token")).toMatch(/^sap_/);
      await reveal.getByRole("button", { name: "I've stored them" }).click();
      const row = page.locator("li", { hasText: "notify.send" }).filter({ hasText: "Active" }).first();
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: "Revoke", exact: true }).click();
      await page.getByRole("button", { name: "Revoke", exact: true }).first().click();
      await expect(page.getByText(/revoked just now: /).first()).toBeVisible();
      // The Revoke control left with the row's new status; focus is on that status, not the start of the page.
      await expect(page.locator(":focus"), `focus is on ${await focused(page)}`).toHaveAttribute("data-proof-status", /.+/);
      await page.getByRole("button", { name: "Revoked", exact: true }).click();
      await expect(page.locator("li", { hasText: "notify.send" }).first()).toBeVisible();
      await page.getByRole("button", { name: "On behalf of", exact: true }).click();
      await expect(page.locator("li", { hasText: "notify.send" })).toHaveCount(0);
    },
  },
];

/* ------------------------------------------------------------------------------------------------------------------ */
/* Runner                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

async function main(argv: string[]): Promise<void> {
  const value = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const base = value("--live")?.replace(/\/$/, "");
  if (!base) throw new Error("Usage: tsx components/developer/checks.ts --live http://localhost:8590 [--only name,name]");
  const only = (value("--only") ?? "").split(",").map(item => item.trim()).filter(Boolean);
  const selected = checks.filter(check => !only.length || only.some(name => check.name.includes(name)));
  if (!selected.length) throw new Error(`No check matches --only ${only.join(",")}.`);
  const shots = process.env.CHECKS_SHOTS ? resolve(process.env.CHECKS_SHOTS) : null;
  if (shots) mkdirSync(shots, { recursive: true });

  console.log(`Live checks of the developer pages against ${base}, as ${EMAIL}, on ${APP}`);
  const browser = await chromium.launch();
  let failures = 0;
  try {
    const { context, page } = await signIn(base, browser);
    const env: Env = { base, browser, context, page, run: Date.now().toString(36).slice(-5) };
    for (const check of selected) {
      const started = Date.now();
      problems.length = 0;
      try {
        await check.run(env);
      } catch (failure) {
        problems.push(`failed: ${failure instanceof Error ? failure.message.split("\n").slice(0, 8).join(" | ") : String(failure)}`);
      }
      if (problems.length) {
        failures++;
        if (shots) await page.screenshot({ path: join(shots, `${check.name.replace(/[^a-z0-9]+/gi, "-").slice(0, 80)}.png`), fullPage: true }).catch(() => undefined);
        console.log(`✗ ${check.name}\n${problems.map(problem => `    ${problem}`).join("\n")}`);
        // A failed check may leave a dialog or a draft behind; start the next one from a clean page.
        await page.keyboard.press("Escape").catch(() => undefined);
        await saveBar(page).getByRole("button", { name: "Discard" }).click({ timeout: 1000 }).catch(() => undefined);
      } else console.log(`✓ ${check.name} (${Date.now() - started} ms)`);
    }
  } finally {
    await browser.close();
  }
  if (failures) {
    console.error(`\n${failures} of ${selected.length} check(s) failed.`);
    process.exitCode = 1;
  } else console.log(`\nAll ${selected.length} checks passed.`);
}

// Run directly (not when imported).
const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main(process.argv.slice(2)).catch(failure => {
    console.error(`checks: ${failure instanceof Error ? failure.message : String(failure)}`);
    process.exitCode = 1;
  });
}
