/**
 * The Webhooks tab (UNDERSTANDING "Webhooks"): Orbit Games' owner works with its endpoint and deliveries on the
 * developer site. The fake app's inbox (and a generic sink of the testkit) verify every signature, dedupe by event_id
 * and fail on request. A URL that is not one is stopped in place; a test ping is delivered (drawer: attempt, payload)
 * and a replay re-sends the same event_id; against a failing endpoint a delivery keeps retrying (no replay while it
 * does), gives up after 72 hours (SQL time travel) and is replayed from the Failed filter; a new URL comes with a new
 * signing secret shown once (masked, never stored in the page or the API's answers); a rotated secret signs the next
 * delivery; removing the webhook fails what was pending. The app's own webhook is put back at the end.
 */
import type { Journey } from "../../context";
import { developerApi, json, shot, sleep, sql, tag } from "../../lib";
import { appDetail, ownerSignIn, pressSegment } from "./_helpers";
import { inboxFaults, inboxSecret, readInbox, until } from "./_kit";

const APP = "orbit-games";

interface Delivery {
  id: string;
  event_id: string;
  type: string;
  status: "pending" | "delivered" | "failed";
  attempts: number | unknown[];
  attempt_count?: number;
  last_status: number | null;
  manual_replays: number;
  url?: string;
}

const shortId = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);

