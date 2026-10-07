/**
 * ux-audit: /device, where a Carbon approves a terminal's sign-in (`accounts login`), in light and dark at 1440 and
 * 390 px: entering a code, reviewing a request, approved, denied, an unknown code and an expired one. Requests are made
 * the way the CLI makes them (POST /v1/device/authorize); the Carbon is new.
 */
import type { Journey } from "../../context";
import { api, sql } from "../../lib";
import { VARIANTS, auditVariants, collectConsole, findingsFor, saveFindings, signedInCarbon, stepReady } from "./_audit";

interface DeviceAuthorization {
  user_code?: string;
  device_code?: string;
  verification_uri_complete?: string;
}

export const journeys: Journey[] = [
  {
    name: "ux-audit-device",
    title: "/device: enter a code, review, approved, denied, unknown and expired codes, light/dark × 1440/390",
    async run(ctx) {
      const { env, results } = ctx;
      const findings = findingsFor(ctx);
      const carbon = await signedInCarbon(ctx, "uxa.device");
      const { page } = carbon;
      // An unknown code is answered 404 on purpose; the browser logs that response itself.
      const expected = [/status of 404 .*\/v1\/device\//];
      results.watch(page, "device", expected);
      collectConsole(page, expected);
      const authorize = (label: string) => api<DeviceAuthorization>(ctx, "/v1/device/authorize", { method: "POST", json: { client_label: label } });

      await page.goto(`${env.site}/device`);
      const field = page.getByRole("textbox", { name: "Code from your terminal" });
      await field.waitFor({ timeout: 30_000 });
      await stepReady(page);
      await auditVariants(ctx, page, findings, "device-enter", VARIANTS);

      // Review, then approve.
      const first = await authorize("ux-audit terminal on a laptop with a fairly long name (zsh)");
      results.check("device: the CLI's request got a code", !!first.body.user_code, `${first.status} ${JSON.stringify(first.body).slice(0, 160)}`);
      await field.fill(first.body.user_code ?? "");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      const approve = page.getByRole("button", { name: "Approve sign-in" });
      await approve.waitFor({ timeout: 30_000 });
      await stepReady(page);
      const review = (await page.locator("main").first().innerText()).replace(/\s+/g, " ");
      results.check("device-review: names the terminal's whole label", review.includes("ux-audit terminal on a laptop with a fairly long name (zsh)"), review.slice(0, 300));
      await auditVariants(ctx, page, findings, "device-review", VARIANTS);
      await approve.click();
      await page.getByRole("heading", { name: "Your terminal is signed in" }).waitFor({ timeout: 30_000 });
      await stepReady(page);
      await auditVariants(ctx, page, findings, "device-approved", VARIANTS);

      // Review, then deny (arriving with the code in the link, as the CLI prints it).
      const second = await authorize("ux-audit second terminal");
      await page.goto(second.body.verification_uri_complete ?? `${env.site}/device`);
      await page.getByRole("button", { name: "Deny" }).click({ timeout: 30_000 });
      await page.getByRole("heading", { name: "Sign-in denied" }).waitFor({ timeout: 30_000 });
      await stepReady(page);
      await auditVariants(ctx, page, findings, "device-denied", VARIANTS);

      // An unknown code.
      await page.goto(`${env.site}/device?code=ZZZZ-ZZZZ`);
      await page.getByRole("heading", { name: /No sign-in uses/ }).waitFor({ timeout: 30_000 });
      await stepReady(page);
      await auditVariants(ctx, page, findings, "device-unknown", VARIANTS, { expectedConsole: expected });

      // An expired code (its 10 minutes moved into the past in this stack's database).
      const third = await authorize("ux-audit third terminal");
      await sql(env, `update device_authorizations set expires_at = now() - interval '1 second' where upper(replace(user_code, '-', '')) = upper(replace('${(third.body.user_code ?? "").replace(/'/g, "")}', '-', ''))`).catch(error => results.check("device: moved the code's expiry into the past", false, String(error)));
      await page.goto(third.body.verification_uri_complete ?? `${env.site}/device`);
      await page.getByRole("heading", { name: "This code expired" }).waitFor({ timeout: 30_000 }).catch(() => undefined);
      await stepReady(page);
      results.check("device-expired: says the code expired", await page.getByRole("heading", { name: "This code expired" }).isVisible().catch(() => false), (await page.locator("main").first().innerText().catch(() => "")).slice(0, 200));
      await auditVariants(ctx, page, findings, "device-expired", VARIANTS, { expectedConsole: [/status of 4\d\d .*\/v1\/device\//] });
      results.check("device: findings saved", true, saveFindings(ctx, findings));
      await carbon.context.close();
    },
  },
];
