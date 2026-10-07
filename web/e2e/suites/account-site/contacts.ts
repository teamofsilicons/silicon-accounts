/**
 * Sign-in methods: emails and phone numbers, up to 10 of each, each verified with a code before it counts. One is
 * always primary; another can be made primary (apps that see it are told); the primary can't be removed; any of them
 * signs in to the same account, and a removed one no longer does. Both channels walk the same steps.
 */
import type { Locator, Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { api, codeFor, lastSeq, newContext, shot, signInOnSite, sleep, sql, tag, type Env } from "../../lib";
import { addContact, appUserinfo, call, codeOf, confirmMorph, getMe, hintOf, inbox, messageOf, newCarbon, probePage, randomPhone, rowByKey, rowsOf, signIntoApp, until, waitEvent } from "./_helpers";

type Channel = "email" | "phone";

interface Words {
  region: string;
  list: string;
  add: string;
  noun: string;
  plural: string;
  route: string;
  field: "email" | "phone";
  app: string;
}

const WORDS: Record<Channel, Words> = {
  email: { region: "Emails", list: "Your emails", add: "Add an email", noun: "email", plural: "emails", route: "/v1/me/emails", field: "email", app: "briefcase" },
  phone: { region: "Phone numbers", list: "Your phone numbers", add: "Add a phone number", noun: "phone number", plural: "phone numbers", route: "/v1/me/phones", field: "phone", app: "dm" },
};

const sectionOf = (page: Page, channel: Channel): Locator => page.getByRole("region", { name: WORDS[channel].region, exact: true });

/** "3 of 10 emails" from the section's counter (its aria-label). */
async function counter(page: Page, channel: Channel): Promise<string> {
  const label = await sectionOf(page, channel).locator(`[aria-label$=" of 10 ${WORDS[channel].plural}"]`).first().getAttribute("aria-label").catch(() => null);
  return label ?? "none";
}

/** Opens the adder and types the value (a phone number goes in with its country code: "Country not in the list?"). */
async function openAdder(page: Page, channel: Channel, value: string): Promise<Locator> {
  const section = sectionOf(page, channel);
  await section.getByRole("button", { name: WORDS[channel].add }).click();
  if (channel === "email") {
    await section.getByRole("textbox", { name: "Email address" }).fill(value);
  } else {
    await section.getByRole("button", { name: "Country not in the list?" }).click();
    await section.getByRole("textbox", { name: "Phone number" }).fill(value);
  }
  return section;
}

/**
 * Adds an email or phone number on /sign-in-methods: the value, "Send code", the 6-digit code (optionally a wrong one
 * first, whose refusal is returned), until its row is listed. Returns how long it took.
 */
async function addInUi(env: Env, page: Page, channel: Channel, value: string, wrongFirst = false): Promise<{ ms: number; wrong: string }> {
  const started = Date.now();
  const section = await openAdder(page, channel, value);
  const after = await lastSeq(env);
  await section.getByRole("button", { name: "Send code" }).click();
  const code = await codeFor(env, value, after);
  const otp = section.getByRole("group", { name: "Verification code" });
  await otp.waitFor({ timeout: 10_000 });
  await sleep(250);
  let wrong = "";
  if (wrongFirst) {
    const bad = `${code.slice(0, 5)}${(Number(code[5]) + 1) % 10}`;
    await page.keyboard.type(bad, { delay: 25 });
    wrong = await until(async () => (await section.innerText()).replace(/\s+/g, " "), text => /code is wrong/.test(text), 8_000);
    await sleep(300);
  }
  await page.keyboard.type(code, { delay: 25 });
  await rowByKey(page, WORDS[channel].list, value).waitFor({ timeout: 15_000 });
  await section.getByRole("button", { name: WORDS[channel].add }).waitFor({ timeout: 10_000 }).catch(() => undefined);
  return { ms: Date.now() - started, wrong };
}

/**
 * Adds through the page, but the first code expires (time travel) before it is typed: the adder says so, offers a new
 * code, and the new code works. Returns the adder's text after the expired code.
 */
async function addWithExpiredCode(env: Env, page: Page, channel: Channel, value: string): Promise<{ expired: string; resendEnabled: boolean }> {
  const section = await openAdder(page, channel, value);
  let after = await lastSeq(env);
  await section.getByRole("button", { name: "Send code" }).click();
  const first = await codeFor(env, value, after);
  await section.getByRole("group", { name: "Verification code" }).waitFor({ timeout: 10_000 });
  await sql(env, `update otp_challenges set expires_at = now() - interval '1 second' where destination = '${value}' and consumed_at is null`);
  await sleep(250);
  await page.keyboard.type(first, { delay: 25 });
  const expired = await until(async () => (await section.innerText()).replace(/\s+/g, " "), text => /has expired/.test(text), 8_000);
  const resend = section.getByRole("button", { name: "Send a new code" });
  const resendEnabled = await resend.isEnabled();
  after = await lastSeq(env);
  await resend.click();
  const second = await codeFor(env, value, after);
  await sleep(300);
  await section.getByRole("textbox", { name: "Verification code, digit 1 of 6" }).click();
  await page.keyboard.type(second, { delay: 25 });
  await rowByKey(page, WORDS[channel].list, value).waitFor({ timeout: 15_000 });
  return { expired, resendEnabled };
}

/**
 * Starts adding through the API (POST): the challenge id, or the refusal. `typed` is what is sent when it differs from
 * the normalized value the code goes to (an email in mixed case, a phone number in national format with its country).
 */
async function startAdd(env: Env, probe: Page, channel: Channel, value: string, typed?: Record<string, string>): Promise<{ status: number; challenge: string; code: string; body: unknown }> {
  const after = await lastSeq(env);
  const started = await call<{ challenge_id?: string }>(probe, WORDS[channel].route, { method: "POST", json: typed ?? (channel === "email" ? { email: value } : { phone: value }) });
  if (started.status !== 201 || !started.body.challenge_id) return { status: started.status, challenge: "", code: "", body: started.body };
  return { status: 201, challenge: started.body.challenge_id, code: await codeFor(env, value, after), body: started.body };
}

/** A headless code sign-in (the accounts CLI's): start + verify. Returns the start status and, when signed in, the account's uuid. */
async function codeSignIn(ctx: Ctx, channel: Channel, value: string): Promise<{ start: number; uuid: string | null; code: string }> {
  const after = await lastSeq(ctx.env);
  const start = await api<{ challenge_id?: string; error?: { code?: string } }>(ctx, "/v1/cli/login/start", { method: "POST", json: channel === "email" ? { email: value } : { phone: value } });
  if (start.status !== 200 || !start.body.challenge_id) return { start: start.status, uuid: null, code: start.body.error?.code ?? "" };
  const code = await codeFor(ctx.env, value, after);
  const verify = await api<{ access_token?: string }>(ctx, "/v1/cli/login/verify", { method: "POST", json: { challenge_id: start.body.challenge_id, code, client_label: "account-site e2e" } });
  if (!verify.body.access_token) return { start: start.status, uuid: null, code: "" };
  const me = await api<{ uuid?: string }>(ctx, "/v1/me", { headers: { authorization: `Bearer ${verify.body.access_token}` } });
  return { start: start.status, uuid: me.body.uuid ?? null, code: "" };
}

function contactJourney(channel: Channel): Journey {
  const w = WORDS[channel];
  const isEmail = channel === "email";
  return {
    name: `account-site-${isEmail ? "emails" : "phones"}`,
    title: `${w.plural} on Sign-in methods: added with a code up to 10 (the 11th refused, also when two codes race), refusals explained, make primary (${w.app === "dm" ? "DM" : "Briefcase"} told), the primary can't be removed, another can; any of them signs in to the same account`,
    async run(ctx) {
      const { env, results } = ctx;
      // A refused add (another account's address, a number the server rejects, an expired code) answers 409/410/422 on
      // the walked page.
      const carbon = await newCarbon(ctx, `acct-${isEmail ? "emails" : "phones"}`, { watch: [/status of 409/, /status of 410/, /status of 422/] });
      const { page, probe, uuid } = carbon;
      const fresh = () => (isEmail ? `acct.more.${tag()}@example.test` : randomPhone());
      const values: string[] = isEmail ? [carbon.email] : [];

      await page.goto(`${env.site}/sign-in-methods`);
      await sectionOf(page, channel).waitFor({ timeout: 30_000 });
      await sleep(600);
      results.check(`the counter starts at ${values.length} of 10`, (await counter(page, channel)) === `${values.length} of 10 ${w.plural}`, await counter(page, channel));
      if (!isEmail) {
        results.check("no phone number yet, said so", (await sectionOf(page, channel).innerText()).includes("No phone number yet. Add one to sign in with a code."));
        const first = fresh();
        const added = await addInUi(env, page, channel, first, true);
        values.push(first);
        results.check("a wrong code is refused in place with the tries left", /That code is wrong; 9 more tries/.test(added.wrong), added.wrong.match(/That code is wrong[^.]*\./)?.[0] ?? added.wrong.slice(0, 160));
        const me = await getMe(probe);
        results.check("the first phone number becomes the primary by itself", me.phones.length === 1 && me.phones[0]?.phone === first && me.phones[0]?.is_primary === true, JSON.stringify(me.phones));
      }
      // An app that sees this channel: Briefcase requires an email, DM a phone number.
      const seen = await signIntoApp(env, page, w.app);
      results.check(`setup: signed into ${w.app}, which received the primary ${w.noun}`, seen?.[w.field] === values[0], JSON.stringify(seen).slice(0, 200));
      await page.goto(`${env.site}/sign-in-methods`);
      const section = sectionOf(page, channel);
      await section.waitFor({ timeout: 30_000 });
      await sleep(600);

      // Refusals before and by the server, said where they happened.
      if (isEmail) {
        await openAdder(page, channel, "not-an-email");
        await section.getByRole("button", { name: "Send code" }).click();
        await sleep(400);
        results.check("an address without @ is refused before sending", (await section.innerText()).includes("Enter an email like name@example.com; “not-an-email” is missing an @."));
        await section.getByRole("textbox", { name: "Email address" }).fill(carbon.email.toUpperCase());
        await section.getByRole("button", { name: "Send code" }).click();
        await sleep(400);
        results.check("the account's own address (any case) is refused before sending", (await section.innerText()).includes(`${carbon.email} is already on your account.`));
        await section.getByRole("textbox", { name: "Email address" }).fill("saketdev12@example.test");
        await section.getByRole("button", { name: "Send code" }).click();
        const taken = await until(async () => (await section.innerText()).replace(/\s+/g, " "), text => /already belongs to another account/.test(text), 8_000);
        results.check("another account's address is refused by the server, in place", taken.includes("saketdev12@example.test already belongs to another account."), taken.match(/saketdev12[^.]*\./)?.[0] ?? "no message");
        const takenApi = await call(probe, w.route, { method: "POST", json: { email: "saketdev12@example.test" } });
        results.check("…the API's 409 email_in_use explains it in a correct sentence (\"An email can only belong to one account\", never \"A email\")", takenApi.status === 409 && codeOf(takenApi.body) === "email_in_use" && hintOf(takenApi.body) === "An email can only belong to one account. Sign in with it to use that account, or add a different email." && !/\bA email\b/.test(taken), `${takenApi.status} ${codeOf(takenApi.body)}: ${hintOf(takenApi.body)}`);
      } else {
        // Another Carbon holds a number (added through the API with its code), for the refusal further down.
        const holder = await newCarbon(ctx, "acct-phone-holder");
        const held = randomPhone();
        const holderAdded = await addContact(env, holder.probe, "phone", held);
        await holder.context.close();
        await openAdder(page, channel, "+1202");
        await section.getByRole("button", { name: "Send code" }).click();
        await sleep(400);
        results.check("a number that is too short is refused before sending", (await section.innerText()).includes("That number is too short."));
        await section.getByRole("textbox", { name: "Phone number" }).fill("+999 123 4567");
        await section.getByRole("button", { name: "Send code" }).click();
        await sleep(400);
        results.check("an unknown calling code is refused before sending", (await section.innerText()).includes("No country's calling code starts with +999"));
        await section.getByRole("textbox", { name: "Phone number" }).fill("+1 202 012 3456");
        await section.getByRole("button", { name: "Send code" }).click();
        const invalid = await until(async () => (await section.innerText()).replace(/\s+/g, " "), text => /not a valid phone number/.test(text), 8_000);
        results.check("a number the numbering plan rejects is refused by the server, in place", /is not a valid phone number/.test(invalid), invalid.match(/'[^']*' is not a valid phone number[^.]*\./)?.[0] ?? "no message");
        const own = await call(probe, w.route, { method: "POST", json: { phone: values[0] } });
        results.check("the account's own number is refused by the API (409 phone_already_added)", own.status === 409 && codeOf(own.body) === "phone_already_added", `${own.status} ${codeOf(own.body)}`);
        // A number on another Carbon's account: refused in place, and the API says why.
        await section.getByRole("textbox", { name: "Phone number" }).fill(held);
        await section.getByRole("button", { name: "Send code" }).click();
        const heldText = await until(async () => (await section.innerText()).replace(/\s+/g, " "), text => /already belongs to another account/.test(text), 8_000);
        results.check("another account's number is refused by the server, in place", holderAdded.status === 200 && /already belongs to another account\./.test(heldText) && heldText.replace(/[^0-9+]/g, "").includes(held), `${holderAdded.status}: ${heldText.match(/[^.]*already belongs to another account\.[^.]*\.?/)?.[0] ?? heldText.slice(-200)}`);
        const heldApi = await call(probe, w.route, { method: "POST", json: { phone: held } });
        results.check("…the API's 409 phone_in_use explains it (\"A phone number can only belong to one account…\")", heldApi.status === 409 && codeOf(heldApi.body) === "phone_in_use" && messageOf(heldApi.body) === `${held} already belongs to another account.` && hintOf(heldApi.body) === "A phone number can only belong to one account. Sign in with it to use that account, or add a different phone number.", `${heldApi.status} ${codeOf(heldApi.body)}: ${messageOf(heldApi.body)} ${hintOf(heldApi.body)}`);
      }
      await section.getByRole("button", { name: "Cancel" }).first().click();
      await sleep(400);

      if (!isEmail) {
        // Ten wrong codes in a row lock the number for a minute (even the right code waits); after it (time travel)
        // the right code works.
        const lockedPhone = fresh();
        const started = await startAdd(env, probe, channel, lockedPhone);
        const wrongCode = started.code === "000000" ? "111111" : "000000";
        const tries: Array<{ status: number; remaining: unknown }> = [];
        for (let i = 0; i < 10; i++) {
          const answer = await call<{ error?: { details?: { remaining_attempts?: number } } }>(probe, `${w.route}/verify`, { method: "POST", json: { challenge_id: started.challenge, code: wrongCode } });
          tries.push({ status: answer.status, remaining: answer.body.error?.details?.remaining_attempts });
        }
        results.check("wrong codes count down: 9 tries left after the first, none after the 10th", tries[0]?.status === 422 && tries[0]?.remaining === 9 && tries[9]?.status === 422 && tries[9]?.remaining === 0, JSON.stringify(tries.map(entry => entry.remaining)));
        const during = await call(probe, `${w.route}/verify`, { method: "POST", json: { challenge_id: started.challenge, code: started.code } });
        results.check("during the 1-minute cooldown even the right code waits: 423 verification_locked with Retry-After", during.status === 423 && codeOf(during.body) === "verification_locked" && Number(during.headers["retry-after"] ?? 0) > 50, `${during.status} ${codeOf(during.body)} retry-after ${during.headers["retry-after"]}`);
        await sql(env, `update otp_challenges set locked_until = null where destination = '${lockedPhone}'`);
        const unlocked = await call(probe, `${w.route}/verify`, { method: "POST", json: { challenge_id: started.challenge, code: started.code } });
        results.check("after the cooldown (time travel) the right code adds the number", unlocked.status === 200, `${unlocked.status} ${codeOf(unlocked.body)}`);
        values.push(lockedPhone);
      }

      // Up to 9 through the page (the first with a wrong code first, for emails).
      const times: number[] = [];
      while (values.length < 9) {
        const value = fresh();
        if (isEmail && values.length === 8) {
          const expiry = await addWithExpiredCode(env, page, channel, value);
          results.check("a code that expired (10 minutes, time travel) is refused in place, and a new one can be sent at once", /It has expired; send a new one\./.test(expiry.expired) && /expired/i.test(expiry.expired) && expiry.resendEnabled, expiry.expired.match(/Enter the 6-digit code[^|]*/)?.[0]?.slice(0, 220) ?? expiry.expired.slice(0, 220));
          results.check("…the new code adds it", (await rowsOf(page, w.list)).some(row => row.startsWith(value)));
          values.push(value);
          continue;
        }
        const added = await addInUi(env, page, channel, value, isEmail && values.length === 1);
        if (added.wrong) results.check("a wrong code is refused in place with the tries left", /That code is wrong; 9 more tries/.test(added.wrong), added.wrong.match(/That code is wrong[^.]*\./)?.[0] ?? added.wrong.slice(0, 160));
        values.push(value);
        times.push(added.ms);
      }
      results.metric(`add one ${w.noun} on the page (median of ${times.length})`, [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)] ?? 0);
      results.check(`9 ${w.plural}: the counter follows`, (await counter(page, channel)) === `9 of 10 ${w.plural}`, await counter(page, channel));
      const listed = await rowsOf(page, w.list);
      results.check(`all 9 are listed, the primary first`, listed.length === 9 && /Primary/.test(listed[0] ?? ""), `${listed.length} rows; first: ${listed[0]}`);

      // At 9, two codes started before either is used: the first fills the 10th place, the second is refused.
      const x = fresh();
      const y = fresh();
      // The 10th is typed the way people do (mixed case; national format with its country) and stored normalized.
      const typedX: Record<string, string> = isEmail ? { email: x.replace(/^acct/, "ACCT").replace("example", "Example") } : { phone: `(${x.slice(2, 5)}) ${x.slice(5, 8)}-${x.slice(8)}`, country: "US" };
      const sx = await startAdd(env, probe, channel, x, typedX);
      const sy = await startAdd(env, probe, channel, y);
      results.check("at 9, codes for two more can be sent", sx.status === 201 && sy.status === 201, `${sx.status} ${sy.status}`);
      const vx = await call(probe, `${w.route}/verify`, { method: "POST", json: { challenge_id: sx.challenge, code: sx.code } });
      const vy = await call(probe, `${w.route}/verify`, { method: "POST", json: { challenge_id: sy.challenge, code: sy.code } });
      results.check(`the first verified becomes the 10th`, vx.status === 200, `${vx.status} ${JSON.stringify(vx.body).slice(0, 120)}`);
      const storedX = ((await getMe(probe))[isEmail ? "emails" : "phones"] as Array<{ email?: string; phone?: string }>).some(item => (item.email ?? item.phone) === x);
      results.check(isEmail ? "an address typed in mixed case is stored lowercase" : "a number typed in national format with its country is stored in E.164", storedX, `${JSON.stringify(typedX)} → ${x}`);
      results.check(`the second is refused at verification: 422 ${w.field}_limit_reached`, vy.status === 422 && codeOf(vy.body) === `${w.field}_limit_reached`, `${vy.status} ${codeOf(vy.body)} ${messageOf(vy.body)}`);
      values.push(x);

      await page.reload();
      await section.waitFor({ timeout: 30_000 });
      await sleep(800);
      await shot(env, page, `acct-${channel}-01-ten`, true);
      const atTen = (await section.innerText()).replace(/\s+/g, " ");
      results.check("10 of 10: the counter, the limit said, no way to add another", (await counter(page, channel)) === `10 of 10 ${w.plural}` && atTen.includes(`You have 10 ${w.plural}, the most an account can hold. Remove one to add another.`) && (await section.getByRole("button", { name: w.add }).count()) === 0, atTen.slice(-200));
      const eleventh = await call(probe, w.route, { method: "POST", json: isEmail ? { email: fresh() } : { phone: fresh() } });
      results.check(`the 11th is refused by the API: 422 ${w.field}_limit_reached, saying the limit`, eleventh.status === 422 && codeOf(eleventh.body) === `${w.field}_limit_reached` && messageOf(eleventh.body).includes(`already has 10 ${w.plural}`), `${eleventh.status} ${codeOf(eleventh.body)}: ${messageOf(eleventh.body)}`);
      const remove = `Remove ${isEmail ? "an email" : "a phone number"} you no longer use, then add the new one.`;
      results.check(`…both limit refusals say what to do in a correct sentence ("${remove}")`, hintOf(eleventh.body) === remove && hintOf(vy.body) === remove, `${hintOf(eleventh.body)} / ${hintOf(vy.body)}`);
      const stored = (await getMe(probe))[isEmail ? "emails" : "phones"].length;
      results.check("the account holds exactly 10", stored === 10, String(stored));

      // Make another one primary: the badge moves, the app that sees it is told and sees the new one.
      const target = values[3]!;
      const before = (await inbox(env, w.app)).last_seq;
      const row = rowByKey(page, w.list, target);
      await row.getByRole("button", { name: "Make primary" }).click();
      const promoted = await until(async () => (await getMe(probe))[isEmail ? "emails" : "phones"] as Array<{ is_primary: boolean; email?: string; phone?: string }>, items => items.some(item => item.is_primary && (item.email ?? item.phone) === target), 10_000);
      results.check(`the ${w.noun} is the primary now (and only it)`, promoted.filter(item => item.is_primary).length === 1, JSON.stringify(promoted.filter(item => item.is_primary)));
      await sleep(900);
      const top = (await rowsOf(page, w.list))[0] ?? "";
      results.check("the page lists it first with the Primary badge", /Primary/.test(top) && (await row.innerText()).includes("Primary"), top);
      const event = await waitEvent(env, w.app, "account.updated", uuid, { after: before });
      results.check(`${w.app} got account.updated with changed [${w.field}] and the new primary`, !!event && JSON.stringify(event.payload.data.changed) === `["${w.field}"]` && (event.payload.data.account as Record<string, unknown> | undefined)?.[w.field] === target, JSON.stringify(event?.payload.data ?? null).slice(0, 240));
      const info = await appUserinfo(env, w.app, uuid);
      results.check(`${w.app}'s userinfo has the new primary`, info.body[w.field] === target, `${info.status} ${String(info.body[w.field])}`);

      // The primary can't be removed: its Remove is off, and the API refuses it.
      const primaryRow = rowByKey(page, w.list, target);
      results.check("the primary's Remove is disabled, and the row says why", (await primaryRow.getByRole("button", { name: "Remove", exact: true }).isDisabled()) && (await primaryRow.innerText()).includes(`Your primary ${w.noun}. To remove it, make another ${w.noun} primary first.`));
      const refused = await call(probe, `${w.route}/${encodeURIComponent(target)}`, { method: "DELETE" });
      results.check("the API refuses to remove the primary: 409 cannot_remove_primary", refused.status === 409 && codeOf(refused.body) === "cannot_remove_primary", `${refused.status} ${codeOf(refused.body)}`);

      // Another one can be removed (the former primary): its row goes, the counter drops, adding is back.
      const removed = values[0]!;
      await confirmMorph(rowByKey(page, w.list, removed), "Remove", "Remove");
      const after = await until(async () => (await getMe(probe))[isEmail ? "emails" : "phones"] as Array<{ email?: string; phone?: string }>, items => !items.some(item => (item.email ?? item.phone) === removed), 10_000);
      results.check(`the former primary is removed`, after.length === 9 && !after.some(item => (item.email ?? item.phone) === removed), String(after.length));
      await until(() => counter(page, channel), text => text === `9 of 10 ${w.plural}`, 8_000);
      results.check("the counter drops to 9 and adding is offered again", (await counter(page, channel)) === `9 of 10 ${w.plural}` && (await section.getByRole("button", { name: w.add }).count()) === 1, await counter(page, channel));
      await shot(env, page, `acct-${channel}-02-removed`, true);
      const twice = await call(probe, `${w.route}/${encodeURIComponent(removed)}`, { method: "DELETE" });
      results.check(`removing it again: 404 ${w.field}_not_found`, twice.status === 404 && codeOf(twice.body) === `${w.field}_not_found`, `${twice.status} ${codeOf(twice.body)}`);

      // The identity card's back lists them, the primary marked.
      await page.goto(`${env.site}/`);
      const me = await getMe(probe);
      const front = page.getByRole("region", { name: `Identity card of ${me.id}`, exact: true });
      await front.getByRole("button", { name: "Details" }).click({ timeout: 30_000 });
      const back = page.locator(`section[aria-label="Identity card of ${me.id}, details"]`);
      await sleep(800);
      const digits = (await back.innerText()).replace(/[^0-9a-z@.+]/gi, "");
      const shownAll = (isEmail ? me.emails.map(item => item.email) : me.phones.map(item => item.phone.replace(/\D/g, ""))).every(value => digits.includes(value));
      results.check(`the card's back lists all 9 ${w.plural}`, shownAll, digits.slice(0, 200));
      const detailRow = back.locator(`xpath=.//dt[normalize-space()="${isEmail ? "Emails" : "Phone numbers"}"]/following-sibling::dd[1]`);
      const entries = (await detailRow.locator(":scope > span").allInnerTexts()).map(text => text.replace(/\s+/g, " "));
      const marked = entries.filter(text => /Primary/.test(text));
      results.check("…with the new primary (only it) marked Primary", marked.length === 1 && (marked[0] ?? "").replace(/[^0-9a-z@.+]/gi, "").includes(isEmail ? target : target.replace(/\D/g, "")), JSON.stringify(marked));

      // Any of them signs in to the same account; the removed one no longer signs anyone in.
      if (isEmail) {
        const other = values[5]!;
        const context = await newContext(ctx.browser);
        const page2 = await context.newPage();
        results.watch(page2, `${channel}-second`);
        await signInOnSite(env, page2, other);
        const probe2 = await probePage(env, context);
        const me2 = await getMe(probe2);
        results.check("signing in on the site with another of the emails reaches the same account", me2.uuid === uuid, `${me2.uuid} vs ${uuid}`);
        await context.close();
      } else {
        const other = await codeSignIn(ctx, channel, values[5]!);
        results.check("a code to another of the phone numbers signs in to the same account (accounts CLI)", other.start === 200 && other.uuid === uuid, JSON.stringify(other));
      }
      const gone = await codeSignIn(ctx, channel, removed);
      results.check(`the removed ${w.noun} signs nobody in (404 account_not_found)`, gone.start === 404 && gone.code === "account_not_found", JSON.stringify(gone));

      // The history has every step.
      const titles = (await call<{ items: Array<{ title: string }> }>(probe, "/v1/me/history?kind=security&limit=100")).body.items.map(item => item.title);
      const word = isEmail ? "Email" : "Phone number";
      const addedTitles = titles.filter(title => title.startsWith(`${word} `) && title.endsWith(" added"));
      results.check(`history: every ${w.noun} added`, addedTitles.length === (isEmail ? 9 : 10), `${addedTitles.length}: ${addedTitles.slice(0, 3).join(" | ")}`);
      results.check("history: the new primary and the removal", titles.includes(`${target} is now the primary ${w.noun}`) && titles.includes(`${word} ${removed} removed`), titles.slice(0, 4).join(" | "));
      await carbon.context.close();
    },
  };
}

export const journeys: Journey[] = [contactJourney("email"), contactJourney("phone")];
