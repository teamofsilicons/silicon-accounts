/**
 * The owner's Webhooks tab on the developer site, the endpoint side (developer.teamofsilicons.com
 * /apps/campus-connect/webhooks, owner it@university.test signed in through the developer site's BFF), in the browser: Change URL refuses a bad URL in place (the page's own check, and a 422 only the server can give, shown under
 * the field), Cancel keeps the URL, saving a new URL shows its new signing secret once and the next ping is signed with
 * it; Remove webhook fails what is pending at once and disables "Replay all failed"; setting a URL again, the failed
 * delivery is selected in the table and replayed ("Replay 1 selected") to the new URL with the same event_id; a failed
 * delivery about a Carbon who removed the app's access shows its account details hidden, has no replay button, and
 * replaying it by selection names the server's reason. Two Carbons at university.test (the app allows only that
 * domain) are its members.
 */
import type { Locator, Page } from "@playwright/test";
import type { Journey } from "../../context";
import { DEVELOPER_SIGNED_OUT, newContext, shot, signInOnDeveloper, sleep } from "../../lib";
import {
  ageDelivery,
  drainApp,
  fakeApp,
  getDelivery,
  inboxEvents,
  inboxUrl,
  must,
  newCarbon,
  sameJson,
  setFaults,
  setInboxSecret,
  short,
  signIntoApp,
  sqlRows,
  storedEvents,
  uid,
  waitAttempts,
  waitDelivery,
  waitEvent,
} from "./_helpers";

const APP = "campus-connect";
const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

async function storedUrl(env: Parameters<typeof sqlRows>[0]): Promise<string | null> {
  const [row] = await sqlRows<{ url: string | null }>(env, `select webhook_url as url from app_signin_configs where app_id = '${APP}'`);
  return row?.url ?? null;
}

/** The error a field announces (aria-invalid, and the text of its aria-describedby error message), once it has one. */
async function fieldError(field: Locator, timeoutMs = 8_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await field
      .evaluate(element => {
        if (element.getAttribute("aria-invalid") !== "true") return null;
        const ids = (element.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(id => id.endsWith("-error"));
        return ids.map(id => document.getElementById(id)?.textContent ?? "").join(" ").trim() || null;
      })
      .catch(() => null);
    if (text || Date.now() > deadline) return text;
    await sleep(200);
  }
}

/**
 * Whether a field's error message is really on screen: its row has opened to the full height of the copy and faded in
 * (the row opens on a spring, so a message can exist for assistive tech while the row is still closed).
 */
async function errorShown(field: Locator, timeoutMs = 5_000): Promise<{ shown: boolean; height: number; opacity: number }> {
  const deadline = Date.now() + timeoutMs;
  let last = { shown: false, height: 0, opacity: 0 };
  while (Date.now() < deadline) {
    last = await field
      .evaluate(element => {
        const id = (element.getAttribute("aria-describedby") ?? "").split(/\s+/).find(entry => entry.endsWith("-error"));
        const copy = id ? document.getElementById(id) : null;
        const slot = copy?.parentElement;
        if (!copy || !slot) return { shown: false, height: 0, opacity: 0 };
        const slotHeight = slot.getBoundingClientRect().height;
        const copyHeight = copy.getBoundingClientRect().height;
        const opacity = Number(getComputedStyle(slot).opacity);
        return { shown: copyHeight > 8 && slotHeight >= copyHeight - 1 && opacity > 0.95, height: Math.round(slotHeight), opacity };
      })
      .catch(() => last);
    if (last.shown) return last;
    await sleep(150);
  }
  return last;
}

/** Reads the secret a SecretReveal shows (masked first, then revealed), and says whether it was masked. */
async function readSecret(page: Page, title: string): Promise<{ masked: boolean; secret: string }> {
  const reveal = page.getByRole("group", { name: title });
  await reveal.waitFor({ timeout: 20_000 });
  const masked = (await reveal.locator("code").first().innerText()).trim();
  await reveal.getByRole("button", { name: "Show the signing secret" }).click();
  await sleep(300);
  const secret = (await reveal.locator("code").first().innerText()).trim();
  return { masked: /^whsec_•+$/.test(masked), secret };
}

