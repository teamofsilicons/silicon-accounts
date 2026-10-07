/**
 * The 4.5:1 text contrast rule on branding (campus-connect, its owner signs in): the editor rates each palette live,
 * names the pair that is too low and refuses to save it; the fix saves and reaches the hosted page. The server applies
 * the same rule at the exact boundary (4.5:1 passes, just below is refused with the measured ratio, the pair and the
 * reason, for button text and page text, light and dark), refuses colours that are not #RRGGBB, and never lets a
 * refused palette reach the public config. Error text the server does not check (danger) is kept readable on the
 * hosted page by moving it toward the text colour, exactly as far as needed.
 */
import type { Journey } from "../../context";
import { json, newContext, shot, sleep } from "../../lib";
import { asSession, contrast, fakeApp, ownerSignIn, readHostedLook, rgb } from "./_helpers";

const APP = "campus-connect";

interface Palette {
  primary: string;
  primary_foreground: string;
  background: string;
  surface: string;
  foreground: string;
  muted: string;
  border: string;
  danger: string;
}

interface Detail {
  config_version: number;
  signin_config: { branding: { light: Palette; dark: Palette } };
}

/** The UI's ratio text: two decimals, never rounded up past the threshold. */
const ratioText = (ratio: number) => `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;

/** A grey #gggggg whose contrast against `against` is just below 4.5 (and the next grey, just above). */
function boundaryGreys(against: string, darker: boolean): { below: string; above: string } {
  const hex = (value: number) => `#${value.toString(16).padStart(2, "0").repeat(3).toUpperCase()}`;
  for (let value = 0; value < 255; value++) {
    const a = hex(darker ? 255 - value : value);
    const b = hex(darker ? 255 - value - 1 : value + 1);
    if (contrast(a, against) < 4.5 && contrast(b, against) >= 4.5) return { below: a, above: b };
  }
  throw new Error(`no boundary grey against ${against}`);
}

