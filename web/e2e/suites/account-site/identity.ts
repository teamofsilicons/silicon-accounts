/**
 * The identity home ("/"): the card shows exactly what the account is (name, id, uuid, local time, photo, a stamp per
 * app, the details on its back, the counts beside it), and every detail on it can be edited in place: display name,
 * timezone, date of birth and photo, with the server's limits enforced and apps told only what they can see.
 */
import type { Journey } from "../../context";
import { json, shot, sleep, tag } from "../../lib";
import { addContact, call, codeOf, confirmMorph, deliveredAfter, expectContinuePost, formatDate, getMe, inbox, jpegHeader, mainText, newCarbon, oversizedUploads, queuedEvents, requestSent, signIntoApp, solidPng, timezoneLabel, until, utcOffset, waitEvent } from "./_helpers";

/** A PNG header that claims width×height (no pixels): the service reads only the header. */
function pngHeader(width: number, height: number): Buffer {
  const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
}

const identityCard: Journey = {
  name: "account-site-identity-card",
  title: "the identity card shows the account exactly as /v1/me has it: name, id, uuid, local time, Iris photo, a stamp per app, the back's emails/phones/dob, the counts and recent activity beside it, and it fits a phone",
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await newCarbon(ctx, "acct-card");
    const { page, probe } = carbon;
    const second = `acct.card.second.${tag()}@example.test`;
    const added = await addContact(env, probe, "email", second);
    results.check("setup: a second email is added and verified", added.status === 200, `${added.status} ${JSON.stringify(added.body).slice(0, 160)}`);
    const account = await signIntoApp(env, page, "briefcase");
    results.check("setup: the Carbon signed into Briefcase", account?.uuid === carbon.uuid, JSON.stringify(account).slice(0, 160));
    const me = await getMe(probe);

    const started = Date.now();
    await page.goto(`${env.site}/`);
    const front = page.getByRole("region", { name: `Identity card of ${me.id}`, exact: true });
    await front.waitFor({ timeout: 30_000 });
    await front.getByRole("list", { name: "Apps you have signed into" }).waitFor({ timeout: 20_000 }).catch(() => undefined);
    results.metric("identity card visible after navigation", Date.now() - started);
    await sleep(900);
    await shot(env, page, "acct-card-01-front");

    const frontText = (await front.innerText()).replace(/\s+/g, " ");
    results.check("the card's name is the display name", (await front.getByRole("button", { name: `Display name: ${me.display_name}`, exact: true }).count()) === 1, me.display_name);
    const idTitle = await front.locator(`[title="${me.id}"]`).count();
    results.check("the card's id is the c:id", idTitle >= 1 && frontText.includes(me.id), me.id);
    results.check("the card's uuid is the account's uuid (never changes)", (await front.locator(`[title="${me.uuid}"]`).count()) >= 1, me.uuid);
    results.check("the card says Carbon, and since when", /Carbon/.test(frontText) && frontText.includes(`since ${formatDate(me.created_at)}`), frontText.slice(0, 200));
    const zone = `${timezoneLabel(me.timezone)} · UTC${utcOffset(me.timezone)}`;
    results.check("local time: the account's timezone and its offset", me.timezone === "Asia/Kolkata" && frontText.includes(zone), `${me.timezone}: want "${zone}"`);
    const photo = await front.locator(`[role="img"][aria-label="${me.display_name}"] img`).first().getAttribute("src").catch(() => null);
    results.check("the photo is the default Carbon photo from Iris for this uuid", photo === me.pfp_url && me.pfp_url === `${env.iris}/pfp/carbon?id=${me.uuid}`, `${photo} / ${me.pfp_url}`);
    const stamp = front.getByRole("list", { name: "Apps you have signed into" }).getByRole("link", { name: "Briefcase", exact: true });
    results.check("a stamp for Briefcase, linking to its card on /apps", (await stamp.count()) === 1 && (await stamp.getAttribute("href")) === "/apps#app-briefcase", String(await stamp.getAttribute("href").catch(() => null)));
    results.check("the copy buttons for the id and the uuid", (await front.getByRole("button", { name: "Copy id" }).count()) === 1 && (await front.getByRole("button", { name: "Copy uuid" }).count()) === 1);
    if (env.engine === "chromium") {
      // Chromium lets a test grant clipboard access; WebKit has no such permission.
      await carbon.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: env.site });
      await front.getByRole("button", { name: "Copy uuid" }).click();
      const copiedUuid = await page.evaluate(() => navigator.clipboard.readText()).catch(error => `error: ${String(error)}`);
      await front.getByRole("button", { name: "Copy id" }).click();
      const copiedId = await page.evaluate(() => navigator.clipboard.readText()).catch(error => `error: ${String(error)}`);
      results.check("Copy uuid and Copy id put exactly the uuid and the c:id on the clipboard", copiedUuid === me.uuid && copiedId === me.id, `${copiedUuid} / ${copiedId}`);
    }

    // Beside the card: the counts and the latest activity.
    const glance = page.getByRole("complementary", { name: "At a glance" });
    const glanceText = await until(async () => (await glance.innerText().catch(() => "")).replace(/\s+/g, " "), text => /Recent activity/.test(text) && !/Nothing yet/.test(text) && /\d+ ?Apps you are signed into/.test(text), 15_000);
    const count = (label: string) => Number(new RegExp(`(\\d+) ?${label}`).exec(glanceText)?.[1] ?? -1);
    results.check("at a glance: 1 app signed into", count("Apps you are signed into") === 1, glanceText.slice(0, 200));
    results.check("at a glance: 0 Silicons in your care", count("Silicons in your care") === me.custodian_of && me.custodian_of === 0);
    results.check("at a glance: emails and phone numbers = 2 (the sign-up email and the added one)", count("Emails and phone numbers") === me.emails.length + me.phones.length && me.emails.length === 2, String(count("Emails and phone numbers")));
    const history = (await call<{ items: Array<{ title: string }> }>(probe, "/v1/me/history?limit=4")).body.items.map(item => item.title);
    const recent = await until(async () => (await glance.getByRole("list").last().locator("li").allInnerTexts().catch(() => [] as string[])).map(text => text.replace(/\s+/g, " ")), rows => rows.length >= Math.min(4, history.length), 10_000);
    results.check("recent activity: the 4 newest entries of the history, newest first", recent.length === Math.min(4, history.length) && history.every((title, index) => (recent[index] ?? "").startsWith(title.slice(0, 20))), `${JSON.stringify(recent)} vs ${JSON.stringify(history)}`);

    // The back of the card.
    await front.getByRole("button", { name: "Details" }).click();
    const back = page.getByRole("region", { name: `Identity card of ${me.id}, details`, exact: true });
    await back.waitFor({ timeout: 5_000 });
    await sleep(900);
    await shot(env, page, "acct-card-02-back");
    const backText = (await back.innerText()).replace(/\s+/g, " ");
    const primary = me.emails.find(item => item.is_primary)?.email ?? "";
    results.check("the back lists both emails, the sign-up one primary", backText.includes(carbon.email) && backText.includes(second) && primary === carbon.email && /Primary/.test(backText), backText.slice(0, 240));
    results.check("the back says there is no phone number yet", /No phone number yet/.test(backText));
    results.check("the back shows the date of birth (18 years before sign-up) and the timezone", backText.includes(formatDate(me.dob)) && backText.includes(zone), `${me.dob} → ${formatDate(me.dob)}`);
    results.check("the front is hidden from assistive tech while the back shows", (await page.locator(`section[aria-label="Identity card of ${me.id}"]`).getAttribute("aria-hidden")) === "true");
    await back.getByRole("button", { name: "Back" }).click();
    await sleep(600);

    // A stamp opens its app's card on /apps.
    await stamp.click();
    await page.waitForURL(`${env.site}/apps#app-briefcase`, { timeout: 15_000 });
    const appCard = page.locator("#app-briefcase");
    await appCard.waitFor({ timeout: 15_000 });
    results.check("the stamp opens /apps at Briefcase's card", (await appCard.innerText()).includes("Briefcase"));

    // The same card on a phone: no horizontal scroll, the id still on it.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${env.site}/`);
    await front.waitFor({ timeout: 30_000 });
    await sleep(900);
    await shot(env, page, "acct-card-03-phone", true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    results.check("at 390 px the identity page has no horizontal scroll", overflow <= 0, `${overflow} px wider`);
    results.check("at 390 px the card still shows the id", (await front.innerText()).includes(me.id));
    await carbon.context.close();
  },
};

