/**
 * "Can I put in my own style well": Quill Docs' owner gives its sign-in three very different looks on the developer
 * site's Pages tab, using only the tab's own controls, and each one is checked on the hosted pages a Carbon sees (the
 * sign-in page in a light and a dark browser, at 1440 and 390 px wide, and the Opening page):
 * 1. loud: Pixel Studio's look (hot pink, sharp corners, outline buttons, Space Grotesk, minimal, dots, light only);
 * 2. dark serif: Acme Notes' look (always dark, Fraunces headings on Inter, squircles of 28, split, grain, its own logo
 *    for dark);
 * 3. extreme: everything at its limit (yellow and black, follows the visitor, JetBrains Mono under Instrument Serif,
 *    radius 40, a 96 px wide logo, compact, soft buttons, an 80-character title).
 * Each look is stored exactly as set, painted with its own palette, fonts, shape and logo, readable (heading and button
 * at least 4.5:1 as painted), never wider than the screen, and "Powered by Silicon Accounts" stays on top and in reach,
 * linking to accounts.teamofsilicons.com. Quill Docs' setup is put back afterwards.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { Journey } from "../../context";
import { POWERED_BY_HREF, fakeApp, newContext, poweredBy, shot, sleep, startAtApp, waitForOpening } from "../../lib";
import { appDetail, hostedLook, ownerSignIn, pressSegment, renderedContrast, restoreConfig, saveChanges, selectOption, setColour, setRange, type Palette } from "./_helpers";

const APP = "quill-docs";
const NAME = "Quill Docs";

interface Look {
  key: string;
  label: string;
  theme: "auto" | "light" | "dark";
  light: Palette;
  dark: Palette;
  font: string;
  heading: string | null;
  corner: "sharp" | "rounded" | "squircle";
  radius: number;
  button: "solid" | "soft" | "outline";
  layout: "card" | "split" | "minimal";
  background: "plain" | "dots" | "grain" | "gradient";
  density: "comfortable" | "compact";
  logoHeight: number;
  showName: boolean;
  /** SVG sources written to files and uploaded. */
  logo: string;
  logoDark: string | null;
  title: string;
  subtitle: string;
  opening: string | null;
}

const FONT_KIND: Record<string, string> = { Geist: "sans", Inter: "sans", "IBM Plex Sans": "sans", "DM Sans": "sans", "Space Grotesk": "sans", "Source Serif 4": "serif", Fraunces: "serif", "Instrument Serif": "serif", "JetBrains Mono": "mono", System: "the device's own" };

