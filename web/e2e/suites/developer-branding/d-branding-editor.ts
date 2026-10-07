/**
 * The branding editor end to end, on ledgerly (its owner signs in): every variable is set through the editor's own
 * controls (theme, all eight colours of the dark palette, both logos by upload, logo height, the app name, both fonts,
 * corners, layout, an image background, button style, density), the live preview follows the draft, Save stores one
 * version (API, public config, history), and the hosted page a visitor opens paints every one of them. The extreme
 * look is then walked through every step with "Powered by" checked and photographed (1440 and 390 px). A second set
 * of values (light, rounded 40, soft, split, dots, Space Grotesk, the app's own logo at 16 px) goes in through the
 * API and is checked the same way; "Use the Silicon Accounts look" brings the defaults back.
 */
import type { BrowserContext, Page } from "@playwright/test";
import type { Ctx, Journey } from "../../context";
import { json, newContext, shot, sleep, tag } from "../../lib";
import { asSession, contrast, fakeApp, ownerSignIn, readHostedLook, rgb, sameColour, walkHosted, type HostedLook } from "./_helpers";

const APP = "ledgerly";

const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">${body}</svg>`);
const LOGO_LIGHT = svg('<rect width="96" height="96" fill="#D7263D"/><text x="48" y="60" font-size="40" text-anchor="middle" fill="#fff">L</text>');
const LOGO_DARK = svg('<circle cx="48" cy="48" r="46" fill="#00FFAA"/><text x="48" y="60" font-size="40" text-anchor="middle" fill="#000">D</text>');
const BACKGROUND = svg('<rect width="96" height="96" fill="#2B0057"/><path d="M0 96 96 0" stroke="#FFE600" stroke-width="8"/>');

