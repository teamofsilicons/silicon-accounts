import type { Journey } from "../../context";
import { forgetRateLimits, sql, tag } from "../../lib";
import {
  accounts,
  appSltLogin,
  asApp,
  asCarbon,
  cliError,
  dataOf,
  freshDir,
  idAvailable,
  loginCarbon,
  loginSilicon,
  obj,
  said,
  selfCreate,
  setSinkSecret,
  short,
  signUpCarbon,
  sinkUrl,
  str,
  waitApp,
  waitSink,
  type Json,
} from "./_helpers";

export const journey: Journey = {
  name: "silicons-cli-id-change",
  title: "the custodian changes a Silicon's si:id with the CLI: apps it signed into get account.id_changed, the Silicon gets silicon.id_changed, the old id is reserved for 10 days (only it can take it back), sign-in follows the new id",
  async run(ctx) {
    const { env, results } = ctx;
    await forgetRateLimits(env, "127.0.0.1");
    const t = tag();
    const carbon = await signUpCarbon(env, "renamer");
    const homeC = freshDir();
    await loginCarbon(env, homeC, carbon);
    const oldId = `si:before-${t}`;
    const newId = `si:after-${t}`;
    const key = `scli-rename-${t}`;
    const created = await accounts(env, ["silicon", "create", "--id", oldId, "--display-name", `Renamed ${t}`, "--webhook", sinkUrl(env, key), "--json"], { home: homeC });
    const uuid = str(obj(created.json?.silicon).uuid);
    const stk = str(created.json?.stk);
    await setSinkSecret(env, key, str(created.json?.webhook_secret));
    const homeS = freshDir();
    const remind = await appSltLogin(env, "remind", str((await loginSilicon(env, homeS, oldId, stk, ["--app", "remind"])).json?.slt));
    const briefcase = await appSltLogin(env, "briefcase", str((await accounts(env, ["login", "--app", "briefcase", "--json"], { home: homeS })).json?.slt));
    results.check("the Silicon is signed into remind and briefcase", remind.body.ok === true && briefcase.body.ok === true && remind.body.id === oldId, short([remind.body.id, briefcase.body.id]));

    // Refusals first.
    const tooShort = await accounts(env, ["silicon", "id", oldId, "si:ab", "--json"], { home: homeC });
    results.check("a too-short id: exit 2, invalid_id", tooShort.code === 2 && cliError(tooShort).code === "invalid_id", said(tooShort));
    const carbonId = await accounts(env, ["silicon", "id", oldId, `c:carbonish-${t}`, "--json"], { home: homeC });
    results.check("a c: id for a Silicon: exit 2, invalid_id (wrong kind)", carbonId.code === 2 && cliError(carbonId).code === "invalid_id", said(carbonId));
    const other = await selfCreate(ctx, { id: `si:occupied-${t}`, display_name: "Occupied", custodian: carbon.id });
    const taken = await accounts(env, ["silicon", "id", oldId, `si:occupied-${t}`, "--json"], { home: homeC });
    results.check("an id another account has: exit 5, id_taken with suggestions", other.status === 201 && taken.code === 5 && cliError(taken).code === "id_taken" && (obj(cliError(taken).details).suggestions as unknown[] | undefined)?.length === 3, said(taken));

    // 1. The change.
    const changed = await accounts(env, ["silicon", "id", oldId, newId, "--json"], { home: homeC });
    results.check("`accounts silicon id <old> <new>`: the Silicon is now the new id (same uuid)", changed.code === 0 && changed.json?.id === newId && changed.json?.uuid === uuid, said(changed));
    for (const app of ["remind", "briefcase"]) {
      const event = await waitApp(env, app, "account.id_changed", candidate => dataOf(candidate).uuid === uuid && dataOf(candidate).new_id === newId);
      const data = dataOf(event);
      results.check(`${app} got account.id_changed (old → new, kind silicon, its membership id), signature verified`, data.old_id === oldId && data.kind === "silicon" && data.membership_id === `${app}:${uuid}` && event?.payload.app_id === app, short(event?.payload, 240));
    }
    const own = await waitSink(env, key, "silicon.id_changed", event => dataOf(event).new_id === newId);
    results.check("the Silicon's webhook got silicon.id_changed (old → new)", dataOf(own).old_id === oldId && dataOf(own).uuid === uuid, short(own?.payload, 200));

    // 2. The old id is reserved for 10 days; nobody else can take it.
    const reserved = await idAvailable(ctx, oldId);
    results.check("the old id is not available: reserved", reserved.available === false && reserved.reason === "reserved", short(reserved));
    const until = await sql(env, `select extract(epoch from (reserved_until - now()))::bigint from handle_reservations where handle = '${oldId}'`);
    const days = Number(until[0]?.[0]) / 86_400;
    results.check("…for 10 days", days > 9.99 && days <= 10, `${days.toFixed(4)} days`);
    const stranger = await signUpCarbon(env, "squatter");
    const squat = await asCarbon<Json>(env, stranger, "POST", "/v1/me/silicons", { id: oldId, display_name: "Squatter" });
    results.check("another Carbon can't create a Silicon with it (409 id_reserved, with reserved_until)", squat.status === 409 && str(obj(obj(squat.body).error).code) === "id_reserved" && !!obj(obj(obj(squat.body).error).details).reserved_until, `${squat.status} ${short(squat.body)}`);
    const selfSquat = await selfCreate(ctx, { id: oldId, display_name: "Squatter", custodian: stranger.id });
    results.check("…nor can a Silicon creating its own account", selfSquat.status === 409 && str(obj(selfSquat.body.error).code) === "id_reserved", `${selfSquat.status}`);
    const forMe = await asCarbon<Json>(env, carbon, "GET", `/v1/ids/available?id=${encodeURIComponent(oldId)}&for=${encodeURIComponent(newId)}`);
    results.check("asked for the Silicon by its custodian, the old id is reclaimable", obj(forMe.body).reclaimable === true, short(forMe.body));

    // 3. Signing in follows the new id; lookups by uuid give the current id.
    const byOld = await loginSilicon(env, freshDir(), oldId, stk);
    results.check("signing in with the old id fails like any unknown id (exit 3, invalid_credentials)", byOld.code === 3 && cliError(byOld).code === "invalid_credentials", said(byOld));
    const byNew = await loginSilicon(env, freshDir(), newId, stk);
    results.check("…with the new id and the same STK it works", byNew.code === 0 && byNew.json?.id === newId, said(byNew));
    const status = await accounts(env, ["login", "status", "--json"], { home: homeS });
    results.check("a CLI session from before the change stays signed in and reports the new id", status.code === 0 && status.json?.id === newId, said(status));
    const lookup = await accounts(env, ["lookup", uuid, "--json"], { home: homeC });
    results.check("`accounts lookup <uuid>` gives the current id", lookup.code === 0 && lookup.json?.id === newId, said(lookup));
    const appLookup = await asApp(ctx, "remind", "GET", `/v1/accounts/${uuid}`);
    results.check("an app looking the uuid up gets the current id", appLookup.status === 200 && appLookup.body.id === newId, `${appLookup.status} ${short(appLookup.body)}`);
    const oldLookup = await accounts(env, ["lookup", oldId, "--json"], { home: homeC });
    results.check("the old id no longer resolves (exit 4)", oldLookup.code === 4, said(oldLookup));

    // 4. The custodian takes the old id back for it (within the 10 days), and the apps hear that too.
    const back = await accounts(env, ["silicon", "id", newId, oldId, "--json"], { home: homeC });
    results.check("the custodian can give the Silicon its old id back within the 10 days", back.code === 0 && back.json?.id === oldId, said(back));
    const reverted = await waitApp(env, "remind", "account.id_changed", candidate => dataOf(candidate).uuid === uuid && dataOf(candidate).new_id === oldId);
    results.check("…and remind hears that change too", dataOf(reverted).old_id === newId, short(reverted?.payload, 200));
    const audit = await sql(env, `select details->>'reclaimed' from audit_log where action = 'silicon.id.changed' and target_id = '${uuid}' and details->>'new_id' = '${oldId}' limit 1`);
    results.check("…recorded as a reclaim", audit[0]?.[0] === "true", short(audit));

    // 5. Ten days later the other id is free for anyone.
    const heldNew = await idAvailable(ctx, newId);
    await sql(env, `update handle_reservations set reserved_until = now() - interval '1 second' where handle = '${newId}'`);
    const freeNew = await idAvailable(ctx, newId);
    const takenNow = await asCarbon<Json>(env, stranger, "POST", "/v1/me/silicons", { id: newId, display_name: "Newcomer" });
    results.check("ten days after a change the released id is anyone's (time travel): reserved → available → taken by another Carbon", heldNew.reason === "reserved" && freeNew.available === true && takenNow.status === 201, `${short(heldNew.reason)} → ${short(freeNew.available)} → ${takenNow.status}`);
    const history = await accounts(env, ["history", "--kind", "id_change", "--json"], { home: homeS });
    const changes = ((history.json?.items ?? []) as Json[]).map(item => `${str(obj(item.meta).old_id)}→${str(obj(item.meta).new_id)}`);
    results.check("the Silicon's id history: created, changed, changed back", changes.includes(`${oldId}→${newId}`) && changes.includes(`${newId}→${oldId}`) && changes.includes(`→${oldId}`), short(changes));
  },
};