const svgOf = (dataUrl: unknown) => Buffer.from(String(dataUrl ?? "").replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");
const brandingOf = (appId: string) => (fakeApp(appId).signin_defaults as { branding: Record<string, unknown> }).branding;

function looks(): Look[] {
  const pixel = brandingOf("pixel-studio");
  const acme = brandingOf("acme-notes");
  return [
    {
      key: "loud", label: "loud (Pixel Studio's look)", theme: "light", light: pixel.light as Palette, dark: pixel.dark as Palette,
      font: "Space Grotesk", heading: "Space Grotesk", corner: "sharp", radius: 0, button: "outline", layout: "minimal", background: "dots", density: "comfortable",
      logoHeight: 44, showName: true, logo: svgOf(pixel.logo_url), logoDark: null,
      title: "QUILL DOCS", subtitle: "Sign in. Write loud things.", opening: null,
    },
    {
      key: "serif", label: "dark serif (Acme Notes' look)", theme: "dark", light: acme.light as Palette, dark: acme.dark as Palette,
      font: "Inter", heading: "Fraunces", corner: "squircle", radius: 28, button: "solid", layout: "split", background: "grain", density: "comfortable",
      logoHeight: 40, showName: true, logo: svgOf(acme.logo_url), logoDark: svgOf(acme.logo_dark_url),
      title: "Welcome back to Quill Docs", subtitle: "Sign in to pick up where you left off.", opening: "Taking you to {provider} for {app}…",
    },
    {
      key: "extreme", label: "extreme (every control at its limit)", theme: "auto",
      light: { primary: "#FF3D00", primary_foreground: "#000000", background: "#FFFF00", surface: "#FFFFFF", foreground: "#000000", muted: "#333333", border: "#000000", danger: "#B00020" },
      dark: { primary: "#00FFD1", primary_foreground: "#000000", background: "#120024", surface: "#000000", foreground: "#F0F0F0", muted: "#BBBBBB", border: "#FF00FF", danger: "#FF5370" },
      font: "JetBrains Mono", heading: "Instrument Serif", corner: "squircle", radius: 40, button: "soft", layout: "card", background: "gradient", density: "compact",
      logoHeight: 96, showName: true,
      logo: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><rect width="300" height="100" fill="#000"/><text x="150" y="68" font-size="56" text-anchor="middle" fill="#FFFF00" font-family="monospace">QUILL</text></svg>',
      logoDark: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"><rect width="300" height="100" fill="#00FFD1"/><text x="150" y="68" font-size="56" text-anchor="middle" fill="#120024" font-family="monospace">QUILL</text></svg>',
      // 80 characters exactly, with letters outside ASCII: it must wrap, never widen the page.
      title: "Ünïcödé ✦ QUILL DOCS ✦ the longest, loudest sign-in title a page can take, yes!",
      subtitle: "Every control at its limit: yellow and black, a 96 px logo, monospace body under a display serif, the roundest corners, compact density, soft buttons and a gradient.",
      opening: "{provider} → {app} → {provider} → {app}",
    },
  ];
}

const COLOUR_LABEL: Record<keyof Palette, string> = { primary: "Primary", primary_foreground: "Text on primary", background: "Page background", surface: "Card", foreground: "Text", muted: "Muted text", border: "Borders", danger: "Errors" };

async function uploadLogo(page: Page, button: string, path: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page.getByRole("button", { name: button, exact: true }).click();
  await (await chooser).setFiles(path);
  await sleep(400);
}

/** Sets every control of the Pages tab to the look (the way an owner would), then saves. */
async function applyLook(page: Page, panel: Locator, look: Look, dir: string): Promise<{ saved: boolean; version: number | null; text: string }> {
  const words = panel.getByRole("group", { name: "Words", exact: true });
  await words.getByRole("textbox", { name: "Sign-in title", exact: true }).fill(look.title);
  await words.getByRole("textbox", { name: "Sign-in subtitle", exact: true }).fill(look.subtitle);
  await words.getByRole("textbox", { name: "Opening page title", exact: true }).fill(look.opening ?? "");
  await pressSegment(panel, "Theme", look.theme === "auto" ? "Visitor's choice" : look.theme === "light" ? "Light" : "Dark");
  for (const palette of ["light", "dark"] as const) {
    await pressSegment(panel, "Palette", palette === "light" ? "Light palette" : "Dark palette");
    for (const key of Object.keys(COLOUR_LABEL) as Array<keyof Palette>) await setColour(page, COLOUR_LABEL[key], look[palette][key].toUpperCase());
  }
  // Logos: whatever is there goes, then the look's own (uploaded inline).
  const logoGroup = panel.getByRole("group", { name: "Logo", exact: true });
  while (await logoGroup.getByRole("button", { name: "Remove", exact: true }).count()) {
    await logoGroup.getByRole("button", { name: "Remove", exact: true }).first().click();
    await sleep(150);
  }
  const logoPath = join(dir, `${look.key}-logo.svg`);
  writeFileSync(logoPath, look.logo);
  await uploadLogo(page, "Upload logo", logoPath);
  if (look.logoDark) {
    const darkPath = join(dir, `${look.key}-logo-dark.svg`);
    writeFileSync(darkPath, look.logoDark);
    await uploadLogo(page, "Upload logo on dark", darkPath);
  }
  await setRange(panel.getByRole("slider", { name: "Logo height" }), look.logoHeight);
  const nameSwitch = panel.getByRole("switch", { name: "Show the app name next to the logo" });
  if (((await nameSwitch.getAttribute("aria-checked")) === "true") !== look.showName) await nameSwitch.click();
  await selectOption(panel, page, "Body font", `${look.font} (${FONT_KIND[look.font]})`);
  await selectOption(panel, page, "Heading font", look.heading ? `${look.heading} (${FONT_KIND[look.heading]})` : `Same as the body (${look.font})`);
  await pressSegment(panel, "Corners", look.corner === "sharp" ? "Rounded" : look.corner === "squircle" ? "Squircle" : "Rounded");
  await setRange(panel.getByRole("slider", { name: "Radius" }), look.radius);
  if (look.corner === "sharp") await pressSegment(panel, "Corners", "Sharp");
  await panel.getByRole("radiogroup", { name: "Layout" }).getByRole("radio", { name: look.layout.charAt(0).toUpperCase() + look.layout.slice(1) }).click();
  await pressSegment(panel, "Background", look.background.charAt(0).toUpperCase() + look.background.slice(1));
  await pressSegment(panel, "Button style", look.button.charAt(0).toUpperCase() + look.button.slice(1));
  await pressSegment(panel, "Density", look.density.charAt(0).toUpperCase() + look.density.slice(1));
  return saveChanges(page);
}

export const journey: Journey = {
  name: "developer-site-styles",
  title: "\"can I put in my own style well\": three looks set with the Pages tab's own controls (loud like Pixel Studio, dark serif like Acme Notes, every control at its limit), each stored exactly and shown by the hosted sign-in and Opening pages in light and dark at 1440 and 390 px: its palette, fonts, shape, layout and logo, readable, never wider than the screen, Powered by Silicon Accounts on top",
  timeoutMs: 12 * 60_000,
  async run(ctx) {
    const { env, results, browser } = ctx;
    const before = (await appDetail(ctx, APP)).signin_config;
    const dir = mkdtempSync(join(tmpdir(), "ds-styles-"));
    const { context, page } = await ownerSignIn(ctx, APP, { label: "styles", returnTo: `/apps/${APP}/pages` });
    try {
      const panel = page.getByRole("tabpanel", { name: "Pages" });
      await panel.getByRole("group", { name: "Words", exact: true }).getByRole("textbox", { name: "Sign-in title", exact: true }).waitFor({ timeout: 30_000 });
      for (const look of looks()) {
        const started = Date.now();
        const saved = await applyLook(page, panel, look, dir);
        results.metric(`setting the ${look.key} look with the tab's controls`, Date.now() - started, "ms");
        const stored = (await appDetail(ctx, APP)).signin_config;
        const b = stored.branding;
        const paletteSame = (a: Palette, e: Palette) => (Object.keys(e) as Array<keyof Palette>).every(key => a[key]?.toUpperCase() === e[key].toUpperCase());
        const exact = b.theme === look.theme && paletteSame(b.light, look.light) && paletteSame(b.dark, look.dark) && b.font_family === look.font && (b.heading_font_family ?? null) === look.heading && b.corner_style === look.corner && (look.corner === "sharp" || b.radius === look.radius) && b.button_style === look.button && b.layout === look.layout && b.background_style === look.background && b.density === look.density && b.logo_height === look.logoHeight && b.show_app_name === look.showName && b.logo_url?.startsWith("data:image/svg+xml") === true && (look.logoDark ? b.logo_dark_url?.startsWith("data:image/svg+xml") === true : b.logo_dark_url === null) && stored.copy.title === look.title && stored.copy.subtitle === look.subtitle && (stored.copy.opening_title ?? null) === look.opening;
        results.check(`${look.label}: saved with the tab's own controls, and stored exactly as set`, saved.saved && exact, `${saved.text}; ${JSON.stringify({ theme: b.theme, font: b.font_family, heading: b.heading_font_family, corner: b.corner_style, radius: b.radius, button: b.button_style, layout: b.layout, bg: b.background_style, density: b.density, logo_h: b.logo_height, light: b.light.primary, dark: b.dark.primary, title: stored.copy.title })}`);
        await shot(env, page, `ds-q-${look.key}-00-editor`);

        // The hosted sign-in page as Carbons see it: light and dark browsers, desktop and phone.
        const problems: string[] = [];
        for (const dark of [false, true]) {
          for (const width of [1440, 390]) {
            const visitor = await newContext(browser, { dark, width, height: width === 390 ? 844 : 900 });
            const hosted = await visitor.newPage();
            const where = `${dark ? "dark" : "light"} ${width}px`;
            results.watch(hosted, `styles-${look.key}-${dark ? "dark" : "light"}-${width}`);
            await startAtApp(env, hosted, APP);
            await hosted.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
            await hosted.waitForFunction(() => document.querySelector('[data-fonts="ready"]') !== null, undefined, { timeout: 8_000 }).catch(() => undefined);
            await sleep(700);
            const lookSeen = await hostedLook(hosted);
            const power = await poweredBy(hosted);
            const painted = await renderedContrast(hosted);
            const overflow = await hosted.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            await shot(env, hosted, `ds-q-${look.key}-${dark ? "dark" : "light"}-${width}`);
            const paint = look.theme === "auto" ? (dark ? "dark" : "light") : look.theme;
            const palette = paint === "dark" ? look.dark : look.light;
            const wantLogo = paint === "dark" && look.logoDark ? b.logo_dark_url : b.logo_url;
            const fails: string[] = [];
            if (lookSeen.paint !== paint) fails.push(`paints ${lookSeen.paint}, not ${paint}`);
            if (lookSeen.vars["--primary"]?.toUpperCase() !== palette.primary.toUpperCase() || lookSeen.vars["--background"]?.toUpperCase() !== palette.background.toUpperCase()) fails.push(`colours ${lookSeen.vars["--primary"]}/${lookSeen.vars["--background"]}, not ${palette.primary}/${palette.background}`);
            if (lookSeen.corner !== look.corner || lookSeen.bg !== look.background || lookSeen.buttonStyle !== look.button || lookSeen.density !== look.density) fails.push(`shape ${lookSeen.corner}/${lookSeen.bg}/${lookSeen.buttonStyle}/${lookSeen.density}`);
            if (width === 1440 && lookSeen.layout !== look.layout) fails.push(`layout ${lookSeen.layout}, not ${look.layout}`);
            if (look.corner !== "sharp" && lookSeen.vars["--radius-control"] !== `${look.radius}px`) fails.push(`radius ${lookSeen.vars["--radius-control"]}`);
            if (lookSeen.title !== look.title) fails.push(`title "${lookSeen.title}"`);
            if (!lookSeen.titleFont.includes(look.heading ?? look.font) || !lookSeen.bodyFont.includes(look.font)) fails.push(`fonts ${lookSeen.titleFont.slice(0, 40)} / ${lookSeen.bodyFont.slice(0, 40)}`);
            if (lookSeen.logo !== wantLogo || lookSeen.logoHeight !== look.logoHeight) fails.push(`logo ${lookSeen.logo?.slice(0, 30)} ${lookSeen.logoHeight}px`);
            // The name shows next to the logo, except where the title already is the app's name (flow-page.tsx hideName).
            const nameShown = look.showName && look.title.trim().toLowerCase() !== NAME.toLowerCase();
            if (nameShown && lookSeen.appName !== NAME && !(width === 1440 && look.layout === "split")) fails.push(`app name ${lookSeen.appName}`);
            if (!nameShown && lookSeen.appName !== null) fails.push(`app name ${lookSeen.appName} repeats the title`);
            if ((painted.heading ?? 0) < 4.5 || (painted.button ?? 0) < 4.5) fails.push(`painted contrast ${painted.detail} (${painted.heading}/${painted.button})`);
            if (overflow > 1) fails.push(`${overflow}px wider than the screen`);
            if (power.href !== POWERED_BY_HREF || !/Powered by Silicon Accounts/.test(power.text) || !lookSeen.poweredBy.onTop || !(power.inView || power.atEnd)) fails.push(`Powered by ${JSON.stringify(power)} onTop=${lookSeen.poweredBy.onTop}`);
            if (fails.length) problems.push(`${where}: ${fails.join("; ")}`);
            await visitor.close();
          }
        }
        results.check(`${look.label}: the hosted sign-in page shows it in light and dark browsers at 1440 and 390 px (palette, fonts, shape, layout, logo, title), readable as painted, never wider than the screen, with Powered by Silicon Accounts on top and in reach`, problems.length === 0, problems.join(" | ") || "4 views");

        // The Opening page (the app's own Continue with Google) in the same look.
        const opener = await newContext(browser);
        const openerPage = await opener.newPage();
        results.watch(openerPage, `styles-${look.key}-opening`);
        await startAtApp(env, openerPage, APP, { method: "google" });
        const opening = await waitForOpening(env, openerPage, "google", { stay: true, shotName: `ds-q-${look.key}-opening` });
        const wantTitle = (look.opening ?? "Opening {provider} to sign you in to {app}…").replace(/\{provider\}/g, "Google").replace(/\{app\}/g, NAME);
        results.check(`${look.label}: the Opening page has its title, its heading font and Powered by`, opening.title === wantTitle && opening.headingFont.includes(look.heading ?? look.font) && opening.poweredBy.href === POWERED_BY_HREF, JSON.stringify({ title: opening.title, font: opening.headingFont.slice(0, 40), powered: opening.poweredBy.href }));
        await opener.close();
      }
    } finally {
      await restoreConfig(ctx, APP, before);
      await context.close();
    }
  },
};