const DARK = { primary: "#FFE600", primary_foreground: "#000000", background: "#000000", surface: "#111111", foreground: "#FFFFFF", muted: "#00FFAA", border: "#FF00FF", danger: "#FF5C5C" } as const;
const COLOUR_LABELS: Array<[keyof typeof DARK, string, RegExp]> = [
  ["primary", "Primary", /^Primary #/],
  ["primary_foreground", "Text on primary", /^Text on primary #/],
  ["background", "Page background", /^Page background #/],
  ["surface", "Card", /^Card #/],
  ["foreground", "Text", /^Text #/],
  ["muted", "Muted text", /^Muted text #/],
  ["border", "Borders", /^Borders #/],
  ["danger", "Errors", /^Errors #/],
];

const LIGHT_B = { primary: "#0B3D2E", primary_foreground: "#F5FFFA", background: "#FFF8E7", surface: "#FFFFFF", foreground: "#222222", muted: "#5A4A3A", border: "#C8102E", danger: "#9B1C1C" } as const;

/** A segmented control's option, inside the group named exactly `group` (the inner one when a fieldset shares it). */
async function segment(page: Page, group: string, option: string): Promise<void> {
  await page.getByRole("group", { name: group, exact: true }).last().getByRole("button", { name: option, exact: true }).click();
}

async function setColour(page: Page, label: string, button: RegExp, hex: string): Promise<void> {
  await page.getByRole("button", { name: button }).first().click();
  const panel = page.getByRole("dialog", { name: `${label} color` });
  const input = panel.locator("input").first();
  await input.fill(hex);
  await input.press("Enter");
  await panel.getByRole("button", { name: "Done" }).click();
  await sleep(150);
}

async function upload(page: Page, button: string, name: string, buffer: Buffer): Promise<void> {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: button, exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: "image/svg+xml", buffer });
  await sleep(300);
}

async function routeImages(context: BrowserContext): Promise<void> {
  await context.route("https://img.dvb.example/**", route => route.fulfill({ status: 200, contentType: "image/svg+xml", body: BACKGROUND }));
}

/** Opens ledgerly's hosted page as a fresh visitor and reads what it paints. */
async function visit(ctx: Ctx, label: string, options: { dark?: boolean; width?: number } = {}): Promise<{ look: HostedLook; page: Page; context: BrowserContext }> {
  const context = await newContext(ctx.browser, { dark: options.dark, width: options.width });
  await routeImages(context);
  const page = await context.newPage();
  ctx.results.watch(page, label);
  await page.goto(`${ctx.env.apps}/${APP}/?only=hosted`);
  await page.locator("#signin-hosted").click();
  await page.locator("main[data-fonts='ready'] h1").first().waitFor({ timeout: 30_000 });
  await sleep(900);
  return { look: await readHostedLook(page), page, context };
}

export const journey: Journey = {
  name: "developer-branding-editor",
  title: "branding editor: every variable set through its controls, live preview, one saved version (API, public, history), the hosted page paints each one, extreme look walked step by step at 1440/390; API values and the default look checked the same way",
  timeoutMs: 9 * 60_000,
  async run(ctx) {
    const { env, results } = ctx;
    const t = tag();
    const backgroundUrl = `https://img.dvb.example/bg-${t}.svg`;
    for (const [fg, bg] of [["primary_foreground", "primary"], ["foreground", "background"]] as const) {
      if (contrast(DARK[fg], DARK[bg]) < 4.5) throw new Error(`test data: ${fg}/${bg} is below 4.5:1`);
    }

    const owner = await ownerSignIn(ctx, APP, "dvb-d-owner");
    await routeImages(owner.context);
    const { page } = owner;
    const saveBar = page.getByRole("region", { name: "Unsaved changes" });
    const v0 = (await asSession<{ config_version: number }>(page, env, "GET", `/v1/apps/${APP}`)).body.config_version;
    await page.goto(`${env.site}/developer/${APP}/branding`);
    await page.getByText(`Stored version ${v0}`).waitFor({ timeout: 20_000 });

    // Every variable through its own control.
    const editStarted = Date.now();
    await segment(page, "Theme", "Dark");
    await segment(page, "Palette", "Dark palette");
    for (const [key, label, button] of COLOUR_LABELS) await setColour(page, label, button, DARK[key]);
    await upload(page, "Upload logo", "logo.svg", LOGO_LIGHT);
    await upload(page, "Upload logo on dark", "logo-dark.svg", LOGO_DARK);
    await page.getByRole("slider", { name: "Logo height" }).fill("96");
    await page.getByRole("switch", { name: "Show the app name next to the logo" }).click();
    await page.getByRole("combobox", { name: "Body font" }).click();
    await page.getByRole("option", { name: "JetBrains Mono (mono)" }).click();
    await page.getByRole("combobox", { name: "Heading font" }).click();
    await page.getByRole("option", { name: "Instrument Serif (serif)" }).click();
    await segment(page, "Corners", "Sharp");
    await page.getByRole("radio", { name: /^Minimal/ }).click();
    await segment(page, "Background", "Image");
    await page.getByRole("textbox", { name: "Background image" }).fill(backgroundUrl);
    await segment(page, "Button style", "Outline");
    await segment(page, "Density", "Compact");
    await sleep(500);
    results.metric("branding editor: set every variable through the controls", Date.now() - editStarted);
    const checksRow = (await page.getByRole("table", { name: "Contrast checks" }).innerText()).replace(/\s+/g, " ");
    results.check("the contrast table rates the new dark palette (button text and page text) above 4.5:1", !/Too low/.test(checksRow), checksRow);

    // The live preview paints the draft before anything is saved.
    const preview = page.locator("[role='img'][aria-label^='Preview of the']");
    const previewLabel = (await preview.getAttribute("aria-label")) ?? "";
    const previewScope = await preview.locator(".sa-brand").first().evaluate(el => ({ theme: el.getAttribute("data-theme"), corner: el.getAttribute("data-corner"), layout: el.getAttribute("data-layout"), bg: el.getAttribute("data-bg"), button: el.getAttribute("data-button-style"), density: el.getAttribute("data-density"), primary: getComputedStyle(el).getPropertyValue("--primary").trim(), font: getComputedStyle(el).fontFamily }));
    results.check("the live preview follows the unsaved draft (dark, sharp, minimal, image, outline, compact, the new primary, JetBrains Mono)", /dark theme/.test(previewLabel) && previewScope.theme === "dark" && previewScope.corner === "sharp" && previewScope.layout === "minimal" && previewScope.bg === "image" && previewScope.button === "outline" && previewScope.density === "compact" && previewScope.primary.toUpperCase() === DARK.primary && /JetBrains Mono/.test(previewScope.font), `${previewLabel} ${JSON.stringify(previewScope)}`);
    await shot(env, page, "dvb-d-01-editor-draft", true);

    const saveStarted = Date.now();
    await saveBar.getByRole("button", { name: "Save changes" }).click();
    await saveBar.getByText(`Saved as version ${v0 + 1}`).waitFor({ timeout: 20_000 }).catch(() => undefined);
    results.metric("branding save → \"Saved as version\"", Date.now() - saveStarted);
    results.check(`Save stores the whole look as version ${v0 + 1}`, (await page.getByText(`Stored version ${v0 + 1}`).count()) > 0);

    // Stored exactly: the owner's API, the public config (what embeds and the SDK read), and one history entry.
    const stored = (await asSession<{ config_version: number; signin_config: { branding: Record<string, unknown> & { dark: Record<string, string> } } }>(page, env, "GET", `/v1/apps/${APP}`)).body;
    const b = stored.signin_config.branding;
    const darkOk = Object.entries(DARK).every(([key, value]) => b.dark[key]?.toUpperCase() === value);
    results.check("the API stores every variable as set", stored.config_version === v0 + 1 && b.theme === "dark" && darkOk && String(b.logo_url).startsWith("data:image/svg+xml") && String(b.logo_dark_url).startsWith("data:image/svg+xml") && b.logo_url !== b.logo_dark_url && b.logo_height === 96 && b.show_app_name === false && b.font_family === "JetBrains Mono" && b.heading_font_family === "Instrument Serif" && b.corner_style === "sharp" && b.layout === "minimal" && b.background_style === "image" && b.background_image_url === backgroundUrl && b.button_style === "outline" && b.density === "compact", JSON.stringify({ ...b, logo_url: String(b.logo_url).slice(0, 30), logo_dark_url: String(b.logo_dark_url).slice(0, 30) }).slice(0, 600));
    const publicBranding = (await json<{ branding: Record<string, unknown> }>(`${env.site}/v1/apps/${APP}/public`)).body.branding;
    results.check("the public config (embed, SDK) carries the same branding at once", JSON.stringify(publicBranding) === JSON.stringify(b));
    const history = (await asSession<{ items: Array<{ version: number; actor_account: { id: string } | null; changes: Array<{ path: string }> }> }>(page, env, "GET", `/v1/apps/${APP}/signin-config/history`)).body.items[0];
    const brandingPaths = (history?.changes ?? []).map(change => change.path);
    results.check("one history entry by c:ledgerly-dev holds every branding path that changed", history?.version === v0 + 1 && history.actor_account?.id === "c:ledgerly-dev" && brandingPaths.every(path => path.startsWith("branding.")) && ["branding.theme", "branding.dark.primary", "branding.dark.danger", "branding.logo_url", "branding.logo_dark_url", "branding.font_family", "branding.layout", "branding.background_image_url", "branding.density"].every(path => brandingPaths.includes(path)), brandingPaths.join(", "));
    await page.getByRole("button", { name: "History" }).first().click();
    const drawer = page.getByRole("dialog", { name: "Version history" });
    await drawer.getByText(`Version ${v0 + 1} is stored now`).waitFor({ timeout: 15_000 });
    await sleep(500);
    const drawerText = (await drawer.innerText()).replace(/\s+/g, " ");
    results.check("the History drawer shows uploaded logos as \"an inline image\" (never the data URL)", /an inline image/.test(drawerText) && !/data:image/.test(drawerText), drawerText.slice(0, 200));
    await page.keyboard.press("Escape");

    // The hosted page a visitor opens paints every variable (the visitor prefers light; the app forces dark).
    const first = await visit(ctx, "dvb-d-visitor-extreme");
    const look = first.look;
    const failures: string[] = [];
    const expect = (what: string, ok: boolean, got: unknown) => {
      if (!ok) failures.push(`${what}: ${JSON.stringify(got)}`);
    };
    expect("theme dark (forced over the visitor's light)", look.attrs["data-theme"] === "dark", look.attrs);
    expect("corners sharp", look.attrs["data-corner"] === "sharp" && look.primary?.radius === "0px" && look.input?.radius === "0px", [look.primary?.radius, look.input?.radius]);
    expect("layout minimal", look.attrs["data-layout"] === "minimal" && !look.asideVisible, look.attrs["data-layout"]);
    expect("image background", look.attrs["data-bg"] === "image" && look.backdrop.includes(backgroundUrl), look.backdrop.slice(0, 160));
    expect("outline button: transparent fill, primary ring", look.attrs["data-button-style"] === "outline" && /rgba\(0, 0, 0, 0\)|transparent/.test(look.primary?.background ?? "") && sameColour(look.primary?.border, DARK.primary), look.primary);
    expect("density compact", look.attrs["data-density"] === "compact" && look.vars["--brand-pad"] === "24px" && Math.round(look.input?.height ?? 0) === 40, [look.vars["--brand-pad"], look.input?.height]);
    expect("page background", look.scopeBackground === rgb(DARK.background) && look.bodyBackground === rgb(DARK.background) && look.themeColor?.toUpperCase() === DARK.background, [look.scopeBackground, look.bodyBackground, look.themeColor]);
    expect("text colour", look.headingColor === rgb(DARK.foreground), look.headingColor);
    expect("palette variables (primary, text on primary, card, muted, borders, errors)", look.vars["--primary"]?.toUpperCase() === DARK.primary && look.vars["--primary-foreground"]?.toUpperCase() === DARK.primary_foreground && look.vars["--surface"]?.toUpperCase() === DARK.surface && look.vars["--text-muted"]?.toUpperCase() === DARK.muted && look.vars["--border"]?.toUpperCase() === DARK.border, look.vars);
    expect("body font JetBrains Mono", /JetBrains Mono/.test(look.bodyFont), look.bodyFont);
    expect("heading font Instrument Serif", /Instrument Serif/.test(look.headingFont), look.headingFont);
    expect("the dark logo, 96 px tall", !!look.logo && look.logo.src === b.logo_dark_url && Math.round(look.logo.height) === 96, look.logo && { src: look.logo.src.slice(0, 40), height: look.logo.height });
    expect("no app name next to the logo", look.appName === null, look.appName);
    results.check("the hosted page paints every saved variable", failures.length === 0, failures.join(" | ") || "theme, corners, layout, background image, outline, compact, colours, fonts, logo, name");
    // Errors in the app's danger colour (legible on its card, so unchanged).
    await first.page.getByRole("textbox", { name: "Email" }).fill("not-an-email");
    await first.page.getByRole("button", { name: "Continue", exact: true }).click();
    // The field's error (role=alert; an animated aria-hidden copy of the words sits beside it).
    const error = first.page.locator("main [role='alert']").filter({ hasText: "Enter a full email address" }).first();
    await error.waitFor({ timeout: 10_000 }).catch(() => undefined);
    const errorColour = await error.evaluate(el => getComputedStyle(el).color).catch(() => "none");
    results.check("an error on the hosted page uses the app's error colour", errorColour === rgb(DARK.danger), `${errorColour} (wanted ${rgb(DARK.danger)})`);
    await shot(env, first.page, "dvb-d-02-hosted-extreme", true);
    await first.context.close();

    // The extreme look, walked through every step at 1440 and 390 px with "Powered by" checked at each.
    for (const [width, height, via] of [[1440, 900, "email"], [390, 844, "phone"]] as const) {
      const looks = new Set<string>();
      const walk = await walkHosted(ctx, {
        app: APP,
        label: `dvb-d-extreme-${width}-${via}`,
        via,
        width,
        height,
        prepare: routeImages,
        atStep: async (_step, stepPage) => {
          const stepLook = await readHostedLook(stepPage).catch(() => null);
          looks.add(`${stepLook?.attrs["data-theme"]}/${stepLook?.attrs["data-layout"]}/${stepLook?.attrs["data-bg"]}/${stepLook?.attrs["data-corner"]}`);
        },
      }).catch(failure => ({ steps: [] as string[], account: null, ms: 0, readability: [], error: String(failure).split("\n")[0] }));
      const failed = "error" in walk ? (walk as { error: string }).error : "";
      results.check(`extreme look at ${width} px (${via}): a fresh Carbon reached ledgerly through every step (requirements included)`, !failed && typeof walk.account?.uuid === "string" && walk.steps.includes("signup") && walk.steps.includes("consent") && walk.steps.includes("complete") && (via === "phone" || walk.steps.includes("requirements")), failed || walk.steps.join(" → "));
      results.check(`extreme look at ${width} px: every step painted dark / minimal / image / sharp`, looks.size === 1 && looks.has("dark/minimal/image/sharp"), [...looks].join(" "));
      const worst = [...walk.readability].sort((a, b) => a.ratio - b.ratio)[0];
      results.check(`extreme look at ${width} px: the main action (outline, yellow ink on black) reads at 4.5:1 or better on every step`, !!worst && worst.ratio >= 4.5, worst ? `lowest ${worst.ratio.toFixed(2)}:1 on ${worst.step} ("${worst.label}")` : "no main action seen");
      results.metric(`extreme look ${width}px ${via}: walk to the app`, walk.ms);
    }

    // A second set of values through the API (owner session): light, rounded 40, soft, split, dots, Space Grotesk,
    // no logos of its own (the app's logo, 16 px), the app's name shown. A dark-preferring visitor still gets light.
    const second = await asSession<{ config_version: number }>(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, {
      branding: { theme: "light", light: LIGHT_B, corner_style: "rounded", radius: 40, button_style: "soft", layout: "split", background_style: "dots", background_image_url: null, density: "comfortable", font_family: "Space Grotesk", heading_font_family: null, show_app_name: true, logo_url: null, logo_dark_url: null, logo_height: 16 },
    });
    results.check(`the second look saves as version ${v0 + 2}`, second.status === 200 && second.body.config_version === v0 + 2, `${second.status} v${second.body.config_version}`);
    const other = await visit(ctx, "dvb-d-visitor-second", { dark: true });
    const l2 = other.look;
    const issues: string[] = [];
    const want = (what: string, ok: boolean, got: unknown) => {
      if (!ok) issues.push(`${what}: ${JSON.stringify(got)}`);
    };
    want("theme light (forced over the visitor's dark)", l2.attrs["data-theme"] === "light", l2.attrs);
    want("rounded corners at radius 40", l2.attrs["data-corner"] === "rounded" && l2.vars["--radius-control"] === "40px" && l2.input?.radius === "40px", [l2.vars["--radius-control"], l2.input?.radius]);
    want("soft button: a tint of the primary, neither its fill nor transparent", l2.attrs["data-button-style"] === "soft" && !!l2.primary && l2.primary.background !== rgb(LIGHT_B.primary) && !/rgba\(0, 0, 0, 0\)/.test(l2.primary.background), l2.primary);
    want("split layout with the app's side shown", l2.attrs["data-layout"] === "split" && l2.asideVisible, [l2.attrs["data-layout"], l2.asideVisible]);
    want("dots background", l2.attrs["data-bg"] === "dots" && /radial-gradient/.test(l2.backdrop), l2.backdrop.slice(0, 120));
    want("comfortable density", l2.attrs["data-density"] === "comfortable" && l2.vars["--brand-pad"] === "32px", l2.vars["--brand-pad"]);
    want("page background and text", l2.scopeBackground === rgb(LIGHT_B.background) && l2.headingColor === rgb(LIGHT_B.foreground), [l2.scopeBackground, l2.headingColor]);
    want("Space Grotesk for body and headings", /Space Grotesk/.test(l2.bodyFont) && /Space Grotesk/.test(l2.headingFont), [l2.bodyFont, l2.headingFont]);
    want("the app's own logo (from Silicon Apps) at 16 px", !!l2.logo && l2.logo.src === fakeApp(APP).logo_url && Math.round(l2.logo.height) === 16, l2.logo && { src: l2.logo.src.slice(0, 40), height: l2.logo.height });
    want("the app's name shown next to the logo", l2.appName === fakeApp(APP).name, l2.appName);
    results.check("the hosted page paints the API-set values (light, rounded 40, soft, split, dots, Space Grotesk, app logo at 16 px, name shown)", issues.length === 0, issues.join(" | ") || "all painted");
    await shot(env, other.page, "dvb-d-03-hosted-second", true);
    await other.context.close();

    // "Use the Silicon Accounts look" in the editor puts every default back.
    await page.reload();
    await page.getByText(`Stored version ${v0 + 2}`).waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "Use the Silicon Accounts look" }).click();
    await saveBar.getByRole("button", { name: "Save changes" }).click();
    await saveBar.getByText(`Saved as version ${v0 + 3}`).waitFor({ timeout: 20_000 }).catch(() => undefined);
    const defaults = (await asSession<{ signin_config: { branding: Record<string, unknown> & { light: Record<string, string>; dark: Record<string, string> } } }>(page, env, "GET", `/v1/apps/${APP}`)).body.signin_config.branding;
    results.check("\"Use the Silicon Accounts look\" stores the defaults (auto, Geist, squircle 18, card, plain, solid, the brand palettes)", defaults.theme === "auto" && defaults.font_family === "Geist" && defaults.corner_style === "squircle" && defaults.radius === 18 && defaults.layout === "card" && defaults.background_style === "plain" && defaults.button_style === "solid" && defaults.light.primary === "#1F5FB8" && defaults.dark.background === "#2A2927" && defaults.logo_url === null, JSON.stringify(defaults).slice(0, 300));
    const plain = await visit(ctx, "dvb-d-visitor-default", { dark: true });
    results.check("with the defaults the hosted page follows the visitor (dark) in the Silicon Accounts look", plain.look.attrs["data-theme"] === "dark" && plain.look.attrs["data-layout"] === "card" && plain.look.vars["--primary"]?.toUpperCase() === "#1F5FB8" && /Geist/.test(plain.look.bodyFont), JSON.stringify(plain.look.attrs));
    await plain.context.close();

    // ledgerly's seeded look again, for whoever walks it next.
    await asSession(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { branding: null });
    const restored = await asSession(page, env, "PATCH", `/v1/apps/${APP}/signin-config`, { branding: fakeApp(APP).signin_defaults?.branding });
    results.check("ledgerly's seeded branding is back", restored.status === 200, String(restored.status));
    await owner.context.close();
  },
};
