/**
 * The Sign-in tab as the owner uses it: ten kinds of change saved together as one new version, kept across a reload,
 * in the API and in the version history (who, when, every path from what to what), on the hosted page a visitor
 * sees, and undone again from the history. Then the rules: refused texts and methods, a stale expected_version, and
 * an Idempotency-Key that never makes two versions.
 */
import { randomUUID } from "node:crypto";
import type { Journey } from "../../context";
import { json, newContext, shot, sleep, tag } from "../../lib";
import { appBasic, asSession, checkPoweredBy, ownerSignIn, readHostedLook } from "./_helpers";

const APP = "spacestation";

interface SigninConfig {
  methods: Record<string, boolean>;
  method_order: string[];
  copy: { title: string | null; subtitle: string | null; support_email: string | null; terms_url: string | null; privacy_url: string | null };
  redirect_uris: string[];
  allowed_origins: string[];
  remember_browser: boolean;
  required_fields: string[];
  optional_fields: string[];
}

interface AppDetail {
  config_version: number;
  signin_config: SigninConfig;
}

interface HistoryItem {
  version: number;
  actor: string;
  actor_account: { id: string; uuid: string } | null;
  changes: Array<{ path: string; before: unknown; after: unknown; secret?: boolean }>;
  at: string;
}

export const journey: Journey = {
  name: "developer-branding-signin-config",
  title: "Sign-in tab: ten edits saved as one version, persisted across reload, API and history (who, paths, before/after), on the hosted page, undone from history; refused edits, stale versions and idempotent retries",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const t = tag();
    const owner = await ownerSignIn(ctx, APP, "dvb-b-owner", { expected: [/status of (409|422)/] });
    const { page } = owner;
    const before = (await asSession<AppDetail>(page, env, "GET", `/v1/apps/${APP}`)).body;
    const v0 = before.config_version;
    const c0 = before.signin_config;
    const saveBar = page.getByRole("region", { name: "Unsaved changes" });

    await page.goto(`${env.site}/developer/${APP}/sign-in`);
    await page.getByText(`Stored version ${v0}`).waitFor({ timeout: 20_000 });
    const methods = page.getByRole("list", { name: "Sign-in methods, in the order they are shown" });

    // Ten changes in one draft.
    const title = `Space Station ${t}`;
    const subtitle = `Telemetry for every Silicon, run ${t}.`;
    const support = `help-${t}@example.test`;
    const redirect = `https://dvb-${t}.example/auth/callback`;
    const origin = `https://dvb-${t}.example`;
    await page.getByRole("switch", { name: "Phone", exact: true }).click();
    await methods.getByRole("button", { name: /^Move Phone, position/ }).focus();
    await page.keyboard.press("Home");
    await sleep(300);
    await page.getByRole("textbox", { name: "Title", exact: true }).fill(title);
    await page.getByRole("textbox", { name: "Subtitle", exact: true }).fill(subtitle);
    await page.getByRole("textbox", { name: "Support email", exact: true }).fill(support);
    const redirects = page.getByRole("textbox", { name: "Redirect URIs" });
    await redirects.fill(redirect);
    await redirects.press("Enter");
    const origins = page.getByRole("textbox", { name: "Allowed origins" });
    await origins.fill(origin);
    await origins.press("Enter");
    await page.getByRole("switch", { name: "Remember this browser" }).click();
    await page.getByRole("group", { name: "Required details" }).getByRole("button", { name: "Timezone" }).click();
    await sleep(300);
    const pending = (await saveBar.innerText().catch(() => "")).replace(/\s+/g, " ");
    results.check("the draft counts its changes in the save bar, and the Sign-in tab carries the unsaved dot", /\d+ unsaved changes/.test(pending) && (await page.getByRole("tab", { name: /^Sign-in/ }).getByRole("img", { name: "unsaved changes" }).count()) === 1, pending);
    await shot(env, page, "dvb-b-01-draft", true);
    const saveStarted = Date.now();
    await saveBar.getByRole("button", { name: "Save changes" }).click();
    await saveBar.getByText(`Saved as version ${v0 + 1}`).waitFor({ timeout: 20_000 }).catch(() => undefined);
    results.metric("Sign-in tab save (10 changes) → \"Saved as version\"", Date.now() - saveStarted);
    results.check(`Save stores the ten changes as version ${v0 + 1}`, (await page.getByText(`Stored version ${v0 + 1}`).count()) > 0);

    // Kept across a reload, exactly as typed.
    await page.reload();
    await page.getByText(`Stored version ${v0 + 1}`).waitFor({ timeout: 20_000 });
    const order = (await methods.getByRole("listitem").allInnerTexts()).map(text => text.trim().split(/\s/)[0]);
    const values = {
      phone: await page.getByRole("switch", { name: "Phone", exact: true }).getAttribute("aria-checked"),
      title: await page.getByRole("textbox", { name: "Title", exact: true }).inputValue(),
      subtitle: await page.getByRole("textbox", { name: "Subtitle", exact: true }).inputValue(),
      support: await page.getByRole("textbox", { name: "Support email", exact: true }).inputValue(),
      redirect: await page.locator(`#signin-redirects [data-tag="${redirect}"]`).count(),
      origin: await page.locator(`#signin-origins [data-tag="${origin}"]`).count(),
      remember: await page.getByRole("switch", { name: "Remember this browser" }).getAttribute("aria-checked"),
      requiredTz: await page.getByRole("group", { name: "Required details" }).getByRole("button", { name: "Timezone" }).getAttribute("aria-pressed"),
      optionalTz: await page.getByRole("group", { name: "Optional details" }).getByRole("button", { name: "Timezone" }).getAttribute("aria-pressed"),
    };
    results.check("after a reload the tab shows every saved value (Phone on and first, texts, URI, origin, remember, timezone required)", order[0] === "Phone" && values.phone === "true" && values.title === title && values.subtitle === subtitle && values.support === support && values.redirect === 1 && values.origin === 1 && values.remember === "true" && values.requiredTz === "true" && values.optionalTz === "false", `${order.join(",")} ${JSON.stringify(values)}`);

    // The API holds the same version and values.
    const saved = (await asSession<AppDetail>(page, env, "GET", `/v1/apps/${APP}`)).body;
    const s = saved.signin_config;
    results.check(`GET /v1/apps/${APP} answers version ${v0 + 1} with every saved value`, saved.config_version === v0 + 1 && s.methods.phone === true && s.method_order[0] === "phone" && s.copy.title === title && s.copy.subtitle === subtitle && s.copy.support_email === support && s.redirect_uris.includes(redirect) && s.allowed_origins.includes(origin) && s.remember_browser === true && s.required_fields.includes("timezone") && !s.optional_fields.includes("timezone"), JSON.stringify({ v: saved.config_version, order: s.method_order, copy: s.copy, req: s.required_fields, opt: s.optional_fields }).slice(0, 400));
    const app = await json<AppDetail>(`${env.site}/v1/apps/${APP}`, { headers: { authorization: appBasic(APP) } });
    results.check("the app's own credentials read the same version", app.status === 200 && app.body.config_version === v0 + 1);

    // The history: one entry for the save, by c:saket, with exactly the changed paths, each from → to.
    const history = (await asSession<{ items: HistoryItem[] }>(page, env, "GET", `/v1/apps/${APP}/signin-config/history`)).body.items ?? [];
    const entry = history[0];
    const paths = (entry?.changes ?? []).map(change => change.path).sort();
    const expectedPaths = ["allowed_origins", "copy.subtitle", "copy.support_email", "copy.title", "method_order", "methods.phone", "optional_fields", "redirect_uris", "remember_browser", "required_fields"];
    results.check(`the newest history entry is version ${v0 + 1}, made by c:saket`, entry?.version === v0 + 1 && entry.actor_account?.id === "c:saket", `${entry?.version} ${entry?.actor} ${entry?.actor_account?.id}`);
    results.check("it lists exactly the ten changed paths", JSON.stringify(paths) === JSON.stringify(expectedPaths), paths.join(", "));
    const titleChange = entry?.changes.find(change => change.path === "copy.title");
    results.check("each change keeps what it was before and what it became", titleChange?.before === c0.copy.title && titleChange?.after === title && JSON.stringify(entry?.changes.find(change => change.path === "method_order")?.before) === JSON.stringify(c0.method_order), JSON.stringify(titleChange));
    await page.getByRole("complementary", { name: "On this page" }).getByRole("button", { name: "History" }).click();
    const drawer = page.getByRole("dialog", { name: "Version history" });
    await drawer.getByText(`Version ${v0 + 1} is stored now`).waitFor({ timeout: 15_000 });
    await sleep(600);
    const drawerText = (await drawer.innerText()).replace(/\s+/g, " ");
    results.check("the History drawer shows the version, c:saket, and old → new values", drawerText.includes(`Version ${v0 + 1}`) && drawerText.includes("c:saket") && drawerText.includes(title) && drawerText.includes(String(c0.copy.title)) && drawerText.includes(support), drawerText.slice(0, 300));
    await shot(env, page, "dvb-b-02-history");
    await drawer.getByRole("button", { name: "Every change" }).click();
    await sleep(500);
    const everything = (await drawer.innerText()).replace(/\s+/g, " ");
    results.check("\"Every change\" reaches back to how the setup began (seeded as a stand-in app)", /Seeded as a stand-in app|Created/.test(everything), everything.slice(-200));
    await page.keyboard.press("Escape");
    await drawer.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);

    // A visitor sees the new setup at once: title, subtitle, Phone first, the support address, Powered by.
    const visitor = await newContext(browser);
    const hosted = await visitor.newPage();
    results.watch(hosted, "dvb-b-visitor");
    await hosted.goto(`${env.apps}/${APP}/?only=hosted`);
    await hosted.locator("#signin-hosted").click();
    await hosted.getByRole("heading", { level: 1, name: title }).waitFor({ timeout: 30_000 }).catch(() => undefined);
    await sleep(700);
    const look = await readHostedLook(hosted);
    const segments = await hosted.getByRole("group", { name: "Sign in with" }).getByRole("button").allInnerTexts().catch(() => [] as string[]);
    results.check("the hosted page shows the saved title and subtitle", look.headingText === title && (await hosted.getByText(subtitle).count()) > 0, look.headingText);
    results.check("the hosted page offers Phone first, then Email", segments.join(",") === "Phone,Email" && (await hosted.getByRole("textbox", { name: "Phone number" }).count()) + (await hosted.locator("input[type='tel']").count()) > 0, segments.join(","));
    results.check("the hosted page links the saved support address", look.supportEmail === support, String(look.supportEmail));
    await checkPoweredBy(ctx, hosted, "spacestation's hosted page after the edit", { outsideBranding: true });
    await shot(env, hosted, "dvb-b-03-hosted-after-edit");
    await visitor.close();

    // Undo the version from the history: the draft goes back to every earlier value, and saving makes it the next version.
    await page.getByRole("complementary", { name: "On this page" }).getByRole("button", { name: "History" }).click();
    await drawer.getByRole("button", { name: `Undo version ${v0 + 1} in your draft` }).click();
    await drawer.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
    await sleep(400);
    results.check("Undo in draft puts the earlier title back without saving", (await page.getByRole("textbox", { name: "Title", exact: true }).inputValue()) === (c0.copy.title ?? "") && /unsaved change/.test(await saveBar.innerText().catch(() => "")));
    await saveBar.getByRole("button", { name: "Save changes" }).click();
    await saveBar.getByText(`Saved as version ${v0 + 2}`).waitFor({ timeout: 20_000 }).catch(() => undefined);
    const undone = (await asSession<AppDetail>(page, env, "GET", `/v1/apps/${APP}`)).body;
    const u = undone.signin_config;
    results.check(`saving the undo stores version ${v0 + 2} with the setup as it was before`, undone.config_version === v0 + 2 && JSON.stringify(u.method_order) === JSON.stringify(c0.method_order) && u.methods.phone === c0.methods.phone && u.copy.title === c0.copy.title && JSON.stringify(u.redirect_uris) === JSON.stringify(c0.redirect_uris) && JSON.stringify(u.allowed_origins) === JSON.stringify(c0.allowed_origins) && u.remember_browser === c0.remember_browser && JSON.stringify(u.required_fields) === JSON.stringify(c0.required_fields), JSON.stringify({ v: undone.config_version, order: u.method_order, title: u.copy.title }));

    // Refused in the browser before any request: a title past 80 characters, and no method left on.
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("T".repeat(81));
    await sleep(300);
    results.check("an 81-character title blocks saving, and the field counts it (81 of 80)", /1 problem blocks saving/.test(await saveBar.innerText().catch(() => "")) && (await page.getByText("81 of 80 characters").count()) > 0, await saveBar.innerText().catch(() => ""));
    await saveBar.getByRole("button", { name: "Discard" }).click();
    for (const method of ["Email", "Google", "Apple", "Phone"]) {
      const toggle = page.getByRole("switch", { name: method, exact: true });
      if ((await toggle.getAttribute("aria-checked")) === "true") await toggle.click();
    }
    await sleep(300);
    const noMethods = (await saveBar.innerText().catch(() => "")).replace(/\s+/g, " ");
    await saveBar.getByRole("button", { name: "Save changes" }).click().catch(() => undefined);
    await sleep(500);
    const alertText = (await page.getByText("Some settings need fixing").count()) > 0;
    results.check("turning every method off blocks saving with the reason", /problem/.test(noMethods) && alertText && (await page.getByText(`Stored version ${v0 + 2}`).count()) > 0, noMethods);
    await saveBar.getByRole("button", { name: "Discard" }).click();

    // The same rules on the server, with the field path and the reason.
    const long = await asSession<{ error?: { code?: string; details?: { fields?: Record<string, string> } } }>(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { copy: { title: "T".repeat(81) } });
    results.check("PATCH with an 81-character title answers 422 copy.title \"must be at most 80 characters\"", long.status === 422 && long.body.error?.details?.fields?.["copy.title"] === "must be at most 80 characters", JSON.stringify(long.body).slice(0, 200));
    const off = await asSession<{ error?: { details?: { fields?: Record<string, string> } } }>(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { methods: { email: false, phone: false, google: false, apple: false } });
    results.check("PATCH turning every method off answers 422 on methods", off.status === 422 && /at least one sign-in method/.test(off.body.error?.details?.fields?.methods ?? ""), JSON.stringify(off.body).slice(0, 200));
    const unknown = await asSession<{ error?: { details?: { fields?: Record<string, string> } } }>(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { copy: { titel: "typo" } });
    results.check("PATCH with an unknown field names it and the allowed ones", unknown.status === 422 && /unknown field; allowed fields here are/.test(unknown.body.error?.details?.fields?.["copy.titel"] ?? ""), JSON.stringify(unknown.body).slice(0, 220));
    const stale = await asSession<{ error?: { code?: string; details?: { current_version?: number } } }>(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { expected_version: v0, copy: { subtitle: `stale ${t}` } });
    results.check("PATCH against an old expected_version answers 409 config_version_conflict with the current version", stale.status === 409 && stale.body.error?.code === "config_version_conflict" && stale.body.error.details?.current_version === v0 + 2, JSON.stringify(stale.body).slice(0, 220));
    const unchanged = (await asSession<AppDetail>(page, env, "GET", `/v1/apps/${APP}`)).body;
    results.check("none of the refused PATCHes made a version", unchanged.config_version === v0 + 2, String(unchanged.config_version));

    // One Idempotency-Key, one version: the retry gets the stored answer; the same key with another body is refused.
    const key = randomUUID();
    const send = (body: unknown) => page.request.fetch(`${env.site}/v1/apps/${APP}/signin-config`, { method: "PATCH", headers: { origin: env.site, "content-type": "application/json", "idempotency-key": key }, data: JSON.stringify(body), failOnStatusCode: false });
    const first = await send({ copy: { subtitle: `idempotent ${t}` } });
    const retry = await send({ copy: { subtitle: `idempotent ${t}` } });
    const other = await send({ copy: { subtitle: `other ${t}` } });
    const firstBody = (await first.json()) as AppDetail;
    const retryBody = (await retry.json()) as AppDetail;
    const otherBody = (await other.json().catch(() => null)) as { error?: { code?: string } } | null;
    results.check("a retried PATCH with the same Idempotency-Key replays the answer (Idempotent-Replayed) and makes no second version", first.status() === 200 && retry.status() === 200 && retry.headers()["idempotent-replayed"] === "true" && retryBody.config_version === firstBody.config_version && firstBody.config_version === v0 + 3, `${first.status()} v${firstBody.config_version} / ${retry.status()} v${retryBody.config_version} replayed=${retry.headers()["idempotent-replayed"]}`);
    results.check("the same Idempotency-Key with another body answers 409 idempotency_key_reused", other.status() === 409 && otherBody?.error?.code === "idempotency_key_reused", `${other.status()} ${otherBody?.error?.code}`);
    // Texts are shown as text: markup in the title or subtitle never becomes markup on the hosted page.
    const markupTitle = `<img src=x onerror="window.__dvbXss=1">${t}`;
    const markupSubtitle = `<script>window.__dvbXss=2</script><b>bold ${t}</b>`;
    const markup = await asSession(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { copy: { title: markupTitle, subtitle: markupSubtitle } });
    const probe = await newContext(browser);
    const probePage = await probe.newPage();
    results.watch(probePage, "dvb-b-markup");
    await probePage.goto(`${env.apps}/${APP}/?only=hosted`);
    await probePage.locator("#signin-hosted").click();
    await probePage.locator("main[data-fonts='ready'] h1").first().waitFor({ timeout: 30_000 });
    await sleep(800);
    const rendered = await probePage.evaluate(() => {
      const h1 = document.querySelector("main h1");
      return { title: h1?.textContent ?? "", imgInTitle: !!h1?.querySelector("img"), bold: !!document.querySelector("main b"), xss: (window as unknown as { __dvbXss?: number }).__dvbXss ?? null };
    });
    results.check("markup in the title and subtitle is shown as plain text: no element is created and no script runs", markup.status === 200 && rendered.title === markupTitle && !rendered.imgInTitle && !rendered.bold && rendered.xss === null && (await probePage.getByText(markupSubtitle).count()) > 0, JSON.stringify(rendered));
    await shot(env, probePage, "dvb-b-04-markup-as-text");
    await probe.close();

    // Links on the hosted page are https only: the server refuses anything else for the texts' links.
    const badLinks = await asSession<{ error?: { details?: { fields?: Record<string, string> } } }>(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { copy: { terms_url: "javascript:alert(1)", privacy_url: "http://insecure.example/privacy" } });
    const linkFields = badLinks.body.error?.details?.fields ?? {};
    results.check("javascript: and plain http links for terms and privacy are refused (422, per field)", badLinks.status === 422 && !!linkFields["copy.terms_url"] && !!linkFields["copy.privacy_url"], JSON.stringify(linkFields));

    // The texts back to what they were (the next run starts from the seeded setup again).
    await asSession(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { copy: { title: c0.copy.title, subtitle: c0.copy.subtitle } });
    await owner.context.close();
  },
};
