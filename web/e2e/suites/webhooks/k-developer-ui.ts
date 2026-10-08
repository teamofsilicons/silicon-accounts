/**
 * The app owner's Webhooks tab on the developer site (developers.teamofsilicons.com: /apps/<app>/webhooks, UNDERSTANDING.md
 * v2: "set up the app's webhook, and see and replay its deliveries"), in the browser: the owner signs in through the
 * developer site's BFF (the account site's hosted sign-in as the first-party app `developer`); the account site's old
 * address of the tab (/developer/<app>/webhooks) lands there; the endpoint and the event list, "Send test ping" (the fake
 * app receives it), a delivery that failed for good (the fake app fails, time travel ends its 72 hours) opened in the
 * drawer with its attempts and payload and replayed from there (same event_id), "Replay all failed", and "Rotate secret"
 * (the new secret is shown once; the fake app is given that value and verifies the next ping with it). Every call the
 * page makes goes through the BFF (/api/accounts/…), never to the API with a token in the browser. The app is ledgerly,
 * whose owner is the seeded c:ledgerly-dev.
 */
import type { Locator, Page } from "@playwright/test";
import type { Journey } from "../../context";
import { DEVELOPER_SIGNED_OUT, newContext, shot, signInOnDeveloper, sleep } from "../../lib";
import { ageDelivery, drainApp, fakeApp, inboxEvents, inboxUrl, setFaults, setInboxSecret, short, sqlRows, waitAttempts, waitDelivery, waitEvent } from "./_helpers";

const APP = "ledgerly";
const EVENT_TYPES = ["account.id_changed", "account.updated", "account.deleted", "membership.signed_out", "membership.access_removed", "silicon.custodian_changed", "ping"];

/** The delivery id of the newest ping to the app created after `since` (ms). */
async function newestPing(env: Parameters<typeof sqlRows>[0], since: number, timeoutMs = 15_000): Promise<{ id: string; event_id: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await sqlRows<{ id: string; event_id: string }>(env, `select d.id::text, d.event_id::text from webhook_deliveries d join webhook_events e on e.event_id = d.event_id where d.target_id = '${APP}' and e.type = 'ping' and d.created_at > to_timestamp(${since / 1000}) order by d.created_at desc limit 1`);
    if (row) return row;
    await sleep(250);
  }
  return null;
}

const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

/** A locator's text once `settled` holds (badges cross-fade their labels), or the last text after `timeoutMs`. */
async function settledText(locator: Locator, settled: (text: string) => boolean, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = (await locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (settled(text)) return text;
    await sleep(250);
  }
  return text;
}

