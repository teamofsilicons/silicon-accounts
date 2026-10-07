/**
 * Profile photos (UNDERSTANDING "Webhooks": apps are told when "any detail the app has access to changed"; the photo is
 * part of the profile every member app sees). A Carbon uploads a photo (retried once with the same Idempotency-Key:
 * "retrying something never does it twice") and removes it again; the custodian uploads a photo for its Silicon, and
 * the Silicon removes it itself. Every member app hears account.updated with changed [pfp_url] and the URL it may show
 * (which serves that image, or Iris's default once removed), and the Silicon's own webhook hears silicon.updated.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import {
  type EventRow,
  bearerCall,
  checkEq,
  createSilicon,
  must,
  newCarbon,
  sameJson,
  setInboxSecret,
  short,
  signIntoApp,
  siliconIntoApp,
  siliconLogin,
  solidPng,
  storedEvents,
  uid,
  waitEvent,
} from "./_helpers";

interface AccountData {
  changed?: string[];
  account?: { pfp_url?: string; kind?: string; custodian?: { uuid?: string; id?: string } };
  silicon?: { pfp_url?: string };
}

const where = (row: EventRow) => `${row.type}→${row.target_kind === "app" ? row.target_id : "self"}`;

async function fetchImage(url: string): Promise<{ status: number; type: string | null; bytes: Buffer }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  return { status: response.status, type: response.headers.get("content-type"), bytes: Buffer.from(await response.arrayBuffer()) };
}

export const journey: Journey = {
  name: "webhooks-photo-changes",
  title: "a new or removed profile photo reaches every member app as account.updated [pfp_url] with a URL that serves it (once, even when the upload is retried); a Silicon's photo set by its custodian or removed by itself reaches the apps and the Silicon's own webhook",
  timeoutMs: 4 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;

    // ---- a Carbon's photo ------------------------------------------------------------------------------------------------
    const carbon = await newCarbon(ctx, "photo");
    await signIntoApp(ctx, carbon, "briefcase");
    await signIntoApp(ctx, carbon, "remind");
    const png = solidPng(64, 64, [200, 80, 40]);
    const key = randomUUID();
    let since = Date.now();
    const upload = must("upload a photo", await carbon.visitor.call<{ pfp_url: string }>("POST", "/v1/me/photo", { bytes: png, contentType: "image/png", idempotencyKey: key }), 201);
    const retried = await carbon.visitor.call<{ pfp_url: string }>("POST", "/v1/me/photo", { bytes: png, contentType: "image/png", idempotencyKey: key });
    results.check("a retried upload (same Idempotency-Key) answers the same photo, marked Idempotent-Replayed", retried.status === 201 && retried.body.pfp_url === upload.body.pfp_url && retried.headers.get("idempotent-replayed") === "true", `${retried.status} ${retried.headers.get("idempotent-replayed")} ${short(retried.body.pfp_url)}`);
    const uploaded = await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 });
    checkEq(results, "upload: account.updated to briefcase and remind, once each (the retry sends nothing more)", uploaded.map(where).sort(), ["account.updated→briefcase", "account.updated→remind"]);
    for (const row of uploaded) {
      const event = await waitEvent(env, row.target_id, { event_id: row.event_id });
      const data = event?.payload.data as AccountData | undefined;
      results.check(`upload: ${row.target_id} received changed [pfp_url] with the new photo's URL (signature verified)`, !!data && sameJson(data.changed, ["pfp_url"]) && data.account?.pfp_url === upload.body.pfp_url, short(data, 300));
    }
    const served = await fetchImage(upload.body.pfp_url);
    results.check("the URL the apps were given serves exactly the uploaded PNG", served.status === 200 && served.type === "image/png" && served.bytes.equals(png), `${served.status} ${served.type} ${served.bytes.length} bytes`);

    since = Date.now();
    must("remove the photo", await carbon.visitor.call("DELETE", "/v1/me/photo"), 200);
    const removed = await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 });
    checkEq(results, "remove: account.updated to briefcase and remind", removed.map(where).sort(), ["account.updated→briefcase", "account.updated→remind"]);
    const defaultCarbon = `${env.iris}/pfp/carbon?id=${carbon.uuid}`;
    for (const row of removed) {
      const event = await waitEvent(env, row.target_id, { event_id: row.event_id });
      const data = event?.payload.data as AccountData | undefined;
      results.check(`remove: ${row.target_id} received changed [pfp_url] with Iris's default photo`, !!data && sameJson(data.changed, ["pfp_url"]) && data.account?.pfp_url === defaultCarbon, short(data?.account?.pfp_url));
    }
    const gone = await fetch(upload.body.pfp_url, { signal: AbortSignal.timeout(15_000) });
    results.check("the removed photo's URL no longer serves it (404), so no app keeps showing it", gone.status === 404, String(gone.status));

    // ---- a Silicon's photo -----------------------------------------------------------------------------------------------
    const keeper = await newCarbon(ctx, "photokeeper");
    const sink = `hooks/wh-photo-${uid()}`;
    const silicon = await createSilicon(keeper, "photo", { webhookUrl: `${env.apps}/${sink}` });
    await setInboxSecret(env, sink, silicon.webhookSecret);
    const token = await siliconLogin(env, silicon.id, silicon.stk);
    await siliconIntoApp(env, token, "briefcase");
    const siliconPng = solidPng(48, 48, [20, 120, 200]);
    since = Date.now();
    const siliconUpload = must("the custodian uploads the Silicon's photo", await keeper.visitor.call<{ pfp_url: string; silicon: { pfp_url: string } }>("POST", `/v1/me/silicons/${silicon.uuid}/photo`, { bytes: siliconPng, contentType: "image/png", idempotencyKey: randomUUID() }), 201).body;
    const siliconRows = await storedEvents(env, { account: silicon.uuid, afterMs: since - 1 });
    checkEq(results, "Silicon photo (by the custodian): account.updated to briefcase and silicon.updated to the Silicon's own webhook", siliconRows.map(where).sort(), ["account.updated→briefcase", "silicon.updated→self"]);
    const appRow = siliconRows.find(row => row.target_kind === "app");
    const ownRow = siliconRows.find(row => row.target_kind === "silicon");
    const appEvent = appRow ? await waitEvent(env, "briefcase", { event_id: appRow.event_id }) : null;
    const appData = appEvent?.payload.data as AccountData | undefined;
    results.check("…briefcase received changed [pfp_url], the new URL, kind silicon with its custodian", !!appData && sameJson(appData.changed, ["pfp_url"]) && appData.account?.pfp_url === siliconUpload.pfp_url && appData.account?.kind === "silicon" && appData.account?.custodian?.uuid === keeper.uuid, short(appData?.account, 300));
    const ownEvent = ownRow ? await waitEvent(env, sink, { event_id: ownRow.event_id }) : null;
    const ownData = ownEvent?.payload.data as AccountData | undefined;
    results.check("…the Silicon's webhook received silicon.updated changed [pfp_url] with the same URL", !!ownData && sameJson(ownData.changed, ["pfp_url"]) && ownData.silicon?.pfp_url === siliconUpload.pfp_url, short(ownData, 300));
    const siliconServed = await fetchImage(siliconUpload.pfp_url);
    results.check("…and that URL serves the Silicon's PNG", siliconServed.status === 200 && siliconServed.bytes.equals(siliconPng), `${siliconServed.status} ${siliconServed.bytes.length} bytes`);

    since = Date.now();
    must("the Silicon removes its own photo", await bearerCall(env, token, "DELETE", "/v1/me/photo"), 200);
    const selfRows = await storedEvents(env, { account: silicon.uuid, afterMs: since - 1 });
    checkEq(results, "Silicon photo removed (by the Silicon): account.updated to briefcase and silicon.updated to its own webhook", selfRows.map(where).sort(), ["account.updated→briefcase", "silicon.updated→self"]);
    const defaultSilicon = `${env.iris}/pfp/silicon?id=${silicon.uuid}`;
    const selfApp = selfRows.find(row => row.target_kind === "app");
    const selfOwn = selfRows.find(row => row.target_kind === "silicon");
    const selfAppData = (selfApp ? await waitEvent(env, "briefcase", { event_id: selfApp.event_id }) : null)?.payload.data as AccountData | undefined;
    const selfOwnData = (selfOwn ? await waitEvent(env, sink, { event_id: selfOwn.event_id }) : null)?.payload.data as AccountData | undefined;
    results.check("…both carry Iris's default Silicon photo", selfAppData?.account?.pfp_url === defaultSilicon && selfOwnData?.silicon?.pfp_url === defaultSilicon, `${short(selfAppData?.account?.pfp_url)} / ${short(selfOwnData?.silicon?.pfp_url)}`);
  },
};
