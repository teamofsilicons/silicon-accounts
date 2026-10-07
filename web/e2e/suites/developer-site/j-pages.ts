/**
 * The Pages tab (UNDERSTANDING "Making the pages your own"): every page's words and every branding variable, edited
 * with the tab's own controls by the owner of Browser, checked as they are typed (wrong URLs, placeholders and emails
 * stopped in place; a logo of the wrong type or too big refused), previewed live on every page (in light and dark, on
 * a desktop and a phone, "Powered by Silicon Accounts" on each), saved exactly as set, and shown by the hosted pages at
 * once: the sign-in and sign-up titles, the Opening page's own title, the legal links and the support address, the
 * layout, corners, background, buttons, density, fonts, colours and logo. The app's setup is put back afterwards.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import type { Journey } from "../../context";
import { POWERED_BY_HREF, hostedTitle, newContext, shot, sleep, startAtApp, tag, waitForOpening } from "../../lib";
import { appDetail, hostedLook, ownerSignIn, pressSegment, restoreConfig, saveBarText, saveChanges, selectOption, setColour, setRange, type SigninConfigView } from "./_helpers";

const APP = "browser";

/** Uploads a file through the Pages tab's "Upload logo" (it opens the browser's file picker). */
async function uploadLogo(page: Page, path: string): Promise<void> {
  const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page.getByRole("button", { name: "Upload logo", exact: true }).click();
  await (await chooser).setFiles(path);
  await sleep(500);
}

/** The preview frame (an image of the page, labelled with which page, theme and size it shows). */
const preview = (page: Page) => page.locator('[role="img"][aria-label^="Preview of the Browser sign-in"]').first();

async function previewSeen(page: Page): Promise<{ label: string; text: string; powered: string | null }> {
  const frame = preview(page);
  await sleep(450);
  return {
    label: (await frame.getAttribute("aria-label")) ?? "",
    text: (await frame.innerText().catch(() => "")).replace(/\s+/g, " "),
    powered: await frame.locator('[data-powered-by] a').last().getAttribute("href").catch(() => null),
  };
}

/** The line under the hosted page's heading (its subtitle). */
const hostedSubtitle = (page: Page) => page.evaluate(() => {
  const heading = [...document.querySelectorAll("h1")].find(element => !element.closest("[data-step-leaving]"));
  const next = heading?.nextElementSibling;
  return next && next.tagName === "P" ? (next.textContent ?? "").replace(/\s+/g, " ").trim() : "";
});

const fieldError = async (scope: Locator, label: string) => {
  const input = scope.getByRole("textbox", { name: label, exact: true });
  const ids = ((await input.getAttribute("aria-describedby")) ?? "").split(/\s+/).filter(Boolean);
  const texts = await Promise.all(ids.map(id => scope.page().locator(`[id="${id}"]`).innerText().catch(() => "")));
  return texts.join(" ").replace(/\s+/g, " ").trim();
};

