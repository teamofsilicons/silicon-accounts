/**
 * A custodian changes their own c:id (UNDERSTANDING.md "Silicon account": "The custodian is stored by their uuid but
 * shown as their c:id everywhere"; "Webhooks": an app is told when "any detail the app has access to changed"; an old
 * id is reserved for 10 days and then "becomes available again"). Every app a Silicon signed into sees the Silicon's
 * custodian as {uuid, id} (in its token response, its lookups and every account.updated about the Silicon), so when the
 * custodian's c:id changes, those apps hold a stale handle unless they are told; ten days later that handle may belong
 * to another Carbon. Here the custodian is not a member of the app themselves (so the app gets no account.id_changed
 * about them), and the journey reads what the app is told and what its lookup then shows.
 */
import type { Journey } from "../../context";
import { appCall, checkEq, createSilicon, must, newCarbon, sameJson, setInboxSecret, short, siliconIntoApp, siliconLogin, storedEvents, uid, waitEvent } from "./_helpers";

const APP = "briefcase";

export const journey: Journey = {
  name: "webhooks-custodian-id",
  title: "a custodian's c:id change reaches the apps their Silicon signed into (the apps show the Silicon's custodian by c:id), not only the apps the custodian signed into",
  timeoutMs: 3 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const keeper = await newCarbon(ctx, "cidkeeper");
    const sink = `hooks/wh-cid-${uid()}`;
    const silicon = await createSilicon(keeper, "cid", { webhookUrl: `${env.apps}/${sink}` });
    await setInboxSecret(env, sink, silicon.webhookSecret);
    const token = await siliconLogin(env, silicon.id, silicon.stk);
    const session = await siliconIntoApp(env, token, APP);
    results.check(`setup: ${APP}'s view of the Silicon names its custodian by uuid and c:id`, sameJson(session.account.custodian, { uuid: keeper.uuid, id: keeper.id }), short(session.account.custodian));
    const keeperApps = must("the custodian's apps", await keeper.visitor.call<{ items: Array<{ app: { app_id: string } }> }>("GET", "/v1/me/apps?limit=200"), 200).body.items.map(item => item.app.app_id);
    checkEq(results, `setup: the custodian never signed in to ${APP} (so ${APP} gets no account.id_changed about the custodian)`, keeperApps, []);

    const since = Date.now();
    const newId = `c:wh-cidkeeper2-${uid()}`;
    must("the custodian changes their c:id", await keeper.visitor.call("POST", "/v1/me/id", { json: { id: newId } }), 200);
    const lookup = must(`${APP} looks the Silicon up`, await appCall<{ custodian?: { uuid?: string; id?: string } }>(env, APP, "GET", `/v1/accounts/${silicon.uuid}`), 200).body;
    results.check(`${APP}'s lookup of the Silicon now shows the custodian's new c:id (what it holds from before is stale)`, lookup.custodian?.uuid === keeper.uuid && lookup.custodian.id === newId, short(lookup.custodian));
    const told = (await storedEvents(env, { account: silicon.uuid, afterMs: since - 1 })).filter(row => row.target_kind === "app");
    results.check(
      `the change is sent to ${APP}, where the Silicon is a member and which shows its custodian by c:id`,
      told.some(row => row.target_id === APP),
      `events about the Silicon stored for apps: [${told.map(row => `${row.type}→${row.target_id}`).join(", ")}]; the custodian's own events: [${(await storedEvents(env, { account: keeper.uuid, afterMs: since - 1 })).map(row => `${row.type}→${row.target_id}`).join(", ")}]`,
    );
    const row = told.find(entry => entry.target_id === APP);
    if (row) {
      const event = await waitEvent(env, APP, { event_id: row.event_id });
      const custodian = (event?.payload.data as { account?: { custodian?: unknown } } | undefined)?.account?.custodian;
      results.check(`…${APP} receives it signed, naming the custodian's new c:id`, !!event && sameJson(custodian, { uuid: keeper.uuid, id: newId }), short(event?.payload.data, 300));
    }
  },
};
