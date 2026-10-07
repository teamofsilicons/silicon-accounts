/**
 * Changing a c:id on the identity card: the field explains every refusal as it is typed, the old id stays reserved
 * for its owner for 10 days (another account can't take it, the owner can take it back), after the 10 days (time
 * travel) it is free, apps are told every change, and an account changes its id at most 5 times a day.
 */
import type { Locator, Page } from "@playwright/test";
import type { Journey } from "../../context";
import { api, shot, sleep, sql, tag } from "../../lib";
import { appAuth, appUserinfo, call, codeOf, deliveredAfter, formatDate, getMe, idStatus, inbox, messageOf, newCarbon, requestSent, signIntoApp, until, waitEvent } from "./_helpers";

/** Opens the "Change your id" dialog from the card and returns it with its field and submit button. */
async function openDialog(page: Page, site: string, id: string): Promise<{ dialog: Locator; field: Locator; submit: Locator }> {
  await page.goto(`${site}/`);
  const front = page.getByRole("region", { name: `Identity card of ${id}`, exact: true });
  await front.waitFor({ timeout: 30_000 });
  await front.getByRole("button", { name: "Change id", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Change your id" });
  await dialog.waitFor({ timeout: 10_000 });
  return { dialog, field: dialog.getByRole("textbox", { name: "New id" }), submit: dialog.locator('button[type="submit"]') };
}

/** Types a handle into the dialog's field (replacing what is there) and returns the settled status line. */
async function typeHandle(dialog: Locator, field: Locator, handle: string, settled?: (text: string) => boolean): Promise<string> {
  await field.fill("");
  await field.pressSequentially(handle, { delay: 15 });
  return idStatus(dialog, settled);
}

const changeId: Journey = {
  name: "account-site-change-id",
  title: "changing the c:id: refusals explained as typed, the old id reserved 10 days (another Carbon can't take it, its owner takes it back), free after the 10 days (time travel), apps told each change, at most 5 changes a day",
  async run(ctx) {
    const { env, results } = ctx;
    const owner = await newCarbon(ctx, "acct-idown", { watch: [/status of 429/] });
    const other = await newCarbon(ctx, "acct-idother");
    const account = await signIntoApp(env, owner.page, "briefcase");
    results.check("setup: the owner signed into Briefcase", account?.uuid === owner.uuid);
    const original = owner.id;
    const t = tag();
    const moved = `c:acct-moved-${t}`;

    // 1. Every refusal is explained in the field, as it is typed.
    let { dialog, field, submit } = await openDialog(owner.page, env.site, original);
    await sleep(400);
    const rules: Array<[string, RegExp, string]> = [
      ["ab", /at least 3 characters after c: \(this one has 2\)/, "too short"],
      ["x".repeat(31), /at most 30 characters after c: \(this one has 31\)/, "too long"],
      ["bad id", /a space is not allowed/, "a space"],
      ["si:robot", /si: ids belong to Silicons/, "a Silicon's prefix"],
      ["admin", /'admin' is a reserved word/, "a reserved word"],
      [other.id.slice(2), /taken by another account/, "another Carbon's id"],
      [original.slice(2), /is the id now/, "the current id"],
    ];
    for (const [typed, expected, what] of rules) {
      const status = await typeHandle(dialog, field, typed);
      const disabled = await submit.isDisabled();
      results.check(`the field refuses ${what} in place and the button stays off`, expected.test(status) && disabled, `"${typed}": ${status}`);
    }
    const reserved = await call<{ available: boolean; reason: string | null; message: string }>(owner.probe, `/v1/ids/available?id=c:admin`);
    results.check("…the API says why: reason reserved_word", reserved.body.available === false && reserved.body.reason === "reserved_word", JSON.stringify(reserved.body));
    await typeHandle(dialog, field, other.id.slice(2));
    const offered = await dialog.getByText("Free ids close to it").count();
    results.check("a taken id comes with free ids close to it", offered === 1);
    const suggestion = dialog.getByText("Free ids close to it").locator("xpath=..").getByRole("button").first();
    const suggested = ((await suggestion.innerText().catch(() => "")) || "").trim();
    await suggestion.click();
    const pickedStatus = await idStatus(dialog, text => text.includes("is available") || text.includes("not available") || text.includes("taken"));
    results.check("picking a suggested id fills the field with it, and it is free", suggested.startsWith("c:") && (await field.inputValue()) === suggested.slice(2) && pickedStatus.includes(`${suggested} is available`), `${suggested}: ${pickedStatus}`);
    const mixed = `MiXeD-${t}`;
    await field.fill("");
    await field.pressSequentially(mixed, { delay: 15 });
    const lowered = await field.inputValue();
    const mixedStatus = await idStatus(dialog);
    results.check("ids are case-insensitive: the field lowercases what is typed, and the check agrees", lowered === mixed.toLowerCase() && mixedStatus.includes(`c:${mixed.toLowerCase()} is available`), `${lowered}: ${mixedStatus}`);
    const upper = await api<{ available: boolean; reason: string | null; id: string }>(ctx, `/v1/ids/available?id=${encodeURIComponent(other.id.toUpperCase())}`);
    results.check("…an upper-case spelling of a taken id is taken too (unique across accounts)", upper.body.available === false && upper.body.reason === "taken", JSON.stringify(upper.body));

    // 2. The change: the old id is reserved for the owner for 10 days; Briefcase is told; the uuid stays.
    const before = (await inbox(env, "briefcase")).last_seq;
    const freeStatus = await typeHandle(dialog, field, moved.slice(2), text => /available|not available|taken|reserved/.test(text));
    results.check("a free id: the field says so and the button turns on", freeStatus.includes(`${moved} is available`) && !(await submit.isDisabled()), freeStatus);
    const idSent = requestSent(owner.page, "POST", "/v1/me/id");
    await submit.click();
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const front = owner.page.getByRole("region", { name: `Identity card of ${moved}`, exact: true });
    await front.waitFor({ timeout: 10_000 });
    await sleep(900);
    await shot(env, owner.page, "acct-id-01-changed");
    const meMoved = await getMe(owner.probe);
    results.check("the account's id is the new one, the uuid unchanged", meMoved.id === moved && meMoved.uuid === owner.uuid, `${meMoved.id} ${meMoved.uuid}`);
    const until10 = formatDate(Date.now() + 10 * 86_400_000);
    const cardText = (await front.innerText()).replace(/\s+/g, " ");
    results.check("the card says the old id is reserved for you until 10 days from now", cardText.includes(`${original} is reserved for you until ${until10}`), cardText.match(/c:\S+ is reserved[^.]*\./)?.[0] ?? cardText.slice(0, 160));
    const [[holder, days] = []] = await sql(env, `select account_uuid, round(extract(epoch from reserved_until - now()) / 86400.0, 2) from handle_reservations where handle = '${original}'`);
    results.check("the reservation is the owner's, for 10 days", holder === owner.uuid && Math.abs(Number(days) - 10) < 0.01, `${holder} ${days} days`);
    const [[oldHandle, newHandle] = []] = await sql(env, `select old_handle, new_handle from handle_history where account_uuid = '${owner.uuid}' order by changed_at desc limit 1`);
    results.check("the change is in the id history", oldHandle === original && newHandle === moved, `${oldHandle} → ${newHandle}`);
    const event = await waitEvent(env, "briefcase", "account.id_changed", owner.uuid, { after: before });
    results.metric("id change POST sent → Briefcase received account.id_changed", deliveredAfter(event, await idSent));
    results.check("Briefcase got account.id_changed with the old and new ids (signed)", !!event && event.payload.data.old_id === original && event.payload.data.new_id === moved && event.payload.data.membership_id === `briefcase:${owner.uuid}`, JSON.stringify(event?.payload.data ?? null));
    const seen = await appUserinfo(env, "briefcase", owner.uuid);
    results.check("Briefcase's userinfo has the new id (same uuid)", seen.status === 200 && seen.body.id === moved && seen.body.sub === owner.uuid, `${seen.status} ${seen.body.id} ${seen.body.sub}`);
    const byOld = await api(ctx, `/v1/accounts/by-id/${encodeURIComponent(original)}`, { headers: { authorization: appAuth("briefcase") } });
    const byUuid = await api<{ id?: string }>(ctx, `/v1/accounts/${owner.uuid}`, { headers: { authorization: appAuth("briefcase") } });
    results.check("an app can no longer resolve the old id, and the uuid gives the new one", byOld.status === 404 && byUuid.status === 200 && byUuid.body.id === moved, `by-id ${byOld.status}, by-uuid ${byUuid.status} ${byUuid.body.id}`);

    // 3. Another Carbon can't take it: the field says it is reserved, the API refuses.
    const anon = await api<{ available: boolean; reason: string | null; message: string }>(ctx, `/v1/ids/available?id=${encodeURIComponent(original)}`);
    results.check("for anyone else the old id is reserved (available: false, reason reserved)", anon.body.available === false && anon.body.reason === "reserved" && /reserved for its previous owner/.test(anon.body.message), JSON.stringify(anon.body).slice(0, 200));
    const theirs = await openDialog(other.page, env.site, other.id);
    const otherStatus = await typeHandle(theirs.dialog, theirs.field, original.slice(2));
    results.check("the other Carbon's field says the id is reserved for its previous owner, button off", /reserved for its previous owner/.test(otherStatus) && (await theirs.submit.isDisabled()), otherStatus);
    await shot(env, other.page, "acct-id-02-reserved-for-another");
    const grab = await call(other.probe, "/v1/me/id", { method: "POST", json: { id: original } });
    results.check("the API refuses it to the other Carbon: 409 id_reserved", grab.status === 409 && codeOf(grab.body) === "id_reserved", `${grab.status} ${codeOf(grab.body)} ${messageOf(grab.body)}`);
    await other.page.keyboard.press("Escape");

    // 4. The owner takes it back within the 10 days; the id it leaves is reserved for it in turn.
    ({ dialog, field, submit } = await openDialog(owner.page, env.site, moved));
    const reclaimStatus = await typeHandle(dialog, field, original.slice(2));
    results.check("the owner's field offers to take the old id back", reclaimStatus.includes(`${original} was your id and is still reserved for you, so you can take it back.`), reclaimStatus);
    const label = await until(async () => (await submit.innerText()).replace(/\s+/g, " ").trim(), text => text === `Take back ${original}`, 4_000);
    results.check("…with a button that says so", label === `Take back ${original}`, JSON.stringify(label));
    const mine = await call<{ available: boolean; reclaimable: boolean }>(owner.probe, `/v1/ids/available?id=${encodeURIComponent(original)}`);
    results.check("the API agrees for the owner: available and reclaimable", mine.body.available === true && mine.body.reclaimable === true, JSON.stringify(mine.body));
    const before2 = (await inbox(env, "briefcase")).last_seq;
    await submit.click();
    await dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const meBack = await until(() => getMe(owner.probe), me => me.id === original, 10_000);
    results.check("taken back: the account's id is the original again", meBack.id === original && meBack.uuid === owner.uuid, meBack.id);
    const reservations = await sql(env, `select handle, account_uuid from handle_reservations where handle in ('${original}', '${moved}') and reserved_until > now()`);
    results.check("the original's reservation is gone and the id just left is reserved for the owner", reservations.length === 1 && reservations[0]?.[0] === moved && reservations[0]?.[1] === owner.uuid, JSON.stringify(reservations));
    const event2 = await waitEvent(env, "briefcase", "account.id_changed", owner.uuid, { after: before2 });
    results.check("Briefcase got the change back too", !!event2 && event2.payload.data.old_id === moved && event2.payload.data.new_id === original, JSON.stringify(event2?.payload.data ?? null));
    const grab2 = await call(other.probe, "/v1/me/id", { method: "POST", json: { id: moved } });
    results.check("the id the owner left is reserved against the other Carbon too (409 id_reserved)", grab2.status === 409 && codeOf(grab2.body) === "id_reserved", `${grab2.status} ${codeOf(grab2.body)}`);

    // 5. A minute before the 10 days end it is still reserved; once they are over (time travel) it is free and the
    // other Carbon takes it in the dialog.
    await sql(env, `update handle_reservations set reserved_until = now() + interval '1 minute' where handle = '${moved}'`);
    const lastMinute = await call(other.probe, "/v1/me/id", { method: "POST", json: { id: moved } });
    results.check("a minute before the reservation ends, the other Carbon is still refused (409 id_reserved)", lastMinute.status === 409 && codeOf(lastMinute.body) === "id_reserved", `${lastMinute.status} ${codeOf(lastMinute.body)}`);
    await sql(env, `update handle_reservations set reserved_until = now() - interval '1 second' where handle = '${moved}'`);
    const theirs2 = await openDialog(other.page, env.site, other.id);
    const freeNow = await typeHandle(theirs2.dialog, theirs2.field, moved.slice(2));
    results.check("after the 10 days the other Carbon's field says it is available", freeNow.includes(`${moved} is available`) && !(await theirs2.submit.isDisabled()), freeNow);
    await theirs2.submit.click();
    await theirs2.dialog.waitFor({ state: "hidden", timeout: 10_000 });
    const otherMe = await until(() => getMe(other.probe), me => me.id === moved, 10_000);
    results.check("…and takes it", otherMe.id === moved, otherMe.id);
    const ownerView = await call<{ available: boolean; reason: string | null }>(owner.probe, `/v1/ids/available?id=${encodeURIComponent(moved)}`);
    const ownerGrab = await call<{ error?: { details?: { suggestions?: string[] } } }>(owner.probe, "/v1/me/id", { method: "POST", json: { id: moved } });
    results.check("the first owner can no longer take it back (taken; 409 id_taken with suggestions)", ownerView.body.available === false && ownerView.body.reason === "taken" && ownerGrab.status === 409 && codeOf(ownerGrab.body) === "id_taken" && (ownerGrab.body.error?.details?.suggestions?.length ?? 0) > 0, `${JSON.stringify(ownerView.body)} / ${ownerGrab.status} ${codeOf(ownerGrab.body)}`);

    // 6. At most 5 changes in 24 hours: the owner made 2; three more through the API, the sixth in the dialog.
    const steps = [`c:acct-r1-${t}`, `c:acct-r2-${t}`, `c:acct-r3-${t}`];
    const made: number[] = [];
    for (const id of steps) made.push((await call(owner.probe, "/v1/me/id", { method: "POST", json: { id } })).status);
    results.check("changes 3, 4 and 5 of the day go through", made.every(status => status === 200), made.join(","));
    ({ dialog, field, submit } = await openDialog(owner.page, env.site, steps[2]!));
    const sixth = `acct-r4-${t}`;
    await typeHandle(dialog, field, sixth, text => text.includes("available"));
    await submit.click();
    const limited = await idStatus(dialog, text => /5 times/.test(text));
    await shot(env, owner.page, "acct-id-03-limit");
    results.check("the sixth change in 24 hours is refused in the dialog with the reason and when to retry", /already changed its id 5 times in the last 24 hours/.test(limited) && /Try again/.test(limited), limited.slice(0, 240));
    const api6 = await call(owner.probe, "/v1/me/id", { method: "POST", json: { id: `c:${sixth}` } });
    results.check("…the API's 429 rate_limited carries Retry-After and the limit", api6.status === 429 && codeOf(api6.body) === "rate_limited" && Number(api6.headers["retry-after"] ?? 0) > 0 && JSON.stringify(api6.body).includes('"limit":5'), `${api6.status} retry-after ${api6.headers["retry-after"]}`);
    results.check("…and the id stayed", (await getMe(owner.probe)).id === steps[2]);
    await owner.page.keyboard.press("Escape");

    // 7. The session cookie alone can't change the id from another site (CSRF): a foreign Origin, or none, is refused.
    const cookie = (await owner.context.cookies(env.site)).map(entry => `${entry.name}=${entry.value}`).join("; ");
    const foreign = await api(ctx, "/v1/me/id", { method: "POST", json: { id: `c:acct-csrf-${t}` }, headers: { cookie, origin: "http://evil.example" } });
    const noOrigin = await api(ctx, "/v1/me/id", { method: "POST", json: { id: `c:acct-csrf-${t}` }, headers: { cookie } });
    const sameSite = await api<{ id?: string }>(ctx, "/v1/me", { headers: { cookie } });
    results.check("with the session cookie, a change from a foreign Origin (or none) is refused: 403 origin_not_allowed, id unchanged", foreign.status === 403 && codeOf(foreign.body) === "origin_not_allowed" && noOrigin.status === 403 && codeOf(noOrigin.body) === "origin_not_allowed" && sameSite.body.id === steps[2], `${foreign.status} ${codeOf(foreign.body)} / ${noOrigin.status} ${codeOf(noOrigin.body)} / ${sameSite.body.id}`);

    // 8. The history keeps every change.
    const history = (await call<{ items: Array<{ title: string }> }>(owner.probe, "/v1/me/history?kind=id_change&limit=50")).body.items.map(item => item.title);
    const wanted = [`Id changed from ${original} to ${moved}`, `Id changed from ${moved} to ${original}`, `Id changed from ${original} to ${steps[0]}`, `Id changed from ${steps[1]} to ${steps[2]}`, `Account created with the id ${original}`];
    results.check("the id history lists the creation and all five changes", wanted.every(title => history.includes(title)) && history.length === 6, history.join(" | "));
    await owner.context.close();
    await other.context.close();
  },
};

export const journey = changeId;
