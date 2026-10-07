/**
 * What an app hears follows what the Carbon shared on the app's details pages (UNDERSTANDING.md v2 "What's shared with
 * the app": a required detail is always shared, an optional one only when the Carbon ticks it, unticked until they do;
 * "Webhooks": an app is told when "any detail the app has access to changed"). The flows are walked over the hosted
 * flow's API exactly as the pages call it, and which apps an event is stored for is read right after each change (the
 * events are written in the change's own transaction), so "this app gets nothing" is exact instead of a timeout:
 *
 * - briefcase (email required, timezone optional): left unticked, briefcase never hears of a timezone change; ticked on
 *   a later sign-in with prompt=consent it does, and its account object carries the timezone; unticked again it stops;
 *   asked for with scope=timezone the page comes back; a returning Carbon with nothing new sees no page and keeps the
 *   grant; cancelling a re-consent keeps the grant as it was. Granting or withdrawing sends no event by itself.
 * - dm (phone required, email and timezone optional, its one custom page): the phone added on the page with a code,
 *   email ticked, timezone not: dm hears of email changes, never of timezone ones.
 * - ledgerly (two pages and a review: phone; date of birth and an optional timezone): the first app allowed to see the
 *   date of birth hears of its changes; asked for the timezone later, only the page that has it is shown again.
 * - a first sign-in cancelled on a page or on the review page makes no membership: the app never hears of the Carbon.
 */
import type { Journey } from "../../context";
import { codeFor, lastSeq } from "../../lib";
import { type AppSession, type Carbon, type DetailsPage, type EventRow, appCall, checkEq, must, newCarbon, randomPhone, sameJson, short, signIntoApp, storedEvents, uid, waitEvent, walkFlow } from "./_helpers";

const BASE_KEYS = ["display_name", "id", "kind", "membership_id", "pfp_url", "updated_at", "uuid", "version"];
const scopesOf = (session: AppSession) => session.scope.split(" ").filter(Boolean).sort();
/** A page as "field:mode[:missing][:shared][:granted]" rows, for exact comparisons. */
const rowsOf = (page: DetailsPage | undefined) => (page?.fields ?? []).map(f => [f.field, f.mode, f.missing ? "missing" : "", f.shared ? "shared" : "", f.previouslyGranted ? "granted" : ""].filter(Boolean).join(":"));
const targets = (rows: EventRow[]) => rows.map(row => `${row.type}→${row.target_id}`).sort();

interface AccountData {
  changed?: string[];
  account?: Record<string, unknown>;
}