export const journey: Journey = {
  name: "developer-site-pages",
  title: "the Pages tab: every page's words and every branding variable set with its own controls (mistakes stopped in place, a wrong logo refused), a live preview of every page in light and dark, desktop and phone with Powered by on each, saved exactly, and the hosted sign-in, sign-up and Opening pages showing all of it at once",
  timeoutMs: 12 * 60_000,
  async run(ctx) {
    const { env, results, browser } = ctx;
    const before = (await appDetail(ctx, APP)).signin_config;
    const files = mkdtempSync(join(tmpdir(), "ds-pages-"));
    const logoSvg = join(files, "logo.svg");
    writeFileSync(logoSvg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0F766E"/><circle cx="32" cy="32" r="14" fill="#FFFFFF"/></svg>');
    const notImage = join(files, "notes.txt");
    writeFileSync(notImage, "not a logo");
    const huge = join(files, "huge.png");
    writeFileSync(huge, Buffer.alloc(110 * 1024, 7));
    const { context, page } = await ownerSignIn(ctx, APP, { label: "pages", returnTo: `/apps/${APP}/pages` });
    try {
      const panel = page.getByRole("tabpanel", { name: "Pages" });
      const words = panel.getByRole("group", { name: "Words", exact: true });
      await words.getByRole("textbox", { name: "Sign-in title", exact: true }).waitFor({ timeout: 30_000 });
      const t = tag();
      const copy = {
        title: `Browse with Silicons ${t}`,
        subtitle: "The browser your Silicons already use.",
        signup_title: `Join Browser ${t}`,
        signup_subtitle: "One account for every Silicon app.",
        opening_title: "Hop over to {provider} for {app}",
        terms_url: "https://browser.example/terms",
        privacy_url: "https://browser.example/privacy",
        support_email: "help@browser.example",
      };

      // Words: checked as typed.
      await words.getByRole("textbox", { name: "Terms URL", exact: true }).fill("http://browser.example/terms");
      await words.getByRole("textbox", { name: "Opening page title", exact: true }).fill("Opening {provider} for {user}");
      await words.getByRole("textbox", { name: "Support email", exact: true }).fill("help at browser");
      const blocked = await saveChanges(page);
      const errors = [await fieldError(words, "Terms URL"), await fieldError(words, "Opening page title"), await fieldError(words, "Support email")];
      results.check("a terms URL without https, an unknown {placeholder} and a broken email are stopped, each next to its field", !blocked.saved && /must use https/.test(errors[0] ?? "") && /\{user\} is not a placeholder; the Opening page title can use \{provider\}/.test(errors[1] ?? "") && /contains spaces or non-ASCII characters/.test(errors[2] ?? ""), `${blocked.text.slice(0, 100)} | ${errors.join(" | ")}`);
      const fields: Array<[keyof typeof copy, string]> = [["title", "Sign-in title"], ["subtitle", "Sign-in subtitle"], ["signup_title", "Sign-up title"], ["signup_subtitle", "Sign-up subtitle"], ["opening_title", "Opening page title"], ["terms_url", "Terms URL"], ["privacy_url", "Privacy URL"], ["support_email", "Support email"]];
      for (const [key, label] of fields) await words.getByRole("textbox", { name: label, exact: true }).fill(copy[key]);
      const counter = (await words.getByText(new RegExp(`^${[...copy.title].length} of 80 characters$`)).count()) > 0;
      results.check("each title counts its characters against its limit (\"N of 80 characters\")", counter);
      await words.getByRole("textbox", { name: "Sign-up title", exact: true }).focus();
      const signupPreview = await previewSeen(page);
      results.check("focusing the sign-up title shows the sign-up page in the preview, with the new title", /: Sign up,/.test(signupPreview.label) && signupPreview.text.includes(copy.signup_title), `${signupPreview.label} — ${signupPreview.text.slice(0, 120)}`);
      await words.getByRole("textbox", { name: "Opening page title", exact: true }).focus();
      const openingPreview = await previewSeen(page);
      results.check("…and the Opening page title, the Opening Google page with {provider} and {app} filled in", /: Opening Google,/.test(openingPreview.label) && openingPreview.text.includes("Hop over to Google for Browser"), `${openingPreview.label} — ${openingPreview.text.slice(0, 120)}`);

      // Every branding variable, with the tab's own controls.
      await pressSegment(panel, "Theme", "Dark");
      const forced = await previewSeen(page);
      results.check("Theme Dark: the preview paints dark whatever the visitor's device (and says so)", /dark theme/.test(forced.label) && /always uses the dark theme/.test((await panel.innerText()).replace(/\s+/g, " ")), forced.label);
      await pressSegment(panel, "Theme", "Visitor's choice");
      await pressSegment(panel, "Palette", "Light palette");
      await setColour(page, "Primary", "#0F766E");
      await setColour(page, "Text on primary", "#FFFFFF");
      await setColour(page, "Page background", "#F0FDFA");
      await setColour(page, "Text", "#042F2E");
      await pressSegment(panel, "Palette", "Dark palette");
      await setColour(page, "Primary", "#2DD4BF");
      await setColour(page, "Text on primary", "#042F2E");
      await setColour(page, "Page background", "#042F2E");
      await setColour(page, "Text", "#CCFBF1");
      const contrastRows = await panel.getByRole("table", { name: "Contrast checks" }).getByRole("row").allInnerTexts();
      results.check("the contrast checks follow the colours as they are picked (all AA or better here)", contrastRows.slice(1).every(row => /AA/.test(row) && !/Too low/.test(row)), contrastRows.map(row => row.replace(/\s+/g, " ")).join(" | "));
      await panel.getByRole("button", { name: "Remove" }).first().click().catch(() => undefined);
      await uploadLogo(page, notImage);
      const wrongType = (await panel.getByRole("alert").filter({ hasText: /logos can be PNG, JPEG, WebP, GIF or SVG/ }).innerText().catch(() => "")).trim();
      await uploadLogo(page, huge);
      const tooBig = (await panel.getByRole("alert").filter({ hasText: /inline logos can be at most 128 KB/ }).innerText().catch(() => "")).trim();
      results.check("a logo that is not an image, or too big inline, is refused with why", /notes\.txt is text\/plain; logos can be PNG, JPEG, WebP, GIF or SVG/.test(wrongType) && /huge\.png becomes \d+ KB inline; inline logos can be at most 128 KB/.test(tooBig), `${wrongType} | ${tooBig}`);
      await uploadLogo(page, logoSvg);
      const inline = (await panel.getByRole("group", { name: "Logo", exact: true }).innerText()).replace(/\s+/g, " ");
      results.check("an SVG logo is uploaded inline", /Uploaded image, \d+ KB inline/.test(inline), inline.slice(0, 120));
      await setRange(panel.getByRole("slider", { name: "Logo height" }), 48);
      await panel.getByRole("switch", { name: "Show the app name next to the logo" }).click();
      await selectOption(panel, page, "Body font", "IBM Plex Sans (sans)");
      await selectOption(panel, page, "Heading font", "Fraunces (serif)");
      await pressSegment(panel, "Corners", "Sharp");
      const radiusDisabled = await panel.getByRole("slider", { name: "Radius" }).isDisabled();
      const sharpNote = /Sharp corners ignore the radius/.test(await panel.getByRole("group", { name: "Shape", exact: true }).innerText());
      await pressSegment(panel, "Corners", "Rounded");
      await setRange(panel.getByRole("slider", { name: "Radius" }), 10);
      results.check("sharp corners disable the radius (and say so); rounded corners take it again", radiusDisabled && sharpNote && !(await panel.getByRole("slider", { name: "Radius" }).isDisabled()));
      await panel.getByRole("radiogroup", { name: "Layout" }).getByRole("radio", { name: "Split" }).click();
      await pressSegment(panel, "Background", "Image");
      await panel.getByRole("textbox", { name: "Background image", exact: true }).fill("http://browser.example/bg.jpg");
      const imageBlocked = await saveChanges(page);
      results.check("an image background without an https URL is stopped in place", !imageBlocked.saved && /must use https/.test(imageBlocked.text + (await fieldError(panel, "Background image"))), imageBlocked.text.slice(0, 200));
      await pressSegment(panel, "Background", "Gradient");
      await sleep(300);
      const hidden = await saveBarText(page);
      results.check("switching the background from Image to Gradient leaves no problem behind about the image field it hides", !/problems? blocks? saving/.test(hidden), `save bar: ${hidden}`);
      // (Whatever the bar says, clear the hidden field the way a developer would: back to Image, empty it, Gradient.)
      await pressSegment(panel, "Background", "Image");
      await panel.getByRole("textbox", { name: "Background image", exact: true }).fill("");
      await pressSegment(panel, "Background", "Gradient");
      await pressSegment(panel, "Button style", "Outline");
      await pressSegment(panel, "Density", "Compact");
      await shot(env, page, "ds-j-01-pages-draft", true);

      // The live preview, page by page, in both themes and sizes; "Powered by" on each.
      const chips = panel.getByRole("group", { name: "Pages", exact: true }).getByRole("button");
      const names = await chips.allInnerTexts();
      // Only the pages a Carbon can meet with the draft's methods are offered (developer/…/lib/preview-pages.ts): the
      // Opening and code pages follow the methods Browser has on.
      const methodOf: Record<string, keyof SigninConfigView["methods"]> = { "Opening Google": "google", "Opening Apple": "apple", "Email code": "email", "Phone code": "phone" };
      const offered = ["Sign in", "Sign up", "Opening Google", "Opening Apple", "Email code", "Phone code", "Set up account", "What's shared", "Embed buttons"].filter(name => !methodOf[name] || before.methods[methodOf[name]]);
      results.check("the preview offers every page a Carbon can meet: sign-in and sign-up, the Opening and code pages of the methods that are on (and no others), setting up, what's shared and the embed buttons", offered.every(name => names.includes(name)) && Object.keys(methodOf).every(name => offered.includes(name) || !names.includes(name)), `${names.join(" | ")} (methods on: ${Object.entries(before.methods).filter(([, on]) => on).map(([method]) => method).join(", ")})`);
      const expectations: Record<string, RegExp> = {
        "Sign in": new RegExp(copy.title),
        "Sign up": new RegExp(copy.signup_title),
        "Opening Google": /Hop over to Google for Browser/,
        "Opening Apple": /Hop over to Apple for Browser/,
        "Email code": /Check your email/,
        "Phone code": /Check your messages/,
        "Set up account": /Set up your account/,
        "What's shared": /Share your details with Browser|Name, id and profile photo/,
        "Embed buttons": /Continue with email/,
      };
      const missing: string[] = [];
      for (const [chip, pattern] of Object.entries(expectations).filter(([name]) => offered.includes(name))) {
        await chips.filter({ hasText: new RegExp(`^${chip.replace(/'/g, ".")}$`) }).first().click();
        for (const theme of ["Light", "Dark"]) {
          await pressSegment(panel.getByRole("toolbar", { name: "Preview options" }), "Preview theme", theme);
          for (const size of ["Desktop", "Phone"]) {
            await pressSegment(panel.getByRole("toolbar", { name: "Preview options" }), "Preview size", size);
            const seen = await previewSeen(page);
            const okLabel = seen.label.includes(chip === "What's shared" ? "What's shared" : chip) && seen.label.includes(`${theme.toLowerCase()} theme`) && seen.label.endsWith(size.toLowerCase());
            if (!okLabel || !pattern.test(seen.text) || seen.powered !== POWERED_BY_HREF) missing.push(`${chip}/${theme}/${size}: label=${okLabel} text=${pattern.test(seen.text)} powered=${seen.powered}`);
          }
        }
        if (chip === "Opening Google" || chip === "Sign in") await shot(env, page, `ds-j-02-preview-${chip.replace(/\W+/g, "-").toLowerCase()}`);
      }
      results.check("every page's preview shows its own content in light and dark, on a desktop and a phone, with \"Powered by Silicon Accounts\" linking to accounts.teamofsilicons.com (4 views a page)", missing.length === 0, missing.join(" | ") || `${offered.length * 4} views`);

      // Saved exactly as set.
      const saved = await saveChanges(page);
      const stored = (await appDetail(ctx, APP)).signin_config;
      const b = stored.branding;
      const copyOk = Object.entries(copy).every(([key, value]) => stored.copy[key] === value);
      results.check("Save stores every word exactly", saved.saved && copyOk, `${saved.text}; ${JSON.stringify(stored.copy)}`);
      const brandingOk = b.theme === "auto" && b.light.primary === "#0F766E" && b.light.primary_foreground === "#FFFFFF" && b.light.background === "#F0FDFA" && b.light.foreground === "#042F2E" && b.dark.primary === "#2DD4BF" && b.dark.primary_foreground === "#042F2E" && b.dark.background === "#042F2E" && b.dark.foreground === "#CCFBF1" && b.logo_url?.startsWith("data:image/svg+xml") === true && b.logo_height === 48 && b.show_app_name === false && b.font_family === "IBM Plex Sans" && b.heading_font_family === "Fraunces" && b.corner_style === "rounded" && b.radius === 10 && b.layout === "split" && b.background_style === "gradient" && b.button_style === "outline" && b.density === "compact";
      results.check("…and every branding variable exactly (theme, both palettes, inline logo, its height, name hidden, fonts, corners, radius, layout, background, buttons, density)", brandingOk, JSON.stringify({ ...b, logo_url: b.logo_url?.slice(0, 30), logo_dark_url: b.logo_dark_url?.slice(0, 30) }));

      // The hosted pages show it at once.
      const visitor = await newContext(browser);
      const hosted = await visitor.newPage();
      results.watch(hosted, "pages-hosted");
      await startAtApp(env, hosted, APP);
      await hosted.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
      await sleep(900);
      const look = await hostedLook(hosted);
      const legal = (await hosted.locator(".sa-brand-legal").allInnerTexts()).join(" ").replace(/\s+/g, " ");
      const links = await hosted.locator(".sa-brand-legal a").evaluateAll(items => items.map(item => item.getAttribute("href") ?? ""));
      const subtitle = await hostedSubtitle(hosted);
      await shot(env, hosted, "ds-j-03-hosted-signin");
      results.check("the hosted sign-in page shows the new title and subtitle", look.title === copy.title && subtitle === copy.subtitle, `${look.title} / ${subtitle}`);
      results.check("…the terms and privacy links and the support address", links.includes(copy.terms_url) && links.includes(copy.privacy_url) && links.includes(`mailto:${copy.support_email}`) && legal.includes(copy.support_email), `${links.join(" ")} — ${legal.slice(0, 160)}`);
      results.check("…in the new look: split layout, rounded corners (10 px), gradient, outline buttons, compact, Fraunces headings on IBM Plex Sans, the light palette", look.layout === "split" && look.corner === "rounded" && look.vars["--radius-control"] === "10px" && look.bg === "gradient" && look.buttonStyle === "outline" && look.density === "compact" && /Fraunces/.test(look.titleFont) && /IBM Plex Sans/.test(look.bodyFont) && look.vars["--primary"]?.toUpperCase() === "#0F766E" && look.vars["--background"]?.toUpperCase() === "#F0FDFA", JSON.stringify({ layout: look.layout, corner: look.corner, radius: look.vars["--radius-control"], bg: look.bg, button: look.buttonStyle, density: look.density, title: look.titleFont, body: look.bodyFont, primary: look.vars["--primary"], background: look.vars["--background"] }));
      results.check("…with the uploaded logo at 48 px and no app name next to it", look.logo?.startsWith("data:image/svg+xml") === true && look.logoHeight === 48 && look.appName === null, `${look.logo?.slice(0, 26)} ${look.logoHeight}px name=${look.appName}`);
      results.check("…and \"Powered by Silicon Accounts\" at the bottom, on top of everything, linking to accounts.teamofsilicons.com", look.poweredBy.href === POWERED_BY_HREF && look.poweredBy.onTop && look.poweredBy.text === "Powered by Silicon Accounts", JSON.stringify(look.poweredBy));
      await startAtApp(env, hosted, APP, { intent: "signup" });
      await hosted.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
      const signupTitle = await hostedTitle(hosted);
      const signupSubtitle = await hostedSubtitle(hosted);
      results.check("the app's Sign up button opens the sign-up title and subtitle", signupTitle === copy.signup_title && signupSubtitle === copy.signup_subtitle, `${signupTitle} / ${signupSubtitle}`);
      await startAtApp(env, hosted, APP, { method: "google" });
      const opening = await waitForOpening(env, hosted, "google", { stay: true, shotName: "ds-j-04-hosted-opening" });
      results.check("the app's Continue with Google opens its own Opening title in its look (Fraunces), Powered by at the bottom", opening.title === "Hop over to Google for Browser" && /Fraunces/.test(opening.headingFont) && opening.poweredBy.href === POWERED_BY_HREF, JSON.stringify({ title: opening.title, font: opening.headingFont, powered: opening.poweredBy.href }));
      await visitor.close();
      const dark = await newContext(browser, { dark: true, width: 390, height: 844 });
      const darkPage = await dark.newPage();
      results.watch(darkPage, "pages-hosted-dark");
      await startAtApp(env, darkPage, APP);
      await darkPage.getByRole("textbox", { name: "Email" }).waitFor({ timeout: 30_000 });
      await sleep(800);
      const darkLook = await hostedLook(darkPage);
      await shot(env, darkPage, "ds-j-05-hosted-dark-390");
      results.check("a visitor in dark mode on a phone gets the dark palette (the theme follows the visitor)", darkLook.paint === "dark" && darkLook.vars["--primary"]?.toUpperCase() === "#2DD4BF" && darkLook.vars["--background"]?.toUpperCase() === "#042F2E", JSON.stringify({ paint: darkLook.paint, primary: darkLook.vars["--primary"], background: darkLook.vars["--background"] }));
      await dark.close();

      // "Use the Silicon Accounts look" puts the defaults in the draft (not saved until Save).
      await panel.getByRole("button", { name: "Use the Silicon Accounts look" }).click();
      const reset = await saveBarText(page);
      results.check("\"Use the Silicon Accounts look\" puts the default look into the draft as unsaved changes", /unsaved change/.test(reset) && (await page.getByRole("button", { name: /^Primary #1F5FB8/ }).count()) === 1, reset);
      await page.getByRole("region", { name: "Unsaved changes" }).getByRole("button", { name: "Discard" }).click();
    } finally {
      await restoreConfig(ctx, APP, before);
      await context.close();
    }
  },
};