const profileEdits: Journey = {
  name: "account-site-profile",
  title: "editing the profile on the card: display name (validated, Escape cancels, trimmed), timezone, date of birth (bounded), photo upload and removal (client and server refusals); Briefcase hears only what it can see",
  async run(ctx) {
    const { env, results } = ctx;
    const carbon = await newCarbon(ctx, "acct-profile");
    const { page, probe, uuid } = carbon;
    const refusedAtStart = (await inbox(env, "briefcase")).rejected.length;
    const account = await signIntoApp(env, page, "briefcase");
    results.check("setup: signed into Briefcase", account?.uuid === uuid);
    const apps = (await call<{ items: Array<{ app: { app_id: string }; granted_scopes: string[] }> }>(probe, "/v1/me/apps")).body.items;
    const scopes = apps.find(item => item.app.app_id === "briefcase")?.granted_scopes ?? [];
    results.check("Briefcase was granted profile and email only (timezone is optional and was not switched on)", scopes.includes("profile") && scopes.includes("email") && !scopes.includes("timezone") && !scopes.includes("dob"), scopes.join(" "));
    await page.goto(`${env.site}/`);
    const me0 = await getMe(probe);
    const front = page.getByRole("region", { name: `Identity card of ${me0.id}`, exact: true });
    await front.waitFor({ timeout: 30_000 });
    await sleep(600);

    // 1. Display name: refusals in place, Escape cancels, a save trims and tells Briefcase.
    const nameButton = front.getByRole("button", { name: /^Display name:/ });
    await nameButton.click();
    const nameField = page.getByRole("textbox", { name: "Display name" });
    await nameField.fill("");
    await page.keyboard.press("Enter");
    await sleep(500);
    results.check("an empty display name is refused in place", (await mainText(page)).includes("Enter a display name."));
    await nameField.fill("x".repeat(101));
    await page.keyboard.press("Enter");
    await sleep(500);
    results.check("101 characters are refused in place (the server's limit is 100)", (await mainText(page)).includes("at most 100 characters (this one has 101)"));
    await nameField.fill(`Not Saved ${tag()}`);
    await page.keyboard.press("Escape");
    await sleep(500);
    results.check("Escape cancels: the name is unchanged everywhere", (await getMe(probe)).display_name === me0.display_name && (await nameButton.getAttribute("aria-label")) === `Display name: ${me0.display_name}`);
    const before = (await inbox(env, "briefcase")).last_seq;
    let newName = `Ada Edited ${tag()}`;
    await nameButton.click();
    await nameField.fill(`   ${newName}   `);
    const patchSent = requestSent(page, "PATCH", "/v1/me");
    await page.keyboard.press("Enter");
    const saved = await until(() => getMe(probe), me => me.display_name !== me0.display_name, 10_000);
    results.check("the new display name is saved, trimmed", saved.display_name === newName, JSON.stringify(saved.display_name));
    results.check("…and the card shows it", await until(async () => (await nameButton.getAttribute("aria-label")) === `Display name: ${newName}`, ok => ok, 5_000));
    const updated = await waitEvent(env, "briefcase", "account.updated", uuid, { after: before });
    results.metric("display name PATCH sent → Briefcase received account.updated", deliveredAfter(updated, await patchSent));
    results.check("Briefcase got account.updated (signed) with changed [display_name] and the new name", !!updated && JSON.stringify(updated.payload.data.changed) === '["display_name"]' && (updated.payload.data.account as { display_name?: string } | undefined)?.display_name === newName, JSON.stringify(updated?.payload.data ?? null).slice(0, 300));
    const badName = await call(probe, "/v1/me", { method: "PATCH", json: { display_name: "tab\there" } });
    results.check("the API refuses control characters in a display name (422 with the field)", badName.status === 422 && codeOf(badName.body) === "validation_failed" && JSON.stringify(badName.body).includes("display_name"), `${badName.status} ${JSON.stringify(badName.body).slice(0, 200)}`);
    const wrongField = await call(probe, "/v1/me", { method: "PATCH", json: { id: "c:nope" } });
    results.check("PATCH /v1/me refuses the id and says where it changes (POST /v1/me/id)", wrongField.status === 422 && JSON.stringify(wrongField.body).includes("POST /v1/me/id"), JSON.stringify(wrongField.body).slice(0, 200));
    const hundred = await call<{ display_name?: string }>(probe, "/v1/me", { method: "PATCH", json: { display_name: "N".repeat(100) } });
    results.check("exactly 100 characters is a valid display name", hundred.status === 200 && hundred.body.display_name?.length === 100, `${hundred.status} ${hundred.body.display_name?.length}`);
    const unicodeName = `Zoë 李 Ωmega ${tag()}`;
    const unicode = await call<{ display_name?: string }>(probe, "/v1/me", { method: "PATCH", json: { display_name: unicodeName } });
    await page.reload();
    await front.waitFor({ timeout: 30_000 });
    results.check("a display name in any script is kept as typed and shown on the card", unicode.status === 200 && unicode.body.display_name === unicodeName && (await until(async () => nameButton.getAttribute("aria-label"), label => label === `Display name: ${unicodeName}`, 8_000)) === `Display name: ${unicodeName}`, `${unicode.status} ${unicode.body.display_name}`);
    newName = unicodeName;
    const markup = `<img src=x onerror="window.__acctPwned=1"> <b>Bold</b> ${tag()}`;
    const marked = await call<{ display_name?: string }>(probe, "/v1/me", { method: "PATCH", json: { display_name: markup } });
    await page.reload();
    await front.waitFor({ timeout: 30_000 });
    await sleep(800);
    const asText = await until(async () => nameButton.getAttribute("aria-label"), label => label === `Display name: ${markup}`, 8_000);
    const injected = await page.evaluate(() => ({ pwned: (window as unknown as { __acctPwned?: number }).__acctPwned ?? null, images: document.querySelectorAll('main img[src="x"]').length, bold: Array.from(document.querySelectorAll("main b")).filter(element => element.textContent === "Bold").length }));
    results.check("markup in a display name is shown as text, never run or rendered", marked.status === 200 && asText === `Display name: ${markup}` && injected.pwned === null && injected.images === 0 && injected.bold === 0, `${marked.status} ${JSON.stringify(injected)}`);
    const restored = await call(probe, "/v1/me", { method: "PATCH", json: { display_name: unicodeName } });
    await page.reload();
    await front.waitFor({ timeout: 30_000 });
    await until(async () => nameButton.getAttribute("aria-label"), label => label === `Display name: ${unicodeName}`, 8_000);
    results.check("setup: the name is back", restored.status === 200);

    // 2. Timezone: the editor's search, the card's clock follows; Briefcase (no timezone scope) is not told.
    await front.getByRole("button", { name: "Change your timezone" }).click();
    const search = page.getByRole("combobox", { name: "Timezone" });
    await search.waitFor({ timeout: 5_000 });
    await sleep(300);
    await search.click();
    await page.keyboard.type("Lond", { delay: 40 });
    await page.getByRole("option", { name: /^London, Europe/ }).first().click({ timeout: 5_000 });
    await page.getByRole("button", { name: "Save timezone" }).click();
    const zoned = await until(() => getMe(probe), me => me.timezone !== me0.timezone, 10_000);
    results.check("the timezone is saved as Europe/London", zoned.timezone === "Europe/London", zoned.timezone);
    const londonZone = `${timezoneLabel("Europe/London")} · UTC${utcOffset("Europe/London")}`;
    results.check("the card's local time moves to London", await until(async () => (await front.innerText()).replace(/\s+/g, " ").includes(londonZone), ok => ok, 5_000), londonZone);
    await sleep(800);
    await shot(env, page, "acct-profile-01-london");
    results.check("Briefcase is not told about the timezone (it can't see it)", (await queuedEvents(env, "briefcase", uuid, "account.updated", "and payload->'data'->'changed' ? 'timezone'")) === 0);
    const badZone = await call(probe, "/v1/me", { method: "PATCH", json: { timezone: "Mars/Olympus_Mons" } });
    results.check("the API refuses a timezone that is not IANA (422)", badZone.status === 422 && JSON.stringify(badZone.body).includes("timezone"), JSON.stringify(badZone.body).slice(0, 200));

    // 3. Date of birth on the back: the year, then the day; the API keeps it in the past and after 1900.
    await front.getByRole("button", { name: "Details" }).click();
    const back = page.getByRole("region", { name: `Identity card of ${me0.id}, details`, exact: true });
    await back.getByRole("button", { name: "Change your date of birth" }).click({ timeout: 10_000 });
    await page.getByRole("combobox", { name: "Year" }).click({ timeout: 5_000 });
    await page.getByRole("option", { name: "1990", exact: true }).click({ timeout: 5_000 });
    await sleep(300);
    await page.getByRole("button", { name: /^Day/ }).click({ timeout: 5_000 });
    const calendar = page.getByRole("dialog", { name: "Day calendar" });
    await calendar.waitFor({ timeout: 5_000 });
    const month = me0.dob.slice(5, 7);
    const monthName = new Date(`1990-${month}-15T00:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
    await calendar.getByRole("gridcell", { name: new RegExp(`${monthName} 15, 1990`) }).click({ timeout: 5_000 });
    await sleep(300);
    await shot(env, page, "acct-profile-02-dob");
    await page.getByRole("button", { name: "Save date" }).click();
    const dobbed = await until(() => getMe(probe), me => me.dob !== me0.dob, 10_000);
    results.check("the date of birth is saved", dobbed.dob === `1990-${month}-15`, dobbed.dob);
    results.check("…and the back of the card shows it", await until(async () => (await back.innerText()).includes(formatDate(`1990-${month}-15`)), ok => ok, 5_000), formatDate(`1990-${month}-15`));
    results.check("Briefcase is not told about the date of birth (it can't see it)", (await queuedEvents(env, "briefcase", uuid, "account.updated", "and payload->'data'->'changed' ? 'dob'")) === 0);
    const tomorrow = new Date(Date.now() + 36 * 3600_000).toISOString().slice(0, 10);
    for (const [dob, why] of [[tomorrow, "in the future"], ["1899-12-31", "before 1900"], ["2001-02-29", "not a date"], ["15/10/1990", "not YYYY-MM-DD"]] as const) {
      const answer = await call(probe, "/v1/me", { method: "PATCH", json: { dob } });
      results.check(`the API refuses a date of birth ${why} (422)`, answer.status === 422 && JSON.stringify(answer.body).includes("dob"), `${dob}: ${answer.status} ${JSON.stringify(answer.body).slice(0, 160)}`);
    }
    results.check("the refusals changed nothing", (await getMe(probe)).dob === `1990-${month}-15`);
    await back.getByRole("button", { name: "Back" }).click();
    await sleep(600);

    // 4. The photo: client-side refusals first (no request leaves), then a real PNG, then the default again.
    const uploads: string[] = [];
    page.on("request", request => {
      if (request.url().endsWith("/v1/me/photo") && request.method() === "POST") uploads.push(request.url());
    });
    const fileInput = page.locator('input[type="file"]');
    const huge = Buffer.alloc(2 * 1024 * 1024 + 1);
    solidPng(1, 1, [0, 0, 0]).copy(huge);
    // The photo menu (a popover, outside <main>) opens with the reason.
    const alerts = async () => (await page.getByRole("alert").allInnerTexts()).join(" | ").replace(/\s+/g, " ");
    await fileInput.setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: huge });
    const hugeText = await until(alerts, text => text.includes("huge.png"), 5_000);
    results.check("a photo over 2 MB is refused before uploading, saying its size", hugeText.includes("huge.png is 2.0 MB; a profile photo can be at most 2 MB"), hugeText.slice(0, 200) || "no message");
    await shot(env, page, "acct-profile-03-too-big");
    await fileInput.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") });
    const textText = await until(alerts, text => text.includes("notes.txt"), 5_000);
    results.check("a text file is refused before uploading", textText.includes("notes.txt is a text/plain file. Choose a PNG, JPEG, WebP or GIF image."), textText.slice(0, 200) || "no message");
    results.check("…and neither refusal sent anything", uploads.length === 0, String(uploads.length));
    await page.keyboard.press("Escape");
    await sleep(400);

    const png = solidPng(96, 96, [31, 95, 184]);
    const beforePhoto = (await inbox(env, "briefcase")).last_seq;
    const answered = page.waitForResponse(response => response.url().endsWith("/v1/me/photo") && response.request().method() === "POST", { timeout: 20_000 });
    const uploadStarted = Date.now();
    await fileInput.setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: png });
    const upload = await answered;
    results.metric("photo upload (96×96 PNG)", Date.now() - uploadStarted);
    results.check("the PNG uploads (201)", upload.status() === 201, String(upload.status()));
    const withPhoto = await until(() => getMe(probe), me => me.pfp_url !== me0.pfp_url, 10_000);
    results.check("the account's photo is now served by the site (/v1/photos/…)", withPhoto.pfp_url.startsWith(`${env.site}/v1/photos/`), withPhoto.pfp_url);
    const shown = await until(async () => front.locator(`[role="img"][aria-label="${newName}"] img`).first().getAttribute("src").catch(() => null), src => src === withPhoto.pfp_url, 10_000);
    results.check("the card shows the new photo", shown === withPhoto.pfp_url, String(shown));
    const served = await fetch(withPhoto.pfp_url);
    const servedBytes = Buffer.from(await served.arrayBuffer());
    results.check("the photo is served as the same PNG bytes, cached as immutable", served.status === 200 && served.headers.get("content-type") === "image/png" && /immutable/.test(served.headers.get("cache-control") ?? "") && servedBytes.equals(png), `${served.status} ${served.headers.get("content-type")} ${served.headers.get("cache-control")} ${servedBytes.length} bytes`);
    const photoEvent = await waitEvent(env, "briefcase", "account.updated", uuid, { after: beforePhoto });
    results.check("Briefcase got account.updated for the photo (pfp_url, part of the profile)", !!photoEvent && JSON.stringify(photoEvent.payload.data.changed) === '["pfp_url"]', JSON.stringify(photoEvent?.payload.data.changed ?? null));
    await sleep(500);
    await shot(env, page, "acct-profile-03-photo");

    // The server's own checks (direct calls, as any client could make them).
    const mismatch = await call(probe, "/v1/me/photo", { method: "POST", bytes: jpegHeader(), contentType: "image/png" });
    results.check("the API refuses JPEG bytes declared as PNG (422 photo_type_mismatch)", mismatch.status === 422 && codeOf(mismatch.body) === "photo_type_mismatch", `${mismatch.status} ${codeOf(mismatch.body)}`);
    const textType = await call(probe, "/v1/me/photo", { method: "POST", bytes: Buffer.from("hello"), contentType: "text/plain" });
    results.check("the API refuses a text/plain upload (415)", textType.status === 415 && codeOf(textType.body) === "unsupported_media_type", `${textType.status} ${codeOf(textType.body)}`);
    const empty = await call(probe, "/v1/me/photo", { method: "POST", bytes: Buffer.alloc(0), contentType: "image/png" });
    results.check("the API refuses an empty upload (422 empty_photo)", empty.status === 422 && codeOf(empty.body) === "empty_photo", `${empty.status} ${codeOf(empty.body)}`);
    // 2 MB + 1 byte, twenty times through the site (the public origin every client uses), and once straight at
    // accounts-api: each must be the API's 413 with its precise message, never a bare 500.
    const tries = await oversizedUploads(probe, "/v1/me/photo", solidPng(1, 1, [0, 0, 0]), 2 * 1024 * 1024 + 1, 20, "image/png");
    const statuses = tries.map(entry => entry.status);
    const bare = tries.filter(entry => entry.status !== 413);
    results.metric("oversized photo uploads through the site answered other than 413", bare.length, "of 20");
    const direct = await fetch(`${env.api}/v1/me/photo`, { method: "POST", headers: { "content-type": "image/png", origin: env.site }, body: huge });
    const directBody = (await direct.json().catch(() => null)) as { error?: { code?: string } } | null;
    results.check("straight at accounts-api, 2 MB + 1 byte is refused with 413 payload_too_large", direct.status === 413 && directBody?.error?.code === "payload_too_large", `${direct.status} ${JSON.stringify(directBody).slice(0, 160)}`);
    results.check("through the site, every 2 MB + 1 byte upload gets the API's 413 (20 tries)", bare.length === 0 && tries.every(entry => /payload_too_large|photo_too_large/.test(entry.text)), `statuses ${statuses.join(",")}; first other answer: ${bare[0] ? `${bare[0].status} ${JSON.stringify(bare[0].text)}` : "none"}`);
    // An API client that asks before sending a big body (Expect: 100-continue, as curl does over 1 MB) gets the same
    // 413: through the site (which says 100 Continue itself and passes the body on) and straight at accounts-api.
    const cookie = (await carbon.context.cookies(env.site)).map(entry => `${entry.name}=${entry.value}`).join("; ");
    const asking = { "content-type": "image/png", cookie, origin: env.site, "x-forwarded-for": carbon.ip };
    const askedSite: Array<{ status: number; text: string; continued: boolean; ms: number }> = [];
    for (let i = 0; i < 5; i++) askedSite.push(await expectContinuePost(`${env.site}/v1/me/photo`, huge, asking));
    const askedApi = await expectContinuePost(`${env.api}/v1/me/photo`, huge, asking);
    results.check("a client sending Expect: 100-continue with 2 MB + 1 byte gets the 413 too, through the site (5 tries) and straight at accounts-api", askedSite.every(entry => entry.status === 413 && /payload_too_large/.test(entry.text)) && askedApi.status === 413 && /payload_too_large/.test(askedApi.text), `site ${askedSite.map(entry => `${entry.status}${entry.continued ? "+100" : ""}`).join(",")}; direct ${askedApi.status} (100 Continue sent: ${askedApi.continued}, ${askedApi.ms} ms) ${askedApi.status === 413 ? "" : askedApi.text}`);
    // The 64 KB limit of every other write, through the site.
    const bigJson = await oversizedUploads(probe, "/v1/me", Buffer.from('{"display_name":"'), 64 * 1024 + 1, 10, "application/json", { method: "PATCH", fill: 0x78 });
    results.check("through the site, a JSON body over 64 KB (PATCH /v1/me) gets the API's 413 every time (10 tries)", bigJson.every(entry => entry.status === 413 && /payload_too_large/.test(entry.text)), `statuses ${bigJson.map(entry => entry.status).join(",")}; ${bigJson.find(entry => entry.status !== 413)?.text ?? ""}`);
    results.check("…and the refused bodies changed nothing", (await getMe(probe)).display_name === newName);
    const giant = await call(probe, "/v1/me/photo", { method: "POST", bytes: pngHeader(9000, 9000), contentType: "image/png" });
    results.check("the API refuses a PNG of 9000×9000 pixels (dimensions capped)", giant.status === 422, `${giant.status} ${codeOf(giant.body)}`);
    const httpUrl = await call(probe, "/v1/me", { method: "PATCH", json: { pfp_url: "http://example.com/a.png" } });
    results.check("a photo link must be https (422)", httpUrl.status === 422 && JSON.stringify(httpUrl.body).includes("pfp_url"), `${httpUrl.status}`);
    results.check("the refusals left the uploaded photo in place", (await getMe(probe)).pfp_url === withPhoto.pfp_url);

    // Back to the default photo from the photo menu.
    await front.getByRole("button", { name: "Change your photo" }).click();
    const menu = page.getByRole("dialog").filter({ hasText: "Profile photo" }).last();
    await menu.waitFor({ timeout: 5_000 });
    await confirmMorph(menu, "Remove photo", "Remove");
    const reset = await until(() => getMe(probe), me => me.pfp_url !== withPhoto.pfp_url, 10_000);
    results.check("Remove photo puts the Iris default back", reset.pfp_url === `${env.iris}/pfp/carbon?id=${uuid}`, reset.pfp_url);
    const gone = await json(withPhoto.pfp_url);
    results.check("the removed upload is no longer served (404)", gone.status === 404, String(gone.status));
    await page.keyboard.press("Escape");

    // The other formats the site takes (the PNG was above): a JPEG, and a WebP where the browser can encode one, drawn
    // on a canvas in the page, and a GIF; each uploads and is served as itself, byte for byte.
    const drawn = await probe.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 48;
      const pen = canvas.getContext("2d");
      if (pen) {
        pen.fillStyle = "#1f5fb8";
        pen.fillRect(0, 0, 64, 48);
        pen.fillStyle = "#f2c14e";
        pen.fillRect(8, 8, 24, 24);
      }
      const out: Record<string, string> = {};
      for (const type of ["image/jpeg", "image/webp"]) {
        const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, type, 0.9));
        if (!blob || blob.type !== type) continue;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let raw = "";
        for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i] ?? 0);
        out[type] = btoa(raw);
      }
      return out;
    });
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    const gifDecodes = await probe.evaluate(async b64 => {
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      return createImageBitmap(new Blob([bytes], { type: "image/gif" })).then(bitmap => `${bitmap.width}x${bitmap.height}`, error => `not decodable: ${String(error)}`);
    }, gif.toString("base64"));
    const samples: Array<[string, Buffer]> = [...Object.entries(drawn).map(([type, b64]): [string, Buffer] => [type, Buffer.from(b64, "base64")]), ["image/gif", gif]];
    const formatsSeen: string[] = [];
    let formatsOk = true;
    for (const [type, bytes] of samples) {
      const up = await call(probe, "/v1/me/photo", { method: "POST", bytes, contentType: type });
      const url = (await getMe(probe)).pfp_url;
      const served = await fetch(url);
      const back = Buffer.from(await served.arrayBuffer());
      const same = served.status === 200 && served.headers.get("content-type") === type && back.equals(bytes);
      formatsOk &&= up.status === 201 && same;
      formatsSeen.push(`${type} ${bytes.length} B: ${up.status} ${up.status === 201 ? "" : codeOf(up.body)} → ${served.status} ${served.headers.get("content-type")} ${back.equals(bytes) ? "same bytes" : "other bytes"}`);
    }
    results.check(`a JPEG${drawn["image/webp"] ? ", a WebP" : ""} and a GIF upload too, each served as itself, byte for byte`, formatsOk && samples.length >= 2 && gifDecodes === "1x1", `${formatsSeen.join(" | ")}; the GIF decodes in the browser as ${gifDecodes}`);
    const cleared = await call(probe, "/v1/me/photo", { method: "DELETE" });
    results.check("DELETE /v1/me/photo puts the Iris default back", cleared.status < 300 && (await getMe(probe)).pfp_url === `${env.iris}/pfp/carbon?id=${uuid}`, String(cleared.status));

    results.check("Briefcase refused no delivery (every webhook carried a valid signature)", (await inbox(env, "briefcase")).rejected.length === refusedAtStart, `${(await inbox(env, "briefcase")).rejected.length - refusedAtStart} refused`);

    // What /v1/me/history recorded (the Security kind).
    const security = (await call<{ items: Array<{ title: string; detail: string | null }> }>(probe, "/v1/me/history?kind=security&limit=50")).body.items;
    const titles = security.map(item => `${item.title} — ${item.detail ?? ""}`);
    results.check("history: the profile updates with the fields that changed", titles.some(text => text.startsWith("Profile updated") && text.includes("display name")) && titles.some(text => text.includes("timezone")) && titles.some(text => text.includes("date of birth")), titles.join(" | ").slice(0, 400));
    results.check("history: the photo uploaded and removed", titles.some(text => text.startsWith("Profile photo uploaded")) && titles.some(text => text.startsWith("Profile photo removed")));
    await carbon.context.close();
  },
};

export const journeys: Journey[] = [identityCard, profileEdits];
