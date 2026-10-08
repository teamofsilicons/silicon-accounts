/**
 * ux-audit: the signed-out surfaces of the account site in light and dark at 1440 and 390 px: the landing page (and
 * its link to the developer site, GET /v1/meta developer_url), every step of the site's own sign-in (email, code, a
 * wrong code, setting up), the not-found page, a hosted link that cannot start, and the old /developer addresses, which
 * now lead to the developer site (UNDERSTANDING.md v2: "Anything about building apps lives on developers.teamofsilicons.com").
 * Each page: theme, no sideways scroll, axe, squircles, console, broken images, vocabulary, screenshots.
 */
import type { Journey } from "../../context";
import { codeFor, json, lastSeq } from "../../lib";
import { POWERED_HREF, VARIANTS, auditContext, auditVariants, collectConsole, findingsFor, freshEmail, poweredBy, saveFindings, settle, stepReady } from "./_audit";

export const journeys: Journey[] = [
  {
    name: "ux-audit-landing",
    title: "the landing page (and its developer-site link), the site's own sign-in (email, code, wrong code, setting up), not-found, a broken hosted link and /developer leading to the developer site: light/dark × 1440/390",
    timeoutMs: 900_000,
    async run(ctx) {
      const { env, results, browser } = ctx;
      const findings = findingsFor(ctx);
      const context = await auditContext(browser);
      const page = await context.newPage();
      // Asked for on purpose: the 404 of /no-such-page, the 422 of a wrong code and the 400 of a link that cannot start.
      const expected = [/status of 404 .*\/no-such-page/, /status of 422 .*\/v1\/flows\/[^/ ]+\/verify/, /status of 400 .*\/v1\/flows\b/];
      results.watch(page, "landing", expected);
      collectConsole(page, expected);
      const meta = await json<{ developer_url?: string }>(`${env.site}/v1/meta`);
      results.check("meta: GET /v1/meta names this stack's developer site (developer_url)", meta.body.developer_url?.replace(/\/+$/, "") === env.developer, String(meta.body.developer_url));

      // The landing page (signed out).
      await page.goto(`${env.site}/`);
      await settle(page, 600);
      await auditVariants(ctx, page, findings, "landing", VARIANTS, { fullPage: true });
      const signIn = page.getByRole("link", { name: /sign in/i }).first();
      results.check("landing: offers a way to sign in", (await signIn.count()) > 0);
      const developerLinks = await page.locator("a[href]").evaluateAll((links, developer) => links.filter(link => (link as HTMLAnchorElement).href.replace(/\/+$/, "") === developer).map(link => (link.textContent ?? "").replace(/\s+/g, " ").trim()), env.developer);
      results.check("landing: links to the developer site at developer_url (building apps lives there)", developerLinks.length > 0, developerLinks.join(" | ") || "no link to the developer site");

      // The site's own sign-in: the email step.
      await page.goto(`${env.site}/sign-in`);
      await page.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
      await stepReady(page);
      await auditVariants(ctx, page, findings, "signin-email", VARIANTS);
      const powered = await poweredBy(page);
      findings.pages["signin-email powered by"] = powered;
      results.check("signin-email: the account site's own sign-in (Silicon Accounts itself) shows no app, so \"Powered by\" is optional; when shown it links to accounts.teamofsilicons.com", !powered.found || POWERED_HREF.test(powered.href ?? ""), JSON.stringify(powered));

      // The code step, then a wrong code (the error state), then the right one.
      const email = freshEmail("uxa.landing");
      const after = await lastSeq(env);
      await page.getByRole("textbox", { name: "Email" }).fill(email);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const code = await codeFor(env, email, after);
      await page.getByRole("group", { name: /Code from the email/ }).waitFor({ timeout: 20_000 });
      await stepReady(page);
      await auditVariants(ctx, page, findings, "signin-code", VARIANTS);
      const wrong = code === "000000" ? "111111" : "000000";
      const firstDigit = page.getByRole("textbox", { name: /digit 1 of 6/ });
      await firstDigit.click();
      await page.keyboard.type(wrong, { delay: 30 });
      const error = page.locator("main [role=alert]").first();
      await error.waitFor({ timeout: 10_000 }).catch(() => undefined);
      await stepReady(page);
      const alertText = (await error.innerText().catch(() => "")).replace(/\s+/g, " ");
      results.check("signin-code: a wrong code says so in words", /code|try|attempt/i.test(alertText), alertText);
      await auditVariants(ctx, page, findings, "signin-code-wrong", VARIANTS);
      await firstDigit.click();
      await page.keyboard.type(code, { delay: 30 });

      // Setting up the account.
      await page.getByRole("button", { name: "Create account" }).waitFor({ timeout: 30_000 });
      await stepReady(page);
      await auditVariants(ctx, page, findings, "signin-signup", VARIANTS, { fullPage: true });
      await page.getByRole("button", { name: "Create account" }).click();
      await page.waitForURL(`${env.site}/`, { timeout: 30_000 });

      // The old developer addresses: a 307 to the developer site, the app and tab kept (renamed tabs land on theirs).
      for (const [from, to] of [["/developer", "/"], ["/developer/briefcase", "/apps/briefcase"], ["/developer/briefcase/branding?x=1", "/apps/briefcase/branding?x=1"]] as const) {
        const answer = await fetch(`${env.site}${from}`, { redirect: "manual" });
        const location = answer.headers.get("location") ?? "";
        results.check(`${from}: answers 307 to the developer site (${to})`, answer.status === 307 && location.replace(/\/+$/, "") === `${env.developer}${to}`.replace(/\/+$/, ""), `${answer.status} → ${location}`);
      }

      // The not-found page and a hosted link that cannot start.
      const missing = await page.goto(`${env.site}/no-such-page`);
      results.check("not-found: answers 404", missing?.status() === 404, String(missing?.status()));
      await settle(page);
      await auditVariants(ctx, page, findings, "not-found", VARIANTS, { expectedConsole: [/status of 404/] });
      await page.goto(`${env.site}/authorize?client_id=no-such-app&redirect_uri=${encodeURIComponent("https://example.test/callback")}&response_type=code&state=s`);
      await page.locator("main").first().waitFor({ timeout: 20_000 });
      await settle(page, 800);
      const problem = (await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ");
      results.check("authorize problem: says why in plain words and does not redirect", page.url().startsWith(`${env.site}/authorize`) && problem.length > 20, problem.slice(0, 200));
      await auditVariants(ctx, page, findings, "authorize-problem", VARIANTS, { expectedConsole: [/status of 4\d\d/] });

      results.check("findings saved", true, saveFindings(ctx, findings));
      await context.close();
    },
  },
];