export const journey: Journey = {
  name: "developer-site-webhooks",
  title: "the Webhooks tab: a wrong URL stopped in place; a test ping delivered (attempt and payload in its drawer) and replayed with the same event_id; a failing endpoint retried (no replay while retrying), given up after 72 h (time travel) and replayed from Failed; a new URL with its secret shown once; a rotated secret signing the next delivery; removing the webhook failing what was pending",
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const inbox = `${env.apps}/${APP}`;
    const sink = `${env.apps}/hooks/ds-${t}`;
    const seededUrl = `${env.apps}/${APP}/webhooks`;
    await inboxFaults(inbox, 0);
    const { context, page } = await ownerSignIn(ctx, APP, { label: "webhooks", returnTo: `/apps/${APP}/webhooks` });
    const deliveries = async (): Promise<Delivery[]> => (await developerApi<{ items?: Delivery[] }>(env, page, `/apps/${APP}/webhook/deliveries?limit=100`)).body.items ?? [];
    const delivery = async (id: string): Promise<Delivery | null> => {
      const answer = await developerApi<Delivery>(env, page, `/apps/${APP}/webhook/deliveries/${id}`);
      return answer.status === 200 ? answer.body : null;
    };
    const seen = new Set<string>();
    const ping = async (): Promise<Delivery | null> => {
      for (const item of await deliveries()) seen.add(item.id);
      await page.getByRole("button", { name: "Send test ping" }).click();
      const found = await until(async () => (await deliveries()).find(item => item.type === "ping" && !seen.has(item.id)) ?? null, 15_000);
      if (found) seen.add(found.id);
      return found;
    };
    const refresh = async () => {
      await page.getByRole("button", { name: "Refresh deliveries" }).click();
      await sleep(800);
    };
    const rowOf = (id: string) => page.locator("table tbody tr").filter({ has: page.getByRole("button", { name: `Open delivery ${shortId(id)} of`, exact: false }) });
    const rowSays = async (id: string, wanted: RegExp[]): Promise<{ ok: boolean; text: string }> => {
      let text = "";
      for (let attempt = 0; attempt < 10; attempt++) {
        text = (await rowOf(id).innerText({ timeout: 1_000 }).catch(() => "")).replace(/\s+/g, " ");
        if (wanted.every(pattern => pattern.test(text))) return { ok: true, text };
        await refresh();
      }
      return { ok: false, text };
    };
    const drawer = page.getByRole("dialog");
    const openDrawer = async (id: string) => {
      await rowOf(id).getByRole("button", { name: /^Open delivery/ }).click();
      await drawer.getByRole("region", { name: "Attempts" }).waitFor({ timeout: 10_000 });
      await sleep(500);
    };
    const closeDrawer = async () => {
      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    };
    const revealSecret = async (title: string): Promise<{ masked: string; secret: string; text: string }> => {
      const reveal = page.getByRole("group", { name: title });
      await reveal.waitFor({ timeout: 15_000 });
      const masked = ((await reveal.locator("code").first().textContent()) ?? "").trim();
      await reveal.getByRole("button", { name: "Show the signing secret" }).click();
      const secret = ((await reveal.locator("code[data-shown]").first().textContent()) ?? "").trim();
      const text = (await reveal.innerText()).replace(/\s+/g, " ");
      await reveal.getByRole("button", { name: "I've stored it" }).click();
      await reveal.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
      return { masked, secret, text };
    };
    try {
      const panel = page.getByRole("tabpanel", { name: "Webhooks" });
      await panel.getByText(seededUrl).first().waitFor({ timeout: 30_000 });
      const app = await developerApi<{ webhook?: { url: string | null; secret_set: boolean } }>(env, page, `/apps/${APP}`);
      results.check("the endpoint shows Orbit Games' webhook URL, signed with a whsec_ secret that is never shown again (the API only says one is set)", (await panel.getByText(/Signed with a whsec_ secret \(stored encrypted, never shown again\)/).count()) === 1 && app.body.webhook?.url === seededUrl && app.body.webhook.secret_set === true && !JSON.stringify(app.body).includes("whsec_"), JSON.stringify(app.body.webhook));

      // A URL that is not one is stopped in place, and Cancel keeps the old one.
      await panel.getByRole("button", { name: "Change URL" }).click();
      const newUrl = panel.getByRole("textbox", { name: "New webhook URL" });
      await newUrl.fill("ftp://orbit.example/hooks");
      await panel.getByRole("button", { name: "Save the new URL" }).click();
      await sleep(300);
      const ftpError = (await panel.locator('[role="alert"], [id$="-error"]').allInnerTexts()).join(" ").replace(/\s+/g, " ");
      await newUrl.fill("orbit hooks");
      await panel.getByRole("button", { name: "Save the new URL" }).click();
      await sleep(300);
      const textError = (await panel.locator('[role="alert"], [id$="-error"]').allInnerTexts()).join(" ").replace(/\s+/g, " ");
      await panel.getByRole("button", { name: "Cancel" }).click();
      const unchanged = (await developerApi<{ webhook?: { url: string | null } }>(env, page, `/apps/${APP}`)).body.webhook?.url;
      results.check("an ftp:// address and words that are no URL are refused next to the field; Cancel keeps the stored URL", ftpError.length > 0 && textError.length > 0 && unchanged === seededUrl && (await panel.getByText(seededUrl).count()) > 0, `${ftpError.slice(0, 120)} | ${textError.slice(0, 120)}`);

      // A test ping: delivered, its signature verified by the app, its drawer.
      const pingStarted = Date.now();
      const first = await ping();
      const delivered = first ? await until(async () => ((await delivery(first.id))?.status === "delivered" ? delivery(first.id) : null), 20_000) : null;
      results.metric("test ping → delivered", Date.now() - pingStarted, "ms");
      const received = await until(async () => (await readInbox(inbox)).items.find(item => item.event_id === first?.event_id) ?? null, 10_000);
      results.check("Send test ping is delivered to the app, which verifies its signature", delivered?.status === "delivered" && delivered.last_status === 200 && received?.type === "ping", JSON.stringify(delivered).slice(0, 200));
      await refresh();
      const shownDelivered = await rowSays(first?.id ?? "x", [/ping/, /Delivered/, /HTTP 200/]);
      results.check("the list shows it: ping, Delivered, HTTP 200", shownDelivered.ok, shownDelivered.text);
      await openDrawer(first?.id ?? "x");
      const attempts = (await drawer.getByRole("region", { name: "Attempts" }).innerText()).replace(/\s+/g, " ");
      const payload = (await drawer.getByRole("region", { name: "Payload" }).innerText()).replace(/\s+/g, " ");
      const head = (await drawer.innerText()).replace(/\s+/g, " ");
      results.check("its drawer: the attempt (HTTP 200, Delivered), the event and delivery ids, where it went, the payload", /HTTP 200/.test(attempts) && /Delivered/.test(attempts) && head.includes(first?.event_id ?? "?") && head.includes(first?.id ?? "?") && head.includes(seededUrl) && /event_id/.test(payload), `${attempts.slice(0, 100)} | ${payload.slice(0, 100)}`);
      await shot(env, page, "ds-n-01-delivered");
      const before = received?.duplicate_count ?? 0;
      await drawer.getByRole("button", { name: "Replay this delivery" }).click();
      const duplicate = await until(async () => ((await readInbox(inbox)).items.find(item => item.event_id === first?.event_id)?.duplicate_count ?? 0) > before, 15_000);
      const replayed = first ? await until(async () => ((await delivery(first.id))?.manual_replays === 1 ? delivery(first.id) : null), 5_000) : null;
      results.check("Replay this delivery sends the same event again (the app sees its event_id twice) and counts the replay", !!duplicate && replayed?.manual_replays === 1, JSON.stringify(replayed).slice(0, 160));
      await closeDrawer();

      // A failing endpoint: retried, never replayable while it retries; after 72 hours it gives up and is replayed.
      await inboxFaults(inbox, 100, 503);
      const failing = await ping();
      const retrying = failing ? await until(async () => {
        const current = await delivery(failing.id);
        return current && current.status === "pending" && (current.attempt_count ?? 0) >= 1 && current.last_status === 503 ? current : null;
      }, 20_000) : null;
      results.check("against an endpoint answering 503 the delivery keeps retrying, recording HTTP 503", !!retrying, JSON.stringify(retrying).slice(0, 200));
      const shownRetrying = await rowSays(failing?.id ?? "x", [/Retrying/, /HTTP 503/, /retry/]);
      results.check("the list shows it as Retrying with HTTP 503 and when it retries", shownRetrying.ok, shownRetrying.text);
      await openDrawer(failing?.id ?? "x");
      const pendingText = (await drawer.innerText()).replace(/\s+/g, " ");
      results.check("its drawer shows the 503 attempt and offers no replay while it is retried (and says why)", /HTTP 503/.test(pendingText) && (await drawer.getByRole("button", { name: "Replay this delivery" }).count()) === 0 && /Still being retried, so there is nothing to replay/.test(pendingText), pendingText.slice(0, 200));
      await closeDrawer();
      await sql(env, `update webhook_deliveries set created_at = now() - interval '73 hours', next_attempt_at = now() where id = '${failing?.id}' and status = 'pending'`);
      const gaveUp = failing ? await until(async () => ((await delivery(failing.id))?.status === "failed" ? delivery(failing.id) : null), 25_000, 500) : null;
      results.check("72 hours later (time travel on this delivery) it has failed for good", gaveUp?.status === "failed", JSON.stringify(gaveUp).slice(0, 160));
      await inboxFaults(inbox, 0);
      await pressSegment(panel, "Show deliveries", "Failed");
      await sleep(800);
      const shownFailed = await rowSays(failing?.id ?? "x", [/Failed/, /Gave up/]);
      const others = (await page.locator("table tbody tr").allInnerTexts()).filter(text => !/Failed/.test(text) && !/No failed deliveries/.test(text));
      results.check("the Failed filter shows it (Failed, Gave up) and nothing that did not fail", shownFailed.ok && others.length === 0, `${shownFailed.text} | others: ${others.length}`);
      await rowOf(failing?.id ?? "x").getByRole("checkbox").click();
      const replayStarted = Date.now();
      await panel.getByRole("button", { name: /^Replay 1 selected/ }).click();
      await panel.getByText(/1 delivery queued again/).waitFor({ timeout: 10_000 }).catch(() => undefined);
      const queuedText = (await panel.getByText(/1 delivery queued again/).count()) > 0;
      const redelivered = failing ? await until(async () => ((await delivery(failing.id))?.status === "delivered" ? delivery(failing.id) : null), 20_000) : null;
      const arrived = await until(async () => (await readInbox(inbox)).items.find(item => item.event_id === failing?.event_id) ?? null, 10_000);
      results.metric("replay of a failed delivery → delivered", Date.now() - replayStarted, "ms");
      results.check("Replay 1 selected queues it again (\"1 delivery queued again\"), and it is delivered with its original event_id", queuedText && redelivered?.status === "delivered" && redelivered.manual_replays === 1 && !!arrived, JSON.stringify(redelivered).slice(0, 160));
      await pressSegment(panel, "Show deliveries", "All");
      await panel.getByRole("button", { name: "Replay all failed" }).click();
      await panel.getByRole("button", { name: "Replay", exact: true }).click();
      await panel.getByText("Nothing to replay", { exact: true }).waitFor({ timeout: 10_000 }).catch(() => undefined);
      await shot(env, page, "ds-n-01b-replay-all");
      const allText = (await panel.innerText()).replace(/\s+/g, " ");
      const around = allText.slice(Math.max(0, allText.indexOf("Newest first")), Math.max(0, allText.indexOf("Newest first")) + 400);
      results.check("Replay all failed with nothing failed says so (\"Nothing to replay\", why)", /Nothing to replay/.test(allText) && /No delivery has failed/.test(allText), around);

      // A new URL: its secret is shown once.
      await panel.getByRole("button", { name: "Change URL" }).click();
      await panel.getByRole("textbox", { name: "New webhook URL" }).fill(sink);
      await panel.getByRole("button", { name: "Save the new URL" }).click();
      const set = await revealSecret("Your webhook signing secret");
      await shot(env, page, "ds-n-02-secret");
      results.check("a new URL reveals its new signing secret once: masked (whsec_••••) until shown, then gone after \"I've stored it\"", /^whsec_•+$/.test(set.masked) && /^whsec_[A-Za-z0-9_-]{20,}$/.test(set.secret) && /This is the only time it is shown/.test(set.text) && !(await page.content()).includes(set.secret), `${set.masked} / ${set.secret.slice(0, 10)}…`);
      const stored = await developerApi<{ webhook?: { url: string | null; secret_set: boolean } }>(env, page, `/apps/${APP}`);
      results.check("the API (through the developer site) stores the new URL and only says a secret is set", stored.body.webhook?.url === sink && stored.body.webhook.secret_set === true && !JSON.stringify(stored.body).includes(set.secret), JSON.stringify(stored.body.webhook));
      await inboxSecret(sink, set.secret);
      const toSink = await ping();
      const atSink = await until(async () => (await readInbox(sink)).items.find(item => item.event_id === toSink?.event_id) ?? null, 15_000);
      results.check("the next ping reaches the new URL, signed with the new secret", !!atSink, JSON.stringify(atSink).slice(0, 120));

      // Rotating the secret: the next delivery is signed with the new one only.
      await panel.getByRole("button", { name: "Rotate secret" }).click();
      await panel.getByRole("button", { name: "Rotate", exact: true }).click();
      const rotated = await revealSecret("Your new webhook signing secret");
      const afterRotate = await ping();
      const refused = await until(async () => (await readInbox(sink)).rejected.find(item => item.event_id === afterRotate?.event_id) ?? null, 15_000);
      await inboxSecret(sink, rotated.secret);
      const recovered = await until(async () => (await readInbox(sink)).items.find(item => item.event_id === afterRotate?.event_id) ?? null, 10_000);
      results.check("after a rotation the old secret no longer verifies the next delivery; the new one (shown once) does", rotated.secret !== set.secret && /^whsec_/.test(rotated.secret) && /The previous secret no longer signs anything/.test(rotated.text) && !!refused && !!recovered, `refused: ${refused?.reason ?? "no"}; verified with the new secret: ${!!recovered}`);

      // Removing the webhook fails what is pending, and nothing can be replayed without a URL.
      await inboxFaults(sink, 100, 503);
      const stranded = await ping();
      await until(async () => ((await delivery(stranded?.id ?? "x"))?.attempt_count ?? 0) >= 1, 15_000);
      await panel.getByRole("button", { name: "Remove webhook" }).click();
      await panel.getByRole("button", { name: "Remove", exact: true }).click();
      await panel.getByRole("textbox", { name: "Webhook URL" }).waitFor({ timeout: 10_000 });
      const afterRemove = await until(async () => ((await delivery(stranded?.id ?? "x"))?.status === "failed" ? delivery(stranded?.id ?? "x") : null), 10_000);
      const removed = (await developerApi<{ webhook?: { url: string | null; secret_set: boolean } }>(env, page, `/apps/${APP}`)).body.webhook;
      results.check("Remove webhook clears the URL and secret, and the delivery that was retrying fails", removed?.url === null && removed.secret_set === false && afterRemove?.status === "failed", `${JSON.stringify(removed)} ${afterRemove?.status}`);
      results.check("…with no URL, Replay all failed is off", await panel.getByRole("button", { name: "Replay all failed" }).isDisabled());
      await shot(env, page, "ds-n-03-removed");
      await inboxFaults(sink, 0);
    } finally {
      // Orbit Games' own webhook back on the fake app (a new secret, which the fake app keeps).
      await json(`${inbox}/_connect-webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
      await inboxFaults(inbox, 0).catch(() => undefined);
      await context.close();
    }
    const back = (await appDetail(ctx, APP)).webhook;
    results.check("Orbit Games' webhook points at the fake app again, with a secret set", back.url === seededUrl && back.secret_set, JSON.stringify(back));
  },
};
