import type { Ctx, Journey } from "../context";
import { json, newContext, shot, sleep, tag } from "../lib";

interface InboxEvent {
  event_id: string;
  type: string;
  payload: unknown;
}

interface Inbox {
  items?: InboxEvent[];
  rejected?: unknown[];
}

const inbox = async (ctx: Ctx, app: string) => (await json<Inbox>(`${ctx.env.apps}/${app}/_events?include_rejected=1`)).body;

/** Waits for a new event of `type` (not among `seen`) that the fake app accepted (its signature verified). */
async function waitFor(ctx: Ctx, app: string, type: string, seen: Set<string>, match: (event: InboxEvent) => boolean = () => true): Promise<InboxEvent | null> {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const found = (await inbox(ctx, app)).items?.find(event => !seen.has(event.event_id) && event.type === type && match(event));
    if (found) return found;
    await sleep(300);
  }
  return null;
}

export const journey: Journey = {
  name: "g-webhooks",
  title: "changes on the account site reach the fake apps' webhooks with valid signatures: an id change, a profile change, an app's access removed",
  needs: ["brook"],
  async run(ctx) {
    const { env, results, browser, shared } = ctx;
    const brook = shared.brook!;
    const context = await newContext(browser, { cookies: brook.cookies });
    const page = await context.newPage();
    results.watch(page, "g");
    const before = { briefcase: await inbox(ctx, "briefcase"), dm: await inbox(ctx, "dm") };
    const seen = (app: "briefcase" | "dm") => new Set((before[app].items ?? []).map(event => event.event_id));
    const t = tag();

    // An id change on the identity card.
    const newId = `brook-renamed-${t}`;
    await page.goto(`${env.site}/`);
    await page.getByRole("button", { name: "Change id" }).click({ timeout: 30_000 });
    const field = page.getByRole("textbox", { name: "New id" });
    await field.fill(newId);
    await sleep(900);
    await shot(env, page, "g-01-change-id");
    const started = Date.now();
    await page.getByRole("button", { name: "Change id", exact: true }).last().click();
    const changedB = await waitFor(ctx, "briefcase", "account.id_changed", seen("briefcase"));
    const changedD = await waitFor(ctx, "dm", "account.id_changed", seen("dm"));
    results.check("account.id_changed reached briefcase, signature verified", !!changedB && JSON.stringify(changedB.payload).includes(`c:${newId}`), `${Date.now() - started} ms`);
    results.check("account.id_changed reached dm, signature verified", !!changedD);

    // A display name change.
    const name = `Brook Webhook ${t}`;
    await page.getByRole("button", { name: /^Display name:/ }).click();
    await page.getByRole("textbox", { name: "Display name" }).fill(name);
    await page.keyboard.press("Enter");
    results.check("account.updated (display name) reached briefcase", !!(await waitFor(ctx, "briefcase", "account.updated", seen("briefcase"), event => JSON.stringify(event.payload).includes(name))));
    results.check("account.updated (display name) reached dm", !!(await waitFor(ctx, "dm", "account.updated", seen("dm"), event => JSON.stringify(event.payload).includes(name))));

    // Removing dm's access on /apps. The card is the one whose heading is exactly "DM": a text filter
    // (`hasText: "DM"`) matches case-insensitively anywhere in a card, and Briefcase's card shows Brook's id, which
    // ends in a random tag. A tag like "n6dm2c" made Briefcase's card match first, so Briefcase lost its access and
    // dm never heard of it.
    await page.goto(`${env.site}/apps`);
    const card = page.getByRole("list", { name: "Apps with access" }).getByRole("listitem").filter({ has: page.getByRole("heading", { name: "DM", exact: true }) });
    await card.waitFor({ timeout: 30_000 });
    await card.getByRole("button", { name: "Remove access" }).click();
    await card.getByRole("button", { name: "Remove", exact: true }).click({ timeout: 10_000 });
    results.check("membership.access_removed reached dm, signature verified", !!(await waitFor(ctx, "dm", "membership.access_removed", seen("dm"))));
    const mine = (await (await page.request.get(`${env.site}/v1/me/apps?limit=200`)).json()) as { items: Array<{ app: { app_id: string }; status: string }> };
    const status = (app: string) => mine.items.find(item => item.app.app_id === app)?.status ?? "missing";
    results.check("only dm lost its access: briefcase still has it", status("dm") === "access_removed" && status("briefcase") === "active", `dm ${status("dm")}, briefcase ${status("briefcase")}`);
    await sleep(1200);
    await shot(env, page, "g-02-access-removed");

    const after = { briefcase: await inbox(ctx, "briefcase"), dm: await inbox(ctx, "dm") };
    const refused = (after.briefcase.rejected?.length ?? 0) - (before.briefcase.rejected?.length ?? 0) + (after.dm.rejected?.length ?? 0) - (before.dm.rejected?.length ?? 0);
    results.check("no delivery was refused by the fake apps' signature check", refused === 0, String(refused));
    // The Carbon's display name and id live on in later journeys' hand-over.
    shared.brook = { ...brook, id: `c:${newId}`, cookies: await context.cookies() };
    await context.close();
  },
};
