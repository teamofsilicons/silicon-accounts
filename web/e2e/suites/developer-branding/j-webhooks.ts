/**
 * interface's webhook deliveries as its owner works with them (the testkit's fake app receives them, verifies every
 * signature, dedupes by event_id, and fails on request):
 * a ping is delivered and its drawer shows the attempt and payload; replaying a delivered one re-sends the same event;
 * a failing one retries with its attempts and cannot be replayed while retrying; once it gives up (72 h, by time travel)
 * it is replayed and delivered with the same event_id; removing the webhook fails what was pending, a new URL shows its
 * secret once, and "Replay all failed" sends the old event to the new URL signed with the new secret; a rotated secret
 * signs the next delivery; a delivery about a member who removed access is never replayed and its details are hidden.
 */
import type { Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { shot, sleep, sql, tag } from "../../lib";
import { apiSignUp, asApiBrowser, asSession, inboxFaults, inboxSecret, ownerSignIn, readInbox, until } from "./_helpers";

const APP = "interface";

interface Delivery {
  id: string;
  event_id: string;
  type: string;
  status: "pending" | "delivered" | "failed";
  /** A count in the list; the list of attempts in the detail (whose count is attempt_count). */
  attempts: number | unknown[];
  attempt_count?: number;
  last_status: number | null;
  manual_replays: number;
  url?: string;
  payload_redacted?: boolean;
}

interface ReplayResult {
  replayed: string[];
  skipped: Array<{ delivery_id: string; reason: string; message?: string }>;
}

async function deliveries(page: Page, ctx: Ctx): Promise<Delivery[]> {
  return (await asSession<{ items: Delivery[] }>(page, ctx.env, "GET", `/v1/apps/${APP}/webhook/deliveries?limit=50`)).body.items ?? [];
}

async function delivery(page: Page, ctx: Ctx, id: string): Promise<Delivery | null> {
  const answer = await asSession<Delivery>(page, ctx.env, "GET", `/v1/apps/${APP}/webhook/deliveries/${id}`);
  return answer.status === 200 ? answer.body : null;
}

/** Sends a test ping from the tab and returns its delivery (the newest ping the API lists). */
async function ping(page: Page, ctx: Ctx, known: Set<string>): Promise<Delivery | null> {
  await page.getByRole("button", { name: "Send test ping" }).click();
  return until(async () => (await deliveries(page, ctx)).find(item => item.type === "ping" && !known.has(item.id)) ?? null, 15_000, 300);
}

export const journey: Journey = {
  name: "developer-branding-webhooks",
  title: "webhook deliveries: ping delivered (drawer: attempt, payload), replay of a delivered event (same event_id), retrying with 503 attempts (no replay), given up after 72 h then replayed and delivered, remove → failed, new URL secret shown once, replay-all to the new URL with the new secret, rotation, no replay after access removed",
  timeoutMs: 9 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const inbox = `${env.apps}/${APP}`;
    const sink = `${env.apps}/hooks/dvb-${t}`;
    await inboxFaults(inbox, 0);
    const owner = await ownerSignIn(ctx, APP, "dvb-j-owner");
    const { page } = owner;
    const seen = new Set((await deliveries(page, ctx)).map(item => item.id));
    const refresh = async () => {
      await page.getByRole("button", { name: "Refresh deliveries" }).click();
      await sleep(900);
    };
    // Rows are found by their "Open delivery <first 8>…<last 4> of <type>" button (ids are UUIDv7: the first 8 repeat).
    const rowOf = (id: string) => page.locator("table tbody tr").filter({ has: page.getByRole("button", { name: `Open delivery ${id.slice(0, 8)}…${id.slice(-4)} of`, exact: false }) });
    /** The row's text once it says what `wanted` expects (the list is asked again with Refresh), or its last text. */
    const rowSays = async (id: string, wanted: RegExp[]): Promise<{ ok: boolean; text: string }> => {
      let text = "";
      for (let attempt = 0; attempt < 12; attempt++) {
        text = (await rowOf(id).innerText({ timeout: 1_000 }).catch(() => "")).replace(/\s+/g, " ");
        if (wanted.every(pattern => pattern.test(text))) return { ok: true, text };
        await refresh();
      }
      return { ok: false, text };
    };

    await page.goto(`${env.site}/developer/${APP}/webhooks`);
    await page.getByText(`${env.apps}/${APP}/webhooks`).first().waitFor({ timeout: 20_000 });
    results.check("the endpoint shows the app's webhook URL and that a whsec_ secret signs it", (await page.getByText(/Signed with a whsec_ secret/).count()) > 0);

    // A ping: delivered, signature verified by the app, and its drawer shows the attempt and the payload.
    const pingStarted = Date.now();
    const first = await ping(page, ctx, seen);
    seen.add(first?.id ?? "");
    const delivered = first ? await until(async () => ((await delivery(page, ctx, first.id))?.status === "delivered" ? await delivery(page, ctx, first.id) : null), 20_000, 300) : null;
    results.metric("test ping → delivered", Date.now() - pingStarted);
    const received = await until(async () => (await readInbox(inbox)).items.find(item => item.event_id === first?.event_id) ?? null, 10_000, 300);
    results.check("Send test ping is delivered, and the app accepts its signature", delivered?.status === "delivered" && delivered.last_status === 200 && !!received && received.type === "ping", JSON.stringify(delivered).slice(0, 200));
    await refresh();
    const row = rowOf(first?.id ?? "x");
    const shownDelivered = await rowSays(first?.id ?? "x", [/Delivered/, /HTTP 200/]);
    results.check("the list shows it as Delivered with its HTTP 200", shownDelivered.ok, shownDelivered.text);
    await row.getByRole("button", { name: /^Open delivery/ }).click();
    const drawer = page.getByRole("dialog");
    await drawer.getByRole("region", { name: "Attempts" }).waitFor({ timeout: 10_000 });
    await sleep(500);
    const attempts = (await drawer.getByRole("region", { name: "Attempts" }).innerText()).replace(/\s+/g, " ");
    const payload = (await drawer.getByRole("region", { name: "Payload" }).innerText()).replace(/\s+/g, " ");
    results.check("its drawer lists the attempt (HTTP 200, Delivered) and the payload with its event_id", /HTTP 200/.test(attempts) && /Delivered/.test(attempts) && /event_id/.test(payload), `${attempts.slice(0, 120)} | ${payload.slice(0, 120)}`);
    await shot(env, page, "dvb-j-01-delivered-drawer");
    // Replaying a delivered event sends the same event again (same event_id: the app counts a duplicate).
    const before = received?.duplicate_count ?? 0;
    await drawer.getByRole("button", { name: "Replay this delivery" }).click();
    const duplicate = await until(async () => ((await readInbox(inbox)).items.find(item => item.event_id === first?.event_id)?.duplicate_count ?? 0) > before, 15_000, 300);
    const replayed = first ? await delivery(page, ctx, first.id) : null;
    results.check("Replay this delivery re-sends the same event (the app sees a duplicate event_id) and counts the replay", duplicate && replayed?.manual_replays === 1, JSON.stringify(replayed).slice(0, 200));
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);

    // A failing endpoint: retried with its attempts, not replayable while retrying.
    await inboxFaults(inbox, 100, 503);
    const failing = await ping(page, ctx, seen);
    seen.add(failing?.id ?? "");
    const retrying = failing ? await until(async () => {
      const current = await delivery(page, ctx, failing.id);
      return current && current.status === "pending" && (current.attempt_count ?? 0) >= 1 ? current : null;
    }, 20_000, 300) : null;
    results.check("against a failing endpoint the delivery keeps retrying, recording HTTP 503", retrying?.status === "pending" && retrying.last_status === 503, JSON.stringify(retrying).slice(0, 200));
    await refresh();
    const failingRow = rowOf(failing?.id ?? "x");
    const shownRetrying = await rowSays(failing?.id ?? "x", [/Retrying/, /HTTP 503/]);
    results.check("the list shows it as Retrying with HTTP 503 and when it retries", shownRetrying.ok, shownRetrying.text);
    await failingRow.getByRole("button", { name: /^Open delivery/ }).click();
    await drawer.getByRole("region", { name: "Attempts" }).waitFor({ timeout: 10_000 });
    await sleep(500);
    results.check("its drawer shows the 503 attempt and offers no replay while it retries", /HTTP 503/.test(await drawer.getByRole("region", { name: "Attempts" }).innerText()) && (await drawer.getByRole("button", { name: "Replay this delivery" }).count()) === 0);
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    await failingRow.getByRole("checkbox").click();
    await page.getByRole("button", { name: /^Replay 1 selected/ }).click();
    await page.getByText("Nothing was replayed").waitFor({ timeout: 10_000 }).catch(() => undefined);
    results.check("replaying it while it retries is refused and says why", (await page.getByText("Nothing was replayed").count()) > 0 && (await page.getByText(/still pending|being retried|pending/i).count()) > 0);

    // 72 hours later (time travel on this delivery only) it gives up for good: failed, and replayable.
    await sql(env, `update webhook_deliveries set created_at = now() - interval '73 hours', next_attempt_at = now() where id = '${failing?.id}'`);
    const gaveUp = failing ? await until(async () => ((await delivery(page, ctx, failing.id))?.status === "failed" ? await delivery(page, ctx, failing.id) : null), 20_000, 400) : null;
    results.check("past 72 hours of retries the delivery is failed", gaveUp?.status === "failed", JSON.stringify(gaveUp).slice(0, 200));
    await inboxFaults(inbox, 0);
    await page.getByRole("group", { name: "Show deliveries" }).getByRole("button", { name: "Failed", exact: true }).click();
    await sleep(900);
    const failedRow = rowOf(failing?.id ?? "x");
    const shownFailed = await rowSays(failing?.id ?? "x", [/Failed/, /Gave up/]);
    results.check("the Failed filter shows it, given up", shownFailed.ok, shownFailed.text);
    await failedRow.getByRole("checkbox").click();
    const replayStarted = Date.now();
    await page.getByRole("button", { name: /^Replay 1 selected/ }).click();
    await page.getByText(/1 delivery queued again/).waitFor({ timeout: 10_000 }).catch(() => undefined);
    results.check("Replay 1 selected queues it again", (await page.getByText(/1 delivery queued again/).count()) > 0);
    const redelivered = failing ? await until(async () => ((await delivery(page, ctx, failing.id))?.status === "delivered" ? await delivery(page, ctx, failing.id) : null), 20_000, 300) : null;
    const arrived = await until(async () => (await readInbox(inbox)).items.find(item => item.event_id === failing?.event_id) ?? null, 10_000, 300);
    results.check("the replayed delivery is delivered with its original event_id and a valid signature", redelivered?.status === "delivered" && redelivered.manual_replays === 1 && !!arrived, JSON.stringify(redelivered).slice(0, 200));
    results.metric("replay of a failed delivery → delivered", Date.now() - replayStarted);
    await page.getByRole("group", { name: "Show deliveries" }).getByRole("button", { name: "All", exact: true }).click();

    // Removing the webhook fails what is pending; a new URL comes with a new secret, shown once.
    await inboxFaults(inbox, 100, 503);
    const stranded = await ping(page, ctx, seen);
    seen.add(stranded?.id ?? "");
    await until(async () => ((await delivery(page, ctx, stranded?.id ?? "x"))?.attempt_count ?? 0) >= 1, 15_000, 300);
    await page.getByRole("button", { name: "Remove webhook" }).click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("textbox", { name: "Webhook URL" }).waitFor({ timeout: 10_000 });
    const afterRemove = await delivery(page, ctx, stranded?.id ?? "x");
    const removedInfo = (await asSession<{ webhook: { url: string | null; secret_set: boolean } }>(page, env, "GET", `/v1/apps/${APP}`)).body.webhook;
    results.check("Remove webhook clears the URL and secret, and the pending delivery fails", removedInfo.url === null && removedInfo.secret_set === false && afterRemove?.status === "failed", `${JSON.stringify(removedInfo)} ${afterRemove?.status}`);
    await inboxFaults(inbox, 0);
    await page.getByRole("textbox", { name: "Webhook URL" }).fill(sink);
    await page.getByRole("button", { name: "Save the webhook URL" }).click();
    const reveal = page.getByRole("group", { name: "Your webhook signing secret" });
    await reveal.waitFor({ timeout: 10_000 });
    const masked = ((await reveal.locator("code").first().textContent()) ?? "").trim();
    await reveal.getByRole("button", { name: "Show the signing secret" }).click();
    const secret = ((await reveal.locator("code[data-shown]").first().textContent()) ?? "").trim();
    results.check("saving a URL reveals its new signing secret once: masked (whsec_••••) until shown", /^whsec_•+$/.test(masked) && /^whsec_[A-Za-z0-9_-]{20,}$/.test(secret), `${masked} / ${secret.slice(0, 10)}…`);
    await shot(env, page, "dvb-j-02-new-secret");
    await inboxSecret(sink, secret);
    await reveal.getByRole("button", { name: "I've stored it" }).click();
    await reveal.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    const stored = await asSession(page, env, "GET", `/v1/apps/${APP}`);
    results.check("after \"I've stored it\" the secret is gone from the page, and the API only says one is set", !(await page.content()).includes(secret) && !JSON.stringify(stored.body).includes(secret) && JSON.stringify(stored.body).includes('"secret_set":true'));

    // "Replay all failed": the stranded event goes to the new URL, signed with the new secret.
    await page.getByRole("button", { name: "Replay all failed" }).click();
    await page.getByRole("button", { name: "Replay", exact: true }).click();
    const atSink = await until(async () => (await readInbox(sink)).items.find(item => item.event_id === stranded?.event_id) ?? null, 20_000, 300);
    const sinkDelivery = await delivery(page, ctx, stranded?.id ?? "x");
    results.check("Replay all failed delivers the old event to the new URL, verified with the new secret", !!atSink && sinkDelivery?.status === "delivered", `${JSON.stringify(atSink).slice(0, 120)} ${sinkDelivery?.status} ${sinkDelivery?.url ?? ""}`);

    // Rotating the secret: the next delivery is signed with the new one (the receiver, still on the old one, refuses it).
    await page.getByRole("button", { name: "Rotate secret" }).click();
    await page.getByRole("button", { name: "Rotate", exact: true }).click();
    const rotated = page.getByRole("group", { name: "Your new webhook signing secret" });
    await rotated.waitFor({ timeout: 10_000 });
    await rotated.getByRole("button", { name: "Show the signing secret" }).click();
    const newSecret = ((await rotated.locator("code[data-shown]").first().textContent()) ?? "").trim();
    await rotated.getByRole("button", { name: "I've stored it" }).click();
    const afterRotate = await ping(page, ctx, seen);
    seen.add(afterRotate?.id ?? "");
    const refused = await until(async () => (await readInbox(sink)).rejected.find(item => item.event_id === afterRotate?.event_id && item.reason === "signature_mismatch") ?? null, 15_000, 300);
    await inboxSecret(sink, newSecret);
    const recovered = await until(async () => (await readInbox(sink)).items.find(item => item.event_id === afterRotate?.event_id) ?? null, 10_000, 300);
    results.check("after a rotation the old secret no longer verifies the next delivery, and the new one does", newSecret !== secret && /^whsec_/.test(newSecret) && !!refused && !!recovered, `refused ${!!refused}, verified with the new secret ${!!recovered}`);

    // A member who removed access: their account update failed, and it is never replayed (details hidden).
    await inboxSecret(sink, newSecret);
    const member = await apiSignUp(ctx, APP, { displayName: `Webhook Member ${t}`, optionalScopes: ["email"] });
    await inboxFaults(sink, 100, 503);
    const renamed = await asApiBrowser(member, "PATCH", "/v1/me", { display_name: `Renamed Member ${t}` });
    const updated = await until(async () => (await deliveries(page, ctx)).find(item => item.type === "account.updated" && !seen.has(item.id)) ?? null, 15_000, 300);
    seen.add(updated?.id ?? "");
    await sql(env, `update webhook_deliveries set created_at = now() - interval '73 hours', next_attempt_at = now() where id = '${updated?.id}'`);
    await until(async () => (await delivery(page, ctx, updated?.id ?? "x"))?.status === "failed", 20_000, 400);
    await inboxFaults(sink, 0);
    const left = await asApiBrowser(member, "DELETE", `/v1/me/apps/${APP}`);
    results.check("the member renamed themselves (account.updated failed for good), then removed interface's access", renamed.status === 200 && left.status === 204 && !!updated, `${renamed.status} ${left.status} ${updated?.type}`);
    const replayAttempt = await asSession<ReplayResult>(page, env, "POST", `/v1/apps/${APP}/webhook/replay`, { delivery_ids: [updated?.id] });
    const skipped = replayAttempt.body.skipped?.find(item => item.delivery_id === updated?.id);
    results.check("replaying it is skipped: membership_inactive (the app may no longer see that account)", replayAttempt.status === 200 && (replayAttempt.body.replayed ?? []).length === 0 && skipped?.reason === "membership_inactive", JSON.stringify(replayAttempt.body).slice(0, 240));
    await refresh();
    await rowOf(updated?.id ?? "x").getByRole("button", { name: /^Open delivery/ }).click();
    await drawer.getByRole("region", { name: "Payload" }).waitFor({ timeout: 10_000 });
    await sleep(500);
    const hidden = (await drawer.innerText()).replace(/\s+/g, " ");
    results.check("its drawer hides the account's details and offers no replay", /Account details are hidden/.test(hidden) && !hidden.includes(`Renamed Member ${t}`) && (await drawer.getByRole("button", { name: "Replay this delivery" }).count()) === 0, hidden.slice(0, 240));
    await shot(env, page, "dvb-j-03-redacted");
    await page.keyboard.press("Escape");
    await member.browser.dispose();

    // interface's webhook back on the fake app (with the secret it now has).
    await page.getByRole("button", { name: "Change URL" }).click();
    await page.getByRole("textbox", { name: "New webhook URL" }).fill(`${env.apps}/${APP}/webhooks`);
    await page.getByRole("button", { name: "Save the new URL" }).click();
    const back = page.getByRole("group", { name: "Your webhook signing secret" });
    await back.waitFor({ timeout: 10_000 });
    await back.getByRole("button", { name: "Show the signing secret" }).click();
    await inboxSecret(inbox, ((await back.locator("code[data-shown]").first().textContent()) ?? "").trim());
    await back.getByRole("button", { name: "I've stored it" }).click();
    const restored = (await asSession<{ webhook: { url: string } }>(page, env, "GET", `/v1/apps/${APP}`)).body.webhook.url;
    results.check("interface's webhook points at the fake app again", restored === `${env.apps}/${APP}/webhooks`, restored);
    await owner.context.close();
  },
};
