/**
 * The identity home ("/"): the card shows exactly what the account is (name, id, uuid, local time, photo, a stamp per
 * app, the details on its back, the counts beside it), and every detail on it can be edited in place: display name,
 * timezone, date of birth and photo, with the server's limits enforced and apps told only what they can see.
 */
import type { Journey } from "../../context";
import { json, shot, sleep, tag } from "../../lib";
import { addContact, call, codeOf, deliveredAfter, expectContinuePost, formatDate, getMe, inbox, jpegHeader, mainText, newCarbon, oversizedUploads, queuedEvents, requestSent, signIntoApp, solidPng, until, waitEvent } from "./_helpers";

/** A PNG header that claims width×height (no pixels): the service reads only the header. */
function pngHeader(width: number, height: number): Buffer {
  const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(width), ...be32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
}

const identityCard: Journey = {
  name: "account-site-identity-card",
  title: "Home and Personal info show the account exactly as /v1/me has it: the welcome, the CarbonID chip (copies it), since when, the Iris photo, Briefcase on Your apps; Personal info's name, CarbonID, date of birth, timezone, both emails (Primary) and no phone; both fit a phone",
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
    // What the sign-up page filled in (UNDERSTANDING.md "Sign up"): the c:id and the name from the email, the date of
    // birth exactly 18 years before the day of sign-up (the Carbon's own today), the default photo from Iris.
    const local = carbon.email.split("@")[0] ?? "";
    const signupDay = new Intl.DateTimeFormat("en-CA", { timeZone: me.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(me.created_at));
    const eighteen = `${Number(signupDay.slice(0, 4)) - 18}${signupDay.slice(4)}`;
    const tagPart = local.split(".").pop() ?? "";
    results.check("the sign-up defaults: the c:id and display name from the email, the date of birth exactly 18 years before sign-up", me.id === `c:${local.replace(/\./g, "-")}` && me.display_name.toLowerCase().includes(tagPart.toLowerCase()) && (me.dob === eighteen || (eighteen.endsWith("-02-29") && me.dob === eighteen.replace("-02-29", "-02-28"))), `${carbon.email} → ${me.id}, "${me.display_name}", dob ${me.dob} (signed up ${signupDay}, want ${eighteen})`);

    // Home (2026-11-11): "Your account" (the welcome, the CarbonID chip, since when, the photo), then Your apps.
    const started = Date.now();
    await page.goto(`${env.site}/`);
    const yours = page.getByRole("region", { name: "Your account", exact: true });
    await yours.waitFor({ timeout: 30_000 });
    results.metric("Home's account section visible after navigation", Date.now() - started);
    await sleep(900);
    await shot(env, page, "acct-card-01-front");
    const first = me.display_name.trim().split(/\s+/)[0] ?? me.display_name;
    const since = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: me.timezone }).format(new Date(me.created_at));
    const yoursText = (await yours.innerText()).replace(/\s+/g, " ");
    results.check("Home welcomes the Carbon by the first word of the display name", (await page.getByRole("heading", { level: 1 }).innerText()).trim() === `Welcome, ${first}`, yoursText.slice(0, 120));
    results.check("…shows the CarbonID on a chip that copies it, and since when", (await yours.getByRole("button", { name: `Copy your CarbonID, ${me.id}` }).count()) === 1 && yoursText.includes(`Member since ${since}`), yoursText.slice(0, 160));
    const photo = await yours.locator(`[role="img"][aria-label="${me.display_name}"] img`).first().getAttribute("src").catch(() => null);
    // The account's photo is Iris's default; Home draws the Carbon's own avatar in its place until a photo is uploaded.
    results.check("the account's photo is the default Carbon photo from Iris, and Home shows a picture", me.pfp_url === `${env.iris}/pfp/carbon?id=${me.uuid}` && !!photo, `${photo?.slice(0, 60)} / ${me.pfp_url}`);
    if (env.engine === "chromium") {
      // Chromium lets a test grant clipboard access; WebKit has no such permission.
      await carbon.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: env.site });
      await yours.getByRole("button", { name: `Copy your CarbonID, ${me.id}` }).click();
      const copiedId = await page.evaluate(() => navigator.clipboard.readText()).catch(error => `error: ${String(error)}`);
      results.check("the chip puts exactly the CarbonID on the clipboard", copiedId === me.id, copiedId);
    }
    const appsSection = page.getByRole("region", { name: "Your apps", exact: true });
    await appsSection.waitFor({ timeout: 20_000 });
    const openBriefcase = appsSection.getByRole("link", { name: /^Open Briefcase/ });
    results.check("Your apps on Home has Briefcase, signed in, with Open", (await openBriefcase.count()) === 1, (await appsSection.innerText()).replace(/\s+/g, " ").slice(0, 200));

    // Personal info: every detail as /v1/me has it, each row opening its editor.
    await page.goto(`${env.site}/personal`);
    const profile = page.getByRole("region", { name: "Profile", exact: true });
    const contact = page.getByRole("region", { name: "Contact", exact: true });
    await profile.waitFor({ timeout: 30_000 });
    await sleep(600);
    await shot(env, page, "acct-card-02-back");
    const profileText = (await profile.innerText()).replace(/\s+/g, " ");
    const contactText = (await contact.innerText()).replace(/\s+/g, " ");
    results.check("Profile: the name, the CarbonID, the date of birth and the timezone", profileText.includes(`Name ${me.display_name}`) && profileText.includes(`CarbonID ${me.id}`) && profileText.includes(`Date of birth ${formatDate(me.dob)}`) && profileText.includes(`Timezone ${me.timezone}`), profileText.slice(0, 260));
    const primary = me.emails.find(item => item.is_primary)?.email ?? "";
    results.check("Contact: both emails, the sign-up one marked Primary first", contactText.includes(carbon.email) && contactText.includes(second) && primary === carbon.email && contactText.indexOf(carbon.email) < contactText.indexOf(second) && /Primary/.test(contactText), contactText.slice(0, 240));
    results.check("Contact: no phone number yet, and the row offers to add one", /Phone Add a phone/.test(contactText), contactText.slice(0, 240));
    results.check("each row opens its editor by address (?edit=…)", (await profile.getByRole("link").evaluateAll(links => links.map(link => link.getAttribute("href")))).every(href => /\?edit=/.test(href ?? "")));

    // On a phone: no horizontal scroll on Home or Personal info, the CarbonID still shown.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ["/", "/personal"]) {
      await page.goto(`${env.site}${path}`);
      await page.locator("main").waitFor({ timeout: 30_000 });
      await sleep(900);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      results.check(`at 390 px ${path} has no horizontal scroll`, overflow <= 0, `${overflow} px wider`);
    }
    await shot(env, page, "acct-card-03-phone", true);
    results.check("at 390 px Personal info still shows the CarbonID", (await page.locator("main").innerText()).includes(me.id));
    await carbon.context.close();
  },
};