/** What flow/legible.ts makes of a danger colour that reads below 4.5:1 on the card or the page. */
function legibleDanger(palette: Palette): string {
  const readable = (colour: string) => Math.min(contrast(colour, palette.surface), contrast(colour, palette.background)) >= 4.5;
  if (readable(palette.danger)) return palette.danger;
  const channels = (value: string) => [1, 3, 5].map(index => Number.parseInt(value.slice(index, index + 2), 16));
  for (let percent = 5; percent <= 100; percent += 5) {
    const [a, b] = [channels(palette.danger), channels(palette.foreground)];
    const mixed = `#${a.map((value, index) => Math.round(value + ((b[index] ?? value) - value) * (percent / 100)).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    if (readable(mixed)) return mixed;
  }
  return palette.danger;
}

export const journey: Journey = {
  name: "developer-branding-contrast",
  title: "4.5:1 contrast: the editor rates, names and blocks a low pair, the fix saves and reaches the hosted page; the API boundary (4.5 passes, just below refused with ratio, pair and reason) in both themes; bad hex refused; danger kept legible",
  async run(ctx) {
    const { env, results, browser } = ctx;
    const owner = await ownerSignIn(ctx, APP, "dvb-e-owner", { expected: [/status of 422/] });
    const { page } = owner;
    const saveBar = page.getByRole("region", { name: "Unsaved changes" });
    const start = (await asSession<Detail>(page, env, "GET", `/v1/apps/${APP}`)).body;
    const v0 = start.config_version;
    const light0 = start.signin_config.branding.light;
    const dark0 = start.signin_config.branding.dark;

    await page.goto(`${env.site}/developer/${APP}/branding`);
    await page.getByText(`Stored version ${v0}`).waitFor({ timeout: 20_000 });
    await page.getByRole("group", { name: "Palette", exact: true }).getByRole("button", { name: "Light palette", exact: true }).click();
    const setColour = async (button: RegExp, label: string, hex: string) => {
      await page.getByRole("button", { name: button }).first().click();
      const panel = page.getByRole("dialog", { name: `${label} color` });
      await panel.locator("input").first().fill(hex);
      await panel.locator("input").first().press("Enter");
      await panel.getByRole("button", { name: "Done" }).click();
      await sleep(250);
    };

    // A pale primary under light button text: rated live, named, and refused.
    const pale = "#9AB8F0";
    const low = contrast(light0.primary_foreground, pale);
    await setColour(/^Primary #/, "Primary", pale);
    const buttonRow = page.getByRole("row", { name: /Button text on primary/ });
    const lightCell = (await buttonRow.getByRole("cell").first().innerText()).replace(/\s+/g, " ");
    results.check(`the editor rates the pale primary at ${ratioText(low)} and marks it "Too low" in the light column`, lightCell.includes(ratioText(low)) && /Too low/.test(lightCell), lightCell);
    const blocked = (await saveBar.innerText().catch(() => "")).replace(/\s+/g, " ");
    results.check("the save bar says a problem blocks saving", /1 problem blocks saving/.test(blocked), blocked);
    await saveBar.getByRole("button", { name: "Save changes" }).click();
    const alert = page.getByText("Some settings need fixing");
    await alert.waitFor({ timeout: 10_000 }).catch(() => undefined);
    const alertText = (await page.getByRole("tabpanel").innerText()).replace(/\s+/g, " ");
    results.check("Save names the problem (button text on primary, below 4.5:1) and stores nothing", (await alert.count()) > 0 && /4\.5:1/.test(alertText) && (await page.getByText(`Stored version ${v0}`).count()) > 0, alertText.slice(0, 300));
    await shot(env, page, "dvb-e-01-too-low", true);
    const unchanged = (await asSession<Detail>(page, env, "GET", `/v1/apps/${APP}`)).body;
    results.check("the refused palette never left the browser (same version, same primary)", unchanged.config_version === v0 && unchanged.signin_config.branding.light.primary === light0.primary);

    // Dark button text on the pale primary fixes it: rated AA or better, saved, and on the hosted page.
    const ink = "#0B1B3A";
    await setColour(/^Text on primary #/, "Text on primary", ink);
    const fixedCell = (await buttonRow.getByRole("cell").first().innerText()).replace(/\s+/g, " ");
    results.check(`with dark button text the pair reads ${ratioText(contrast(ink, pale))} and passes`, fixedCell.includes(ratioText(contrast(ink, pale))) && /AA/.test(fixedCell) && !/Too low/.test(fixedCell), fixedCell);
    await saveBar.getByRole("button", { name: "Save changes" }).click();
    await saveBar.getByText(`Saved as version ${v0 + 1}`).waitFor({ timeout: 20_000 }).catch(() => undefined);
    const fixed = (await asSession<Detail>(page, env, "GET", `/v1/apps/${APP}`)).body;
    results.check(`the fixed palette saves as version ${v0 + 1}`, fixed.config_version === v0 + 1 && fixed.signin_config.branding.light.primary === pale && fixed.signin_config.branding.light.primary_foreground === ink);
    const visitor = await newContext(browser);
    const hosted = await visitor.newPage();
    results.watch(hosted, "dvb-e-visitor");
    await hosted.goto(`${env.apps}/${APP}/?only=hosted`);
    await hosted.locator("#signin-hosted").click();
    await hosted.locator("main[data-fonts='ready'] h1").first().waitFor({ timeout: 30_000 });
    await sleep(800);
    const look = await readHostedLook(hosted);
    results.check("the hosted page's main button is the pale primary with the dark text", look.primary?.background === rgb(pale) && look.primary?.color === rgb(ink), JSON.stringify(look.primary));
    await shot(env, hosted, "dvb-e-02-hosted-fixed");

    // Dark palette: page text too close to the page background is caught the same way.
    await page.getByRole("group", { name: "Palette", exact: true }).getByRole("button", { name: "Dark palette", exact: true }).click();
    const murky = "#4A4A4A";
    await setColour(/^Text #/, "Text", murky);
    const pageRow = page.getByRole("row", { name: /Text on the page background/ });
    const darkCell = (await pageRow.getByRole("cell").nth(1).innerText()).replace(/\s+/g, " ");
    results.check(`dark page text ${murky} on ${dark0.background} rates ${ratioText(contrast(murky, dark0.background))}, "Too low" in the dark column`, darkCell.includes(ratioText(contrast(murky, dark0.background))) && /Too low/.test(darkCell) && /problem blocks saving/.test(await saveBar.innerText().catch(() => "")), darkCell);
    await saveBar.getByRole("button", { name: "Discard" }).click();

    // The server's rule, at the boundary: 4.5:1 passes, the grey just below is refused with ratio, pair and reason.
    const light = boundaryGreys("#FFFFFF", true);
    const refusedLight = await asSession<{ error?: { details?: { fields?: Record<string, string> } } }>(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { branding: { light: { primary: light.below, primary_foreground: "#FFFFFF" } } });
    const message = refusedLight.body.error?.details?.fields?.["branding.light.primary_foreground"] ?? "";
    results.check(`button text #FFFFFF on ${light.below} (${contrast("#FFFFFF", light.below).toFixed(3)}:1) is refused with the measured ratio, the pair and why`, refusedLight.status === 422 && message.includes(ratioText(contrast("#FFFFFF", light.below))) && message.includes(`branding.light.primary (${light.below})`) && /at least 4\.5:1/.test(message) && /button text must stay readable/.test(message), `${refusedLight.status} ${message}`);
    const acceptedLight = await asSession<Detail>(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { branding: { light: { primary: light.above, primary_foreground: "#FFFFFF" } } });
    results.check(`button text #FFFFFF on ${light.above} (${contrast("#FFFFFF", light.above).toFixed(3)}:1) is accepted`, acceptedLight.status === 200 && acceptedLight.body.config_version === v0 + 2, `${acceptedLight.status} v${acceptedLight.body.config_version}`);
    const dark = boundaryGreys("#000000", false);
    const refusedDark = await asSession<{ error?: { details?: { fields?: Record<string, string> } } }>(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { branding: { dark: { background: "#000000", foreground: dark.below } } });
    const darkMessage = refusedDark.body.error?.details?.fields?.["branding.dark.foreground"] ?? "";
    results.check(`dark page text ${dark.below} on #000000 (${contrast(dark.below, "#000000").toFixed(3)}:1) is refused: "page text must stay readable"`, refusedDark.status === 422 && darkMessage.includes(ratioText(contrast(dark.below, "#000000"))) && /page text must stay readable/.test(darkMessage), `${refusedDark.status} ${darkMessage}`);
    const acceptedDark = await asSession<Detail>(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { branding: { dark: { background: "#000000", foreground: dark.above } } });
    results.check(`dark page text ${dark.above} on #000000 (${contrast(dark.above, "#000000").toFixed(3)}:1) is accepted`, acceptedDark.status === 200 && acceptedDark.body.config_version === v0 + 3);
    const badHex = await asSession<{ error?: { details?: { fields?: Record<string, string> } } }>(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { branding: { light: { primary: "#12345", surface: "white" } } });
    const fields = badHex.body.error?.details?.fields ?? {};
    results.check("colours that are not #RRGGBB are refused per field", badHex.status === 422 && /must be a #RRGGBB colour/.test(fields["branding.light.primary"] ?? "") && /must be a #RRGGBB colour/.test(fields["branding.light.surface"] ?? ""), JSON.stringify(fields));
    const publicLight = (await json<{ branding: { light: Palette; dark: Palette } }>(`${env.site}/v1/apps/${APP}/public`)).body.branding;
    results.check("the public config only ever carries accepted palettes", publicLight.light.primary === light.above && publicLight.dark.foreground === dark.above, `${publicLight.light.primary} ${publicLight.dark.foreground}`);

    // Danger is not checked by the server; the hosted page moves a pale one toward the text colour until it reads.
    const paleDanger = "#FFB3B3";
    await asSession(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { branding: { theme: "light", light: { primary: light0.primary, primary_foreground: light0.primary_foreground, danger: paleDanger } } });
    const palette = (await asSession<Detail>(page, env, "GET", `/v1/apps/${APP}`)).body.signin_config.branding.light;
    const wanted = legibleDanger(palette);
    await hosted.goto(`${env.apps}/${APP}/?only=hosted`);
    await hosted.locator("#signin-hosted").click();
    await hosted.locator("main[data-fonts='ready'] h1").first().waitFor({ timeout: 30_000 });
    await hosted.getByRole("textbox", { name: "Email" }).fill("nope");
    await hosted.getByRole("button", { name: "Continue", exact: true }).click();
    // The field's error (role=alert; an animated aria-hidden copy of the words sits beside it).
    const error = hosted.locator("main [role='alert']").filter({ hasText: "Enter a full email address" }).first();
    await error.waitFor({ timeout: 10_000 }).catch(() => undefined);
    const shown = await error.evaluate(el => getComputedStyle(el).color).catch(() => "none");
    results.check(`a pale error colour (${paleDanger}, ${contrast(paleDanger, palette.surface).toFixed(2)}:1 on the card) is shown as ${wanted}, readable at 4.5:1`, shown === rgb(wanted) && contrast(wanted, palette.surface) >= 4.5 && wanted !== paleDanger, `${shown} (wanted ${rgb(wanted)})`);
    await shot(env, hosted, "dvb-e-03-legible-danger");
    await visitor.close();

    // Image URLs in a branding are https or inline images only (nothing a page could run or fetch insecurely).
    const urls = await asSession<{ error?: { details?: { fields?: Record<string, string> } } }>(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { branding: { logo_url: "javascript:alert(1)", logo_dark_url: "http://insecure.example/logo.png", background_style: "image", background_image_url: "data:text/html,<script>alert(1)</script>" } });
    const urlFields = urls.body.error?.details?.fields ?? {};
    results.check("javascript:, plain http and non-image data: URLs for logos and the background image are refused per field", urls.status === 422 && !!urlFields["branding.logo_url"] && !!urlFields["branding.logo_dark_url"] && !!urlFields["branding.background_image_url"], JSON.stringify(urlFields).slice(0, 300));
    const bigLogo = `data:image/svg+xml;base64,${Buffer.alloc(140 * 1024, 65).toString("base64")}`;
    const tooBig = await asSession<{ error?: { details?: { fields?: Record<string, string> } } }>(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { branding: { logo_url: bigLogo } });
    results.check("an inline logo over 128 KB is refused with the limit", tooBig.status === 422 && /128/.test(tooBig.body.error?.details?.fields?.["branding.logo_url"] ?? ""), `${tooBig.status} ${JSON.stringify(tooBig.body).slice(0, 200)}`);

    // campus-connect's seeded look again.
    await asSession(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { branding: null });
    const restored = await asSession(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { branding: fakeApp(APP).signin_defaults?.branding });
    results.check("campus-connect's seeded branding is back", restored.status === 200);
    await owner.context.close();
  },
};