export const journey: Journey = {
  name: "webhooks-grants",
  title: "apps hear exactly what the Carbon shared on their details pages: optional details unticked, ticked later (prompt=consent, scope=…), withdrawn, kept by a cancelled re-consent; dm's custom page; ledgerly's two pages and review (date of birth); a cancelled first sign-in makes no member",
  timeoutMs: 6 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    /** Runs `action` and returns its value with the webhook events stored about `carbon` meanwhile. */
    const during = async <T>(carbon: Carbon, action: () => Promise<T>): Promise<{ value: T; rows: EventRow[] }> => {
      const since = Date.now();
      const value = await action();
      return { value, rows: await storedEvents(env, { account: carbon.uuid, afterMs: since - 1 }) };
    };
    const patch = (carbon: Carbon, body: Record<string, unknown>) => during(carbon, async () => must(`PATCH /v1/me ${JSON.stringify(body)}`, await carbon.visitor.call("PATCH", "/v1/me", { json: body }), 200));
    /** What the app received for a stored event (the fake app lists only events whose v1 signature it verified). */
    const received = async (row: EventRow | undefined): Promise<AccountData | null> => {
      if (!row) return null;
      const event = await waitEvent(env, row.target_id, { event_id: row.event_id });
      return (event?.payload.data as AccountData | undefined) ?? null;
    };
    const rowFor = (rows: EventRow[], app: string) => rows.find(row => row.target_id === app && row.type === "account.updated");

    // ---- briefcase: the optional timezone left unticked -------------------------------------------------------------
    const ada = await newCarbon(ctx, "grants");
    const first = await during(ada, () => signIntoApp(ctx, ada, "briefcase"));
    checkEq(results, "briefcase, first sign-in: its one default page \"details\": email required, timezone optional and unticked", first.value.pages.map(page => ({ id: page.id, index: page.index, count: page.count, rows: rowsOf(page) })), [{ id: "details", index: 0, count: 1, rows: ["email:required:shared", "timezone:optional"] }]);
    checkEq(results, "briefcase, first sign-in: granted profile + email (the unticked timezone is not shared)", scopesOf(first.value), ["email", "profile"]);
    checkEq(results, "briefcase, first sign-in: signing in sends no webhook event", targets(first.rows), []);
    let tz = await patch(ada, { timezone: "Europe/Berlin" });
    checkEq(results, "unticked: a timezone change reaches no app (briefcase was not given the timezone)", targets(tz.rows), []);
    let named = await patch(ada, { display_name: `WH Grants ${uid()}` });
    let data = await received(rowFor(named.rows, "briefcase"));
    checkEq(results, "unticked: a rename reaches briefcase, signed, with the profile and email only (no timezone key)", Object.keys(data?.account ?? {}).sort(), [...BASE_KEYS, "email", "email_verified"].sort());

    // ---- ticked later, with prompt=consent ----------------------------------------------------------------------------
    const ticked = await during(ada, () => signIntoApp(ctx, ada, "briefcase", { prompt: "consent", optionalScopes: ["timezone"] }));
    checkEq(results, "prompt=consent: the page shows again, email already granted, timezone still unticked until ticked", ticked.value.pages.map(rowsOf), [["email:required:shared:granted", "timezone:optional"]]);
    checkEq(results, "prompt=consent with timezone ticked: granted profile + email + timezone", scopesOf(ticked.value), ["email", "profile", "timezone"]);
    checkEq(results, "ticking an optional detail sends no event by itself (the app learns it from the token response)", targets(ticked.rows), []);
    tz = await patch(ada, { timezone: "America/Chicago" });
    checkEq(results, "ticked: a timezone change is stored for briefcase", targets(tz.rows), ["account.updated→briefcase"]);
    data = await received(rowFor(tz.rows, "briefcase"));
    results.check("ticked: briefcase received changed [timezone] and the new timezone, signed", !!data && sameJson(data.changed, ["timezone"]) && data.account?.timezone === "America/Chicago" && "email" in (data.account ?? {}), short(data, 400));

    // ---- withdrawn: unticked on another re-consent ----------------------------------------------------------------------
    const withdrawn = await during(ada, () => signIntoApp(ctx, ada, "briefcase", { prompt: "consent", optionalScopes: [] }));
    checkEq(results, "prompt=consent again: the timezone shared before starts ticked (previously granted)", withdrawn.value.pages.map(rowsOf), [["email:required:shared:granted", "timezone:optional:shared:granted"]]);
    checkEq(results, "unticking it withdraws it: granted profile + email", scopesOf(withdrawn.value), ["email", "profile"]);
    checkEq(results, "withdrawing an optional detail sends no event by itself", targets(withdrawn.rows), []);
    tz = await patch(ada, { timezone: "Asia/Tokyo" });
    checkEq(results, "withdrawn: a timezone change no longer reaches briefcase", targets(tz.rows), []);
    named = await patch(ada, { display_name: `WH Grants ${uid()}` });
    data = await received(rowFor(named.rows, "briefcase"));
    results.check("withdrawn: briefcase's next account.updated carries no timezone any more", !!data && !("timezone" in (data.account ?? {})) && sameJson(data.changed, ["display_name"]), short(data?.account, 300));

    // ---- asked for with scope=timezone (no prompt) -----------------------------------------------------------------------
    const asked = await during(ada, () => signIntoApp(ctx, ada, "briefcase", { scope: "timezone", optionalScopes: ["timezone"] }));
    checkEq(results, "scope=timezone: a returning member sees the page again because the app asks for a detail not granted", asked.value.pages.map(rowsOf), [["email:required:shared:granted", "timezone:optional"]]);
    checkEq(results, "scope=timezone, ticked: granted profile + email + timezone", scopesOf(asked.value), ["email", "profile", "timezone"]);
    tz = await patch(ada, { timezone: "Europe/Lisbon" });
    checkEq(results, "asked and ticked: the timezone change reaches briefcase again", targets(tz.rows), ["account.updated→briefcase"]);
    data = await received(rowFor(tz.rows, "briefcase"));
    results.check("…with changed [timezone] and the new value", !!data && sameJson(data.changed, ["timezone"]) && data.account?.timezone === "Europe/Lisbon", short(data?.account, 300));

    // ---- a returning member with nothing new; a cancelled re-consent ---------------------------------------------------
    const plain = await signIntoApp(ctx, ada, "briefcase");
    checkEq(results, "a returning member with nothing new sees no page and keeps the grant (timezone included)", { pages: plain.pages.length, scopes: scopesOf(plain) }, { pages: 0, scopes: ["email", "profile", "timezone"] });
    const cancelled = await during(ada, () => walkFlow(ctx, ada, "briefcase", { prompt: "consent", cancelAt: 0 }));
    results.check("cancelling a re-consent ends at briefcase with error=access_denied", cancelled.value.redirect.searchParams.get("error") === "access_denied" && !cancelled.value.redirect.searchParams.has("code"), cancelled.value.redirect.href);
    checkEq(results, "…sends no event", targets(cancelled.rows), []);
    tz = await patch(ada, { timezone: "Africa/Nairobi" });
    checkEq(results, "…and keeps the grant as it was: the next timezone change still reaches briefcase", targets(tz.rows), ["account.updated→briefcase"]);
    const myApps = must("my apps", await ada.visitor.call<{ items: Array<{ app: { app_id: string }; status: string }> }>("GET", "/v1/me/apps?limit=200"), 200).body.items;
    checkEq(results, "…and the membership stays active", myApps.filter(item => item.app.app_id === "briefcase").map(item => item.status), ["active"]);

    // ---- dm: its one custom page, the required phone added there, email ticked, timezone not -----------------------------
    const phone = randomPhone();
    const dm = await during(ada, () => signIntoApp(ctx, ada, "dm", { optionalScopes: ["email"], phone }));
    const dmPage = dm.value.pages[0];
    checkEq(results, "dm: its one custom page \"Set up DM\" (dm-setup): phone required and missing, email and timezone optional, unticked", { pages: dm.value.pages.map(page => [page.id, page.title, page.count]), rows: rowsOf(dmPage) }, { pages: [["dm-setup", "Set up DM", 1]], rows: ["phone:required:missing:shared", "email:optional", "timezone:optional"] });
    checkEq(results, "dm: the phone was added on the page with a code; email ticked, timezone left unticked", { added: dmPage?.added, ticked: dmPage?.ticked }, { added: ["phone"], ticked: ["email"] });
    checkEq(results, "dm: granted profile + phone + email", scopesOf(dm.value), ["email", "phone", "profile"]);
    checkEq(results, "dm: adding the phone on dm's page sent nothing (no app was ever given a phone of this Carbon)", targets(dm.rows), []);
    tz = await patch(ada, { timezone: "Asia/Kolkata" });
    checkEq(results, "dm with timezone unticked: a timezone change reaches briefcase (granted) and not dm", targets(tz.rows), ["account.updated→briefcase"]);
    const email2 = `wh.grants2+${uid()}@example.test`;
    const seq = await lastSeq(env);
    const challenge = must("add a second email", await ada.visitor.call<{ challenge_id: string }>("POST", "/v1/me/emails", { json: { email: email2 } }), [200, 201]).body;
    must("verify it", await ada.visitor.call("POST", "/v1/me/emails/verify", { json: { challenge_id: challenge.challenge_id, code: await codeFor(env, email2, seq) } }), 200);
    const primary = await during(ada, async () => must("make it primary", await ada.visitor.call("POST", `/v1/me/emails/${encodeURIComponent(email2)}/primary`), 200));
    checkEq(results, "dm with email ticked: a new primary email reaches briefcase (required) and dm (ticked)", targets(primary.rows), ["account.updated→briefcase", "account.updated→dm"]);
    data = await received(rowFor(primary.rows, "dm"));
    checkEq(results, "dm received changed [email], the new address, and the phone it required — no timezone", { changed: data?.changed, email: data?.account?.email, phone: data?.account?.phone, keys: Object.keys(data?.account ?? {}).sort() }, { changed: ["email"], email: email2, phone, keys: [...BASE_KEYS, "email", "email_verified", "phone", "phone_verified"].sort() });

    // ---- ledgerly: two pages and a review --------------------------------------------------------------------------------
    const bea = await newCarbon(ctx, "ledger");
    const ledPhone = randomPhone();
    const led = await during(bea, () => signIntoApp(ctx, bea, "ledgerly", { phone: ledPhone }));
    checkEq(
      results,
      "ledgerly, first sign-in: page 1 of 2 \"contact\" (phone required, missing), page 2 of 2 \"about-you\" (date of birth required, timezone optional, unticked)",
      led.value.pages.map(page => ({ id: page.id, index: page.index, count: page.count, rows: rowsOf(page), added: page.added })),
      [
        { id: "contact", index: 0, count: 2, rows: ["phone:required:missing:shared"], added: ["phone"] },
        { id: "about-you", index: 1, count: 2, rows: ["dob:required:shared", "timezone:optional"], added: [] },
      ],
    );
    checkEq(results, "ledgerly: the review page lists the profile first, then phone and date of birth (not the unticked timezone)", led.value.review, ["profile", "phone", "dob"]);
    checkEq(results, "ledgerly: granted profile + phone + dob", scopesOf(led.value), ["dob", "phone", "profile"]);
    checkEq(results, "ledgerly: signing in (and adding the phone on page 1) sent nothing", targets(led.rows), []);
    const dob = await patch(bea, { dob: "1991-02-03" });
    checkEq(results, "a date-of-birth change reaches ledgerly, the one app allowed to see it", targets(dob.rows), ["account.updated→ledgerly"]);
    data = await received(rowFor(dob.rows, "ledgerly"));
    checkEq(results, "ledgerly received changed [dob], the new date, and the phone, with no email or timezone (not granted)", { changed: data?.changed, dob: data?.account?.dob, phone: data?.account?.phone, keys: Object.keys(data?.account ?? {}).sort() }, { changed: ["dob"], dob: "1991-02-03", phone: ledPhone, keys: [...BASE_KEYS, "dob", "phone", "phone_verified"].sort() });
    tz = await patch(bea, { timezone: "Europe/Madrid" });
    checkEq(results, "ledgerly with timezone unticked: a timezone change reaches no app", targets(tz.rows), []);
    const ledAsked = await signIntoApp(ctx, bea, "ledgerly", { scope: "timezone", optionalScopes: ["timezone"] });
    checkEq(results, "ledgerly asks for the timezone (scope=timezone): only the page that has it shows (1 of 1), then the review", { pages: ledAsked.pages.map(page => [page.id, page.index, page.count]), review: ledAsked.review }, { pages: [["about-you", 0, 1]], review: ["profile", "phone", "dob", "timezone"] });
    checkEq(results, "…granted profile + phone + dob + timezone (the phone page, not shown, keeps its grant)", scopesOf(ledAsked), ["dob", "phone", "profile", "timezone"]);
    tz = await patch(bea, { timezone: "America/Lima" });
    data = await received(rowFor(tz.rows, "ledgerly"));
    results.check("ticked on ledgerly's second page: the next timezone change reaches ledgerly with the new value", sameJson(targets(tz.rows), ["account.updated→ledgerly"]) && !!data && data.account?.timezone === "America/Lima" && sameJson(data.changed, ["timezone"]), `${targets(tz.rows).join(", ")} ${short(data?.account, 300)}`);

    // ---- a first sign-in cancelled: no membership, no events --------------------------------------------------------------
    const cy = await newCarbon(ctx, "cancel");
    const atReview = await during(cy, () => walkFlow(ctx, cy, "ledgerly", { phone: randomPhone(), cancelAt: "review" }));
    results.check("ledgerly cancelled on the review page: back at ledgerly with error=access_denied, after both pages", atReview.value.redirect.searchParams.get("error") === "access_denied" && atReview.value.pages.length === 2 && !!atReview.value.review, `${atReview.value.redirect.href} pages ${atReview.value.pages.length}`);
    const onPage = await during(cy, () => walkFlow(ctx, cy, "dm", { cancelAt: 0 }));
    results.check("dm cancelled on its page: back at dm with error=access_denied", onPage.value.redirect.searchParams.get("error") === "access_denied", onPage.value.redirect.href);
    const cyApps = must("my apps", await cy.visitor.call<{ items: Array<{ app: { app_id: string } }> }>("GET", "/v1/me/apps?limit=200"), 200).body.items.map(item => item.app.app_id);
    checkEq(results, "neither cancelled sign-in made a membership", cyApps, []);
    const cyRename = await patch(cy, { display_name: `WH Cancel ${uid()}`, timezone: "Europe/Oslo", dob: "1990-01-01" });
    checkEq(results, "so changes to that Carbon reach no app (nothing stored for ledgerly or dm)", targets([...atReview.rows, ...onPage.rows, ...cyRename.rows]), []);
    const lookup = await appCall(env, "ledgerly", "GET", `/v1/apps/ledgerly/users/${cy.uuid}`);
    results.check("…and ledgerly can't find the Carbon in its user base (404)", lookup.status === 404, `${lookup.status} ${short(lookup.body, 200)}`);
  },
};