const profileEdits: Journey = {
  name: "account-site-profile",
  title: "editing the profile on Personal info's dialogs: the name (validated, Escape cancels, trimmed), timezone, date of birth (bounded), photo upload (client and server refusals) and removal; Briefcase hears only what it can see",
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
    const me0 = await getMe(probe);
    // Personal info (2026-11-12): each row opens its editor in a dialog, by address (?edit=…).
    const rowOf = (edit: string) => page.locator(`main [data-edit="${edit}"]`).first();
    const openEditor = async (edit: string, title: string) => {
      await page.goto(`${env.site}/personal?edit=${edit}`);
      const dialog = page.getByRole("dialog", { name: title });
      await dialog.waitFor({ timeout: 30_000 });
      await sleep(400);
      return dialog;
    };
    const rowText = async (edit: string) => (await rowOf(edit).innerText().catch(() => "")).replace(/\s+/g, " ");

    // 1. The name: refusals in place, Escape cancels, a save trims and tells Briefcase.
    let dialog = await openEditor("name", "Name");
    const nameField = dialog.getByRole("textbox", { name: "Your name" });
    await nameField.fill("");
    results.check("an empty name can't be saved (Save is off)", await dialog.getByRole("button", { name: "Save", exact: true }).isDisabled());
    await nameField.fill("x".repeat(101));
    await sleep(300);
    const longValue = await nameField.inputValue();
    results.check("more than 100 characters can't be saved (the field stops at 100, or the form says so)", longValue.length <= 100 || (await mainText(page)).includes("at most 100 characters (this one has 101)") || (await dialog.innerText()).includes("at most 100 characters (this one has 101)"), `${longValue.length} characters`);
    await nameField.fill(`Not Saved ${tag()}`);
    await page.keyboard.press("Escape");
    await sleep(500);
    results.check("Escape cancels: the name is unchanged everywhere", (await getMe(probe)).display_name === me0.display_name && (await rowText("name")).includes(me0.display_name));
    const before = (await inbox(env, "briefcase")).last_seq;
    let newName = `Ada Edited ${tag()}`;
    dialog = await openEditor("name", "Name");
    await dialog.getByRole("textbox", { name: "Your name" }).fill(`   ${newName}   `);
    const patchSent = requestSent(page, "PATCH", "/v1/me");
    await page.keyboard.press("Enter");
    const saved = await until(() => getMe(probe), me => me.display_name !== me0.display_name, 10_000);
    results.check("the new name is saved, trimmed", saved.display_name === newName, JSON.stringify(saved.display_name));
    results.check("…and Personal info shows it", await until(async () => (await rowText("name")).includes(newName), ok => ok, 5_000));
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
    await page.goto(`${env.site}/personal`);
    await rowOf("name").waitFor({ timeout: 30_000 });
    results.check("a name in any script is kept as typed and shown on Personal info", unicode.status === 200 && unicode.body.display_name === unicodeName && (await until(async () => rowText("name"), text => text.includes(unicodeName), 8_000)).includes(unicodeName), `${unicode.status} ${unicode.body.display_name}`);
    newName = unicodeName;
    const markup = `<img src=x onerror="window.__acctPwned=1"> <b>Bold</b> ${tag()}`;
    const marked = await call<{ display_name?: string }>(probe, "/v1/me", { method: "PATCH", json: { display_name: markup } });
    await page.reload();
    await rowOf("name").waitFor({ timeout: 30_000 });
    await sleep(800);
    const asText = await until(async () => rowText("name"), text => text.includes(markup), 8_000);
    const injected = await page.evaluate(() => ({ pwned: (window as unknown as { __acctPwned?: number }).__acctPwned ?? null, images: document.querySelectorAll('main img[src="x"]').length, bold: Array.from(document.querySelectorAll("main b")).filter(element => element.textContent === "Bold").length }));
    results.check("markup in a name is shown as text, never run or rendered", marked.status === 200 && asText.includes(markup) && injected.pwned === null && injected.images === 0 && injected.bold === 0, `${marked.status} ${JSON.stringify(injected)}`);
    const restored = await call(probe, "/v1/me", { method: "PATCH", json: { display_name: unicodeName } });
    results.check("setup: the name is back", restored.status === 200);

    // 2. Timezone: the editor's search; Briefcase (no timezone scope) is not told.
    dialog = await openEditor("timezone", "Timezone");
    const search = dialog.getByRole("combobox", { name: "Timezone" });
    await search.click();
    await search.fill("");
    await page.keyboard.type("Lond", { delay: 40 });
    await page.getByRole("option", { name: /^London, Europe/ }).first().click({ timeout: 5_000 });
    await dialog.getByRole("button", { name: "Save Timezone" }).click();
    const zoned = await until(() => getMe(probe), me => me.timezone !== me0.timezone, 10_000);
    results.check("the timezone is saved as Europe/London", zoned.timezone === "Europe/London", zoned.timezone);
    results.check("Personal info's timezone row moves to London", await until(async () => (await rowText("timezone")).includes("Europe/London"), ok => ok, 5_000), await rowText("timezone"));
    await sleep(800);
    await shot(env, page, "acct-profile-01-london");
    results.check("Briefcase is not told about the timezone (it can't see it)", (await queuedEvents(env, "briefcase", uuid, "account.updated", "and payload->'data'->'changed' ? 'timezone'")) === 0);
    const badZone = await call(probe, "/v1/me", { method: "PATCH", json: { timezone: "Mars/Olympus_Mons" } });
    results.check("the API refuses a timezone that is not IANA (422)", badZone.status === 422 && JSON.stringify(badZone.body).includes("timezone"), JSON.stringify(badZone.body).slice(0, 200));

    // 3. Date of birth: the year, then the day on the calendar; the API keeps it in the past and after 1900.
    dialog = await openEditor("dob", "Date of birth");
    await dialog.getByRole("combobox", { name: "Year" }).click({ timeout: 5_000 });
    await page.getByRole("option", { name: "1990", exact: true }).click({ timeout: 5_000 });
    await sleep(400);
    const month = me0.dob.slice(5, 7);
    const monthName = new Date(`1990-${month}-15T00:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
    // The calendar's days are gridcells (Silicon UI Calendar), named "Thursday, November 15, 1990".
    await dialog.getByRole("gridcell", { name: new RegExp(`${monthName} 15, 1990$`) }).click({ timeout: 5_000 });
    await sleep(300);
    await shot(env, page, "acct-profile-02-dob");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    const dobbed = await until(() => getMe(probe), me => me.dob !== me0.dob, 10_000);
    results.check("the date of birth is saved", dobbed.dob === `1990-${month}-15`, dobbed.dob);
    results.check("…and Personal info shows it", await until(async () => (await rowText("dob")).includes(formatDate(`1990-${month}-15`)), ok => ok, 5_000), formatDate(`1990-${month}-15`));
    results.check("Briefcase is not told about the date of birth (it can't see it)", (await queuedEvents(env, "briefcase", uuid, "account.updated", "and payload->'data'->'changed' ? 'dob'")) === 0);
    const tomorrow = new Date(Date.now() + 36 * 3600_000).toISOString().slice(0, 10);
    for (const [dob, why] of [[tomorrow, "in the future"], ["1899-12-31", "before 1900"], ["2001-02-29", "not a date"], ["15/10/1990", "not YYYY-MM-DD"]] as const) {
      const answer = await call(probe, "/v1/me", { method: "PATCH", json: { dob } });
      results.check(`the API refuses a date of birth ${why} (422)`, answer.status === 422 && JSON.stringify(answer.body).includes("dob"), `${dob}: ${answer.status} ${JSON.stringify(answer.body).slice(0, 160)}`);
    }
    results.check("the refusals changed nothing", (await getMe(probe)).dob === `1990-${month}-15`);

    // 4. The photo, in the Photo dialog's upload: client-side refusals first (no request leaves), then a real PNG.
    const uploads: string[] = [];
    page.on("request", request => {
      if (request.url().endsWith("/v1/me/photo") && request.method() === "POST") uploads.push(request.url());
    });
    dialog = await openEditor("photo", "Photo");
    const fileInput = dialog.locator('input[type="file"]');
    const huge = Buffer.alloc(2 * 1024 * 1024 + 1);
    solidPng(1, 1, [0, 0, 0]).copy(huge);
    await fileInput.setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: huge });
    const hugeText = await until(async () => (await dialog.innerText()).replace(/\s+/g, " "), text => text.includes("huge.png") && /2 ?MB/.test(text), 5_000);
    results.check("a photo over 2 MB is refused before uploading", /huge\.png/.test(hugeText) && /2 ?MB/.test(hugeText), hugeText.slice(0, 240) || "no message");
    await shot(env, page, "acct-profile-03-too-big");
    results.check("…and it sent nothing", uploads.length === 0, String(uploads.length));

    const png = solidPng(96, 96, [31, 95, 184]);
    const beforePhoto = (await inbox(env, "briefcase")).last_seq;
    dialog = await openEditor("photo", "Photo");
    const answered = page.waitForResponse(response => response.url().endsWith("/v1/me/photo") && response.request().method() === "POST", { timeout: 20_000 });
    const uploadStarted = Date.now();
    await dialog.locator('input[type="file"]').setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: png });
    const upload = await answered;
    results.metric("photo upload (96×96 PNG)", Date.now() - uploadStarted);
    results.check("the PNG uploads (201)", upload.status() === 201, String(upload.status()));
    const withPhoto = await until(() => getMe(probe), me => me.pfp_url !== me0.pfp_url, 10_000);
    results.check("the account's photo is now served by the site (/v1/photos/…)", withPhoto.pfp_url.startsWith(`${env.site}/v1/photos/`), withPhoto.pfp_url);
    await page.goto(`${env.site}/personal`);
    const shown = await until(async () => rowOf("photo").locator("img").first().getAttribute("src").catch(() => null), src => src === withPhoto.pfp_url, 10_000);
    results.check("Personal info shows the new photo", shown === withPhoto.pfp_url, String(shown));
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

    // Back to the default photo: Personal info's photo dialog has no remove (the avatar takes its place), so through the
    // API the site uses (DELETE /v1/me/photo).
    const removedPhoto = await call(probe, "/v1/me/photo", { method: "DELETE" });
    const reset = await until(() => getMe(probe), me => me.pfp_url !== withPhoto.pfp_url, 10_000);
    results.check("removing the photo puts the Iris default back", removedPhoto.status === 200 && reset.pfp_url === `${env.iris}/pfp/carbon?id=${uuid}`, `${removedPhoto.status} ${reset.pfp_url}`);
    const gone = await json(withPhoto.pfp_url);
    results.check("the removed upload is no longer served (404)", gone.status === 404, String(gone.status));

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