export const journey: Journey = {
  name: "webhooks-developer-ui-endpoint",
  title: "the owner's Webhooks tab on the developer site: Change URL (refused in place by the page and by the server, Cancel, new secret shown once and used), Remove webhook (pending fails, Replay all failed disabled), set it again and Replay 1 selected, a skipped replay's reason shown",
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const { env, results, browser } = ctx;
    const original = inboxUrl(env, APP);
    const pending = await drainApp(env, APP);
    results.check(`setup: ${APP} has no pending delivery`, pending === 0, `${pending} pending`);
    const stays = await newCarbon(ctx, "unistays", { email: `wh.unistays+${uid()}@university.test` });
    const leaves = await newCarbon(ctx, "unileaves", { email: `wh.unileaves+${uid()}@university.test` });
    await signIntoApp(ctx, stays, APP);
    await signIntoApp(ctx, leaves, APP);
    const sink = `hooks/wh-ui2-${uid()}`;
    const sinkUrl = `${env.apps}/${sink}`;
    const context = await newContext(browser);
    const page: Page = await context.newPage();
    // The 422 the journey asks the server for is logged by the browser as a failed resource load, and so is the developer
    // site's signed-out session probe before signing in.
    results.watch(page, "dev-webhook-endpoint", [/status of 422/, DEVELOPER_SIGNED_OUT]);
    try {
      await signInOnDeveloper(env, page, fakeApp(APP).owner_email, { returnTo: `/apps/${APP}/webhooks` });
      if (!page.url().startsWith(`${env.developer}/apps/${APP}/webhooks`)) await page.goto(`${env.developer}/apps/${APP}/webhooks`);
      const tab = page.getByRole("tabpanel", { name: "Webhooks" });
      await tab.getByRole("button", { name: "Send test ping" }).waitFor({ timeout: 30_000 });
      results.check("the tab shows the app's webhook URL", await tab.getByText(original, { exact: true }).isVisible(), original);

      // ---- Change URL: refused in place ---------------------------------------------------------------------------------
      await tab.getByRole("button", { name: "Change URL" }).click();
      const field = tab.getByLabel("New webhook URL");
      await field.waitFor({ timeout: 10_000 });
      results.check("Change URL opens the field filled with the current URL", (await field.inputValue()) === original, await field.inputValue());
      await field.fill("ftp://example.com/hooks");
      await tab.getByRole("button", { name: "Save the new URL" }).click();
      const pageError = await fieldError(field);
      const pageErrorShown = await errorShown(field);
      await sleep(400);
      results.check("an ftp:// URL is refused under the field (on screen, and announced as the field's error), saying what is allowed; nothing is saved", /must use https \(or http in development\)/.test(pageError ?? "") && pageErrorShown.shown && (await storedUrl(env)) === original, `${pageError ?? "no error"}; on screen: ${JSON.stringify(pageErrorShown)}`);
      await shot(env, page, "wh-ui2-01-url-refused");
      // Short enough for the page's check (2048 characters), too long for the server's once the é are encoded (%C3%A9).
      const overlong = `${env.apps}/hooks/${"é".repeat(400)}`;
      await field.fill(overlong);
      // The page saves through the developer site's BFF: PUT /api/accounts/apps/<app>/webhook → the API's PUT /v1/apps/<app>/webhook.
      const answered = page.waitForResponse(response => response.url() === `${env.developer}/api/accounts/apps/${APP}/webhook` && response.request().method() === "PUT", { timeout: 15_000 }).catch(() => null);
      await tab.getByRole("button", { name: "Save the new URL" }).click();
      const response = await answered;
      const serverError = await fieldError(field);
      const serverErrorShown = await errorShown(field);
      await sleep(400);
      results.check("a URL only the server can refuse (over 2048 characters once encoded): its 422 field message shows under the field, nothing saved", response?.status() === 422 && /longer than 2048 characters once encoded/.test(serverError ?? "") && serverErrorShown.shown && (await storedUrl(env)) === original, `HTTP ${response?.status() ?? "none"}; ${(serverError ?? "no error").slice(0, 200)}; on screen: ${JSON.stringify(serverErrorShown)}`);
      await shot(env, page, "wh-ui2-01b-url-refused-by-server");
      await tab.getByRole("button", { name: "Cancel" }).click();
      await tab.getByRole("button", { name: "Change URL" }).waitFor({ timeout: 10_000 });
      results.check("Cancel goes back to the current URL, unchanged", (await tab.getByText(original, { exact: true }).isVisible()) && (await storedUrl(env)) === original);

      // ---- Change URL: saved, new secret shown once and used ----------------------------------------------------------------
      await tab.getByRole("button", { name: "Change URL" }).click();
      await field.fill(sinkUrl);
      await tab.getByRole("button", { name: "Save the new URL" }).click();
      const first = await readSecret(page, "Your webhook signing secret");
      results.check("saving a new URL shows its new signing secret, masked until revealed", first.masked && /^whsec_[A-Za-z0-9_-]{43}$/.test(first.secret), `${first.secret.slice(0, 10)}…`);
      await tab.getByText(sinkUrl, { exact: true }).waitFor({ timeout: 10_000 }).catch(() => undefined);
      results.check("…the new URL is stored and shown", (await storedUrl(env)) === sinkUrl && (await tab.getByText(sinkUrl, { exact: true }).isVisible()), String(await storedUrl(env)));
      await shot(env, page, "wh-ui2-02-new-url-secret");
      await setInboxSecret(env, sink, first.secret);
      const reveal = page.getByRole("group", { name: "Your webhook signing secret" });
      await reveal.getByRole("button", { name: "I've stored it" }).click();
      await sleep(400);
      results.check("…and it is gone once stored", !(await reveal.isVisible().catch(() => false)));
      await tab.getByRole("button", { name: "Send test ping" }).click();
      const pinged = await waitEvent(env, sink, { type: "ping" });
      results.check("Send test ping goes to the new URL, signed with the secret the page showed (nothing refused)", !!pinged && ((await inboxEvents(env, sink, { uuid: "none" })).rejected ?? []).length === 0, pinged?.event_id ?? "nothing in 25 s");

      // ---- Remove webhook with a delivery pending ----------------------------------------------------------------------------
      await setFaults(env, sink, 1000, 500);
      let since = Date.now();
      must("a member renames", await stays.visitor.call("PATCH", "/v1/me", { json: { display_name: `WH Uni ${uid()}` } }), 200);
      const [held] = await storedEvents(env, { account: stays.uuid, type: "account.updated", target: APP, afterMs: since - 1 });
      if (!held) throw new Error(`no account.updated was stored for ${APP}`);
      const firstAttempt = await waitAttempts(env, held.delivery_id, 1);
      results.check("setup: the member's account.updated is pending at the failing URL", firstAttempt?.status === "pending" && firstAttempt.last_status === 500, short(firstAttempt));
      await tab.getByRole("button", { name: "Remove webhook" }).click();
      await tab.getByRole("button", { name: "Remove", exact: true }).click({ timeout: 10_000 });
      const save = tab.getByRole("button", { name: "Save the webhook URL" });
      await save.waitFor({ timeout: 15_000 }).catch(() => undefined);
      results.check("Remove webhook: confirmed in place; the tab then asks for a URL and none is stored", (await save.isVisible()) && (await tab.getByLabel("Webhook URL", { exact: true }).isVisible()) && (await storedUrl(env)) === null, String(await storedUrl(env)));
      const failedNow = await getDelivery(env, APP, held.delivery_id);
      results.check("…the pending delivery failed at once, saying the URL was removed and to replay it after setting a new one", failedNow.status === "failed" && /removed its webhook URL/.test(failedNow.last_error ?? "") && /replay/i.test(failedNow.last_error ?? ""), short({ status: failedNow.status, last_error: failedNow.last_error }));
      results.check("…and Replay all failed is disabled while there is no URL", await tab.getByRole("button", { name: "Replay all failed" }).isDisabled());
      await shot(env, page, "wh-ui2-03-removed");

      // ---- set it again, then replay the failed delivery by selecting it ------------------------------------------------------
      await tab.getByLabel("Webhook URL", { exact: true }).fill(original);
      await save.click();
      const second = await readSecret(page, "Your webhook signing secret");
      results.check("setting the URL again shows another new secret", second.masked && /^whsec_/.test(second.secret) && second.secret !== first.secret);
      await setInboxSecret(env, APP, second.secret, false);
      await page.getByRole("group", { name: "Your webhook signing secret" }).getByRole("button", { name: "I've stored it" }).click();
      await setFaults(env, sink, 0);
      await tab.getByRole("group", { name: "Show deliveries" }).getByRole("button", { name: "Failed" }).click();
      await tab.getByRole("button", { name: "Refresh deliveries" }).click();
      const heldRow = tab.getByRole("row").filter({ has: page.getByRole("button", { name: `Open delivery ${shortId(held.delivery_id)} of account.updated` }) });
      await heldRow.waitFor({ timeout: 20_000 });
      await heldRow.getByRole("checkbox").check();
      const replaySelected = tab.getByRole("button", { name: "Replay 1 selected" });
      await replaySelected.waitFor({ timeout: 10_000 });
      await replaySelected.click();
      const queued = tab.getByText("1 delivery queued again");
      await queued.waitFor({ timeout: 15_000 }).catch(() => undefined);
      results.check("Replay 1 selected: the alert says 1 delivery queued again", await queued.isVisible().catch(() => false));
      const arrived = await waitEvent(env, APP, { event_id: held.event_id });
      results.check("…the fake app receives it at the URL set again, same event_id and payload, signed with the newest secret", !!arrived && !arrived.recovered && sameJson(arrived.payload, held.payload), arrived?.event_id ?? "nothing in 25 s");
      const replayed = await waitDelivery(env, APP, held.delivery_id, d => d.status === "delivered" && d.manual_replays === 1);
      results.check("…and the API shows it delivered there (manual_replays 1)", !!replayed && replayed.url === original, short(replayed && { status: replayed.status, url: replayed.url, manual_replays: replayed.manual_replays }));
      await shot(env, page, "wh-ui2-04-replayed-selected");
      await tab.getByRole("button", { name: "Dismiss: 1 delivery queued again" }).click().catch(() => undefined);

      // ---- a delivery the app may no longer receive -------------------------------------------------------------------------
      await setFaults(env, APP, 1000, 500);
      since = Date.now();
      must("the other member renames", await leaves.visitor.call("PATCH", "/v1/me", { json: { display_name: `WH Uni ${uid()}` } }), 200);
      const [withheld] = await storedEvents(env, { account: leaves.uuid, type: "account.updated", target: APP, afterMs: since - 1 });
      if (!withheld) throw new Error(`no account.updated was stored for ${APP}`);
      await waitAttempts(env, withheld.delivery_id, 1);
      await ageDelivery(env, withheld.delivery_id, 72);
      const gaveUp = await waitAttempts(env, withheld.delivery_id, 2);
      await setFaults(env, APP, 0);
      must("the other member removes the app's access", await leaves.visitor.call("DELETE", `/v1/me/apps/${APP}`), [200, 204]);
      const removed = await waitEvent(env, APP, { type: "membership.access_removed", uuid: leaves.uuid });
      results.check("setup: the member's account.updated failed for good, then it removed the app's access (the app was told)", gaveUp?.status === "failed" && !!removed, short(gaveUp));
      await tab.getByRole("button", { name: "Refresh deliveries" }).click();
      const open = tab.getByRole("button", { name: `Open delivery ${shortId(withheld.delivery_id)} of account.updated` });
      await open.waitFor({ timeout: 20_000 });
      await open.click();
      const drawer = page.getByRole("dialog");
      const hidden = drawer.getByText("Account details are hidden");
      await hidden.waitFor({ timeout: 15_000 }).catch(() => undefined);
      results.check("the drawer of that delivery says its account details are hidden and offers no replay", (await hidden.isVisible()) && (await drawer.getByRole("button", { name: "Replay this delivery" }).count()) === 0, (await drawer.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300));
      const title = (await drawer.getByRole("heading").first().innerText().catch(() => "")).trim();
      results.check("…and is titled with its event (account.updated)", title === "account.updated", `drawer title "${title}"`);
      await sleep(600);
      await shot(env, page, "wh-ui2-05-withheld-drawer");
      await page.keyboard.press("Escape");
      await sleep(600);
      const withheldRow = tab.getByRole("row").filter({ has: page.getByRole("button", { name: `Open delivery ${shortId(withheld.delivery_id)} of account.updated` }) });
      await withheldRow.getByRole("checkbox").check();
      await tab.getByRole("button", { name: "Replay 1 selected" }).click();
      const nothing = tab.getByText("Nothing was replayed");
      await nothing.waitFor({ timeout: 15_000 }).catch(() => undefined);
      const alertText = (await tab.getByRole("status").filter({ hasText: "Nothing was replayed" }).first().innerText().catch(() => "")).replace(/\s+/g, " ");
      results.check(
        "replaying it by selection: \"Nothing was replayed\", the delivery named with the server's reason",
        (await nothing.isVisible()) && alertText.includes("1 delivery was skipped") && alertText.includes(shortId(withheld.delivery_id)) && /Not replayed because/.test(alertText),
        alertText.slice(0, 400),
      );
      const stillFailed = await getDelivery(env, APP, withheld.delivery_id);
      results.check("…and it stays failed, never sent (manual_replays 0)", stillFailed.status === "failed" && stillFailed.manual_replays === 0 && stillFailed.payload_redacted === true, short({ status: stillFailed.status, manual_replays: stillFailed.manual_replays, redacted: stillFailed.payload_redacted }));
      await shot(env, page, "wh-ui2-06-skipped");
    } finally {
      await setFaults(env, APP, 0).catch(() => undefined);
      await setFaults(env, sink, 0).catch(() => undefined);
      // Leave the app as the fake app server expects it: its own inbox, with a secret the inbox knows.
      if ((await storedUrl(env).catch(() => original)) !== original) {
        const answer = await fetch(`${env.apps}/${APP}/_connect-webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => null);
        results.check("cleanup: the app's webhook points back at its fake app", answer?.status === 200, String(answer?.status));
      }
      await context.close();
    }
  },
};