export const journey: Journey = {
  name: "webhooks-developer-ui",
  title: "the owner's Webhooks tab on the developer site (signed in through its BFF; the account site's old address lands there): endpoint and events, Send test ping, a failed delivery's attempts and payload in the drawer, Replay this delivery, Replay all failed, Rotate secret (shown once, then in use)",
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const { env, results, browser } = ctx;
    const pending = await drainApp(env, APP);
    results.check(`setup: ${APP} has no pending delivery`, pending === 0, `${pending} pending`);
    const context = await newContext(browser);
    const page: Page = await context.newPage();
    results.watch(page, "dev-webhooks", [DEVELOPER_SIGNED_OUT]);
    // Once signed in, the developer site's pages reach Silicon Accounts only through its BFF (/api/accounts/…): no request
    // from the browser to any /v1/ address (the hosted sign-in before that is the account site's own page).
    let recording = false;
    const direct: string[] = [];
    let viaBff = 0;
    page.on("request", request => {
      if (!recording) return;
      const url = new URL(request.url());
      if (url.origin === env.developer && url.pathname.startsWith("/api/accounts/")) viaBff += 1;
      else if (url.pathname.startsWith("/v1/") || request.url().startsWith(env.api)) direct.push(`${request.method()} ${request.url()}`);
    });
    try {
      const signInStarted = Date.now();
      await signInOnDeveloper(env, page, fakeApp(APP).owner_email, { returnTo: `/apps/${APP}/webhooks` });
      results.metric("owner signs in to the developer site (BFF)", Date.now() - signInStarted, "ms");
      recording = true;
      const tab = page.getByRole("tabpanel", { name: "Webhooks" });
      await tab.getByRole("button", { name: "Send test ping" }).waitFor({ timeout: 30_000 });
      results.check("signed in through the BFF, the owner lands on the developer site's Webhooks tab", page.url() === `${env.developer}/apps/${APP}/webhooks`, page.url());
      // The account site's old address of this tab redirects to it (UNDERSTANDING.md v2: building apps lives on the developer site).
      const old = await page.request.get(`${env.site}/developer/${APP}/webhooks`, { maxRedirects: 0 });
      results.check("the account site's old /developer/<app>/webhooks answers a redirect to the developer site's Webhooks tab", [301, 302, 303, 307, 308].includes(old.status()) && old.headers().location === `${env.developer}/apps/${APP}/webhooks`, `${old.status()} → ${old.headers().location ?? "no Location"}`);
      await page.goto(`${env.site}/developer/${APP}/webhooks`);
      await tab.getByRole("button", { name: "Send test ping" }).waitFor({ timeout: 30_000 });
      results.check("…and following it in the browser opens the tab, still signed in", page.url() === `${env.developer}/apps/${APP}/webhooks`, page.url());

      // ---- the BFF's CSRF guard on the webhook's state-changing calls ----------------------------------------------------
      // The browser's cookie rides along on a cross-site request; the developer site refuses it before it reaches the API.
      const secretOf = async () => (await sqlRows<{ s: string }>(env, `select md5(coalesce(webhook_secret_enc::text, '')) as s from app_signin_configs where app_id = '${APP}'`))[0]?.s ?? "";
      const pingsOf = async () => (await sqlRows<{ n: number }>(env, `select count(*)::int as n from webhook_events where target_id = '${APP}' and type = 'ping'`))[0]?.n ?? 0;
      const [secretBefore, pingsBefore] = [await secretOf(), await pingsOf()];
      const crossPing = await page.request.post(`${env.developer}/api/accounts/apps/${APP}/webhook/test`, { headers: { origin: "https://evil.example" } });
      const crossRotate = await page.request.post(`${env.developer}/api/accounts/apps/${APP}/webhook/rotate-secret`, { headers: { origin: "https://evil.example" } });
      const crossReplay = await page.request.post(`${env.developer}/api/accounts/apps/${APP}/webhook/replay`, { headers: { origin: "https://evil.example", "content-type": "application/json" }, data: JSON.stringify({ status: "failed" }) });
      const codes = await Promise.all([crossPing, crossRotate, crossReplay].map(async answer => `${answer.status()} ${((await answer.json().catch(() => ({}))) as { error?: { code?: string } }).error?.code ?? ""}`));
      results.check(
        "the developer site's BFF refuses a cross-site test ping, secret rotation or replay carrying the owner's cookie (403 cross_site_request), and nothing reaches the API (no ping stored, the secret unchanged)",
        codes.every(code => code === "403 cross_site_request") && (await pingsOf()) === pingsBefore && (await secretOf()) === secretBefore,
        `${codes.join(" | ")}; pings ${pingsBefore} → ${await pingsOf()}`,
      );
      results.check("the tab shows the app's webhook URL and that a whsec_ secret signs it (never the secret)", await tab.getByText(inboxUrl(env, APP), { exact: true }).isVisible() && await tab.getByText(/Signed with a whsec_ secret/).isVisible() && !/whsec_[A-Za-z0-9_-]{20}/.test(await tab.innerText()), inboxUrl(env, APP));
      await tab.getByRole("button", { name: "Events" }).click();
      await sleep(500);
      const listed = await tab.innerText();
      const missing = EVENT_TYPES.filter(type => !listed.includes(type));
      results.check("the Events list names all seven app event types", missing.length === 0, missing.join(", ") || "all listed");
      await shot(env, page, "wh-ui-01-tab");

      // ---- Send test ping ---------------------------------------------------------------------------------------------
      let since = Date.now() - 500;
      let seq = (await inboxEvents(env, APP, { uuid: "none" })).last_seq;
      await tab.getByRole("button", { name: "Send test ping" }).click();
      const pinged = await waitEvent(env, APP, { type: "ping", after: seq });
      results.check("Send test ping: the fake app receives a signed ping", !!pinged, pinged?.event_id ?? "nothing in 25 s");
      const first = await newestPing(env, since);
      if (!first) throw new Error("the ping's delivery was not stored");
      await waitDelivery(env, APP, first.id, d => d.status === "delivered");
      await tab.getByRole("button", { name: "Refresh deliveries" }).click();
      const firstRow = tab.getByRole("row").filter({ has: page.getByRole("button", { name: `Open delivery ${shortId(first.id)} of ping` }) });
      await firstRow.waitFor({ timeout: 20_000 });
      const firstText = await settledText(firstRow, text => /Delivered/.test(text) && !/Retrying/.test(text));
      results.check("the deliveries table lists the ping as Delivered (1 attempt, HTTP 200)", /Delivered/.test(firstText) && !/Retrying/.test(firstText) && /HTTP 200/.test(firstText), firstText);
      await shot(env, page, "wh-ui-02-pinged");

      // ---- a delivery that failed for good, opened and replayed in the drawer -------------------------------------------
      await setFaults(env, APP, 1000, 500);
      since = Date.now() - 500;
      await tab.getByRole("button", { name: "Send test ping" }).click();
      const failing = await newestPing(env, since);
      if (!failing) throw new Error("the second ping's delivery was not stored");
      await waitAttempts(env, failing.id, 1);
      await ageDelivery(env, failing.id, 72);
      const gaveUp = await waitAttempts(env, failing.id, 2);
      await setFaults(env, APP, 0);
      results.check("setup: the ping failed for good (two HTTP 500s, 72 hours)", gaveUp?.status === "failed", short(gaveUp));
      await tab.getByRole("group", { name: "Show deliveries" }).getByRole("button", { name: "Failed" }).click();
      await tab.getByRole("button", { name: "Refresh deliveries" }).click();
      const open = tab.getByRole("button", { name: `Open delivery ${shortId(failing.id)} of ping` });
      await open.waitFor({ timeout: 20_000 });
      const failedRow = tab.getByRole("row").filter({ has: page.getByRole("button", { name: `Open delivery ${shortId(failing.id)} of ping` }) });
      const failedText = await settledText(failedRow, text => /Failed/.test(text) && !/Retrying/.test(text) && /HTTP 500/.test(text));
      results.check("the Failed filter shows it with status Failed (only), 2 attempts and HTTP 500", /Failed/.test(failedText) && !/Retrying/.test(failedText) && /HTTP 500/.test(failedText) && /\b2\b/.test(failedText), failedText);
      await open.click();
      const drawer = page.getByRole("dialog");
      await drawer.getByRole("button", { name: "Replay this delivery" }).waitFor({ timeout: 20_000 });
      const attempts = drawer.getByRole("region", { name: "Attempts" }).or(drawer.locator("section[aria-label=Attempts]"));
      const attemptsText = (await attempts.innerText()).replace(/\s+/g, " ");
      results.check("the drawer lists both attempts with HTTP 500 and the fake app's answer", (attemptsText.match(/HTTP 500/g) ?? []).length >= 2 && /Simulated failure/.test(attemptsText), attemptsText.slice(0, 300));
      const drawerText = (await drawer.innerText()).replace(/\s+/g, " ");
      results.check("the drawer shows the event id and the payload", drawerText.includes(failing.event_id) && /Payload/.test(drawerText), drawerText.slice(0, 300));
      await shot(env, page, "wh-ui-03-drawer");
      seq = (await inboxEvents(env, APP, { uuid: "none" })).last_seq;
      await drawer.getByRole("button", { name: "Replay this delivery" }).click();
      const replayed = await waitEvent(env, APP, { event_id: failing.event_id, after: seq });
      results.check("Replay this delivery: the fake app receives the ping again with the same event_id", !!replayed);
      const afterReplay = await waitDelivery(env, APP, failing.id, d => d.status === "delivered" && d.manual_replays === 1);
      results.check("…and the API shows it delivered, manual_replays 1", !!afterReplay, short(afterReplay && { status: afterReplay.status, manual_replays: afterReplay.manual_replays }));
      const replayedNote = drawer.getByText(/replayed 1 time/);
      await replayedNote.waitFor({ timeout: 15_000 }).catch(() => undefined);
      results.check("…and the drawer updates to \"replayed 1 time\"", await replayedNote.isVisible().catch(() => false), (await drawer.innerText()).replace(/\s+/g, " ").slice(0, 200));
      await sleep(1000);
      const title = (await drawer.getByRole("heading").first().innerText().catch(() => "")).trim();
      results.check("…and the drawer still names the event it shows (ping) after the replay moved it out of the Failed filter", title === "ping", `drawer title "${title}"`);
      await shot(env, page, "wh-ui-04-replayed");
      await page.keyboard.press("Escape");
      await sleep(600);

      // ---- Replay all failed ----------------------------------------------------------------------------------------------
      await setFaults(env, APP, 1000, 500);
      since = Date.now() - 500;
      await tab.getByRole("button", { name: "Send test ping" }).click();
      const third = await newestPing(env, since);
      if (!third) throw new Error("the third ping's delivery was not stored");
      await waitAttempts(env, third.id, 1);
      await ageDelivery(env, third.id, 72);
      await waitAttempts(env, third.id, 2);
      await setFaults(env, APP, 0);
      await tab.getByRole("button", { name: "Refresh deliveries" }).click();
      await tab.getByRole("button", { name: `Open delivery ${shortId(third.id)} of ping` }).waitFor({ timeout: 20_000 });
      seq = (await inboxEvents(env, APP, { uuid: "none" })).last_seq;
      await tab.getByRole("button", { name: "Replay all failed" }).click();
      await tab.getByRole("button", { name: "Replay", exact: true }).click({ timeout: 10_000 });
      const alert = tab.getByText(/queued again/);
      await alert.waitFor({ timeout: 15_000 }).catch(() => undefined);
      results.check("Replay all failed: confirmed in place, then an alert says how many were queued again", await alert.isVisible().catch(() => false), (await tab.innerText()).replace(/\s+/g, " ").match(/[^.]*queued again[^.]*/)?.[0] ?? "no alert");
      results.check("Replay all failed: the fake app receives the failed ping, same event_id", !!(await waitEvent(env, APP, { event_id: third.event_id, after: seq })));
      await shot(env, page, "wh-ui-05-replay-all");

      // ---- Rotate secret ----------------------------------------------------------------------------------------------------
      await tab.getByRole("button", { name: "Rotate secret" }).click();
      await tab.getByRole("button", { name: "Rotate", exact: true }).click({ timeout: 10_000 });
      const reveal = page.getByRole("group", { name: "Your new webhook signing secret" });
      await reveal.waitFor({ timeout: 20_000 });
      const masked = await reveal.locator("code").first().innerText();
      await reveal.getByRole("button", { name: "Show the signing secret" }).click();
      await sleep(300);
      const secret = (await reveal.locator("code").first().innerText()).trim();
      results.check("Rotate secret: the new secret is shown once, masked until revealed", /^whsec_•+$/.test(masked.trim()) && /^whsec_[A-Za-z0-9_-]{43}$/.test(secret), `${masked.trim().slice(0, 12)}… → ${secret.slice(0, 10)}…`);
      await shot(env, page, "wh-ui-06-rotated");
      await setInboxSecret(env, APP, secret, false);
      await reveal.getByRole("button", { name: "I've stored it" }).click();
      await sleep(400);
      results.check("…and is gone once stored", !(await reveal.isVisible().catch(() => false)));
      seq = (await inboxEvents(env, APP, { uuid: "none" })).last_seq;
      await tab.getByRole("button", { name: "Send test ping" }).click();
      const signedNew = await waitEvent(env, APP, { type: "ping", after: seq });
      results.check("after rotating, the next ping verifies with exactly the secret the page showed", !!signedNew && (await inboxEvents(env, APP, { after: seq })).rejected?.filter(entry => entry.seq > seq).length === 0, signedNew?.event_id ?? "refused or missing");
      const last = signedNew ? await sqlRows<{ id: string }>(env, `select id::text from webhook_deliveries where event_id = '${signedNew.event_id}'`) : [];
      if (last[0]) results.check("…and the delivery is recorded delivered", !!(await waitDelivery(env, APP, last[0].id, d => d.status === "delivered")));
      results.check("signed in, the developer site's pages reached Silicon Accounts only through its BFF (/api/accounts/…), never /v1 from the browser", direct.length === 0 && viaBff > 0, `${viaBff} BFF calls; direct: ${short(direct.slice(0, 6))}`);
    } finally {
      await setFaults(env, APP, 0).catch(() => undefined);
      await context.close();
    }
  },
};
