/**
 * Contrast on the Pages tab: button text on the primary colour and page text on the page background must be at least
 * 4.5:1 in both themes (WCAG AA). The tab shows each ratio live, says "Too low" and why before anything is sent, and
 * the server refuses the same colours with the same ratio, naming the setting; 4.47:1 is refused and 4.54:1 accepted
 * on both sides. The owner of Quill Docs tries it; nothing low is ever stored.
 */
import type { Locator, Page } from "@playwright/test";
import type { Journey } from "../../context";
import { developerApi, shot, sleep } from "../../lib";
import { appDetail, contrast, errorCode, errorFields, ownerSignIn, pressSegment, restoreConfig, saveChanges, setColour } from "./_helpers";

const APP = "quill-docs";
/** The tab's own formatting: two decimals, never rounded up past the threshold. */
const shown = (ratio: number) => `${(Math.floor(ratio * 100) / 100).toFixed(2)}:1`;
const level = (ratio: number) => (ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : "Too low");

async function table(panel: Locator): Promise<Record<string, string>> {
  const rows = await panel.getByRole("table", { name: "Contrast checks" }).getByRole("row").allInnerTexts();
  return Object.fromEntries(rows.slice(1).map(row => {
    const parts = row.split("\n").map(part => part.trim()).filter(Boolean);
    return [parts[0] ?? "", parts.slice(1).join(" ")];
  }));
}

async function pickerReadout(page: Page, label: string): Promise<string> {
  await page.getByRole("button", { name: new RegExp(`^${label} #[0-9A-F]{6}`) }).first().click();
  const panel = page.getByRole("dialog", { name: `${label} color` });
  await sleep(400);
  const text = ((await panel.textContent()) ?? "").replace(/\s+/g, " ");
  await panel.getByRole("button", { name: "Done" }).click();
  return text;
}

export const journey: Journey = {
  name: "developer-site-contrast",
  title: "contrast on the Pages tab: each ratio shown live in both themes; too low is \"Too low\" with why before anything is sent; the server refuses the same colours with the same ratio and names the setting; 4.47:1 refused and 4.54:1 accepted on both sides; nothing low is stored",
  async run(ctx) {
    const { env, results } = ctx;
    const before = (await appDetail(ctx, APP)).signin_config;
    const { context, page } = await ownerSignIn(ctx, APP, { label: "contrast", returnTo: `/apps/${APP}/pages` });
    try {
      const panel = page.getByRole("tabpanel", { name: "Pages" });
      await panel.getByRole("table", { name: "Contrast checks" }).waitFor({ timeout: 30_000 });
      const b = before.branding;
      const expected = {
        "Button text on primary": `${shown(contrast(b.light.primary_foreground, b.light.primary))} ${level(contrast(b.light.primary_foreground, b.light.primary))} ${shown(contrast(b.dark.primary_foreground, b.dark.primary))} ${level(contrast(b.dark.primary_foreground, b.dark.primary))}`,
        "Text on the page background": `${shown(contrast(b.light.foreground, b.light.background))} ${level(contrast(b.light.foreground, b.light.background))} ${shown(contrast(b.dark.foreground, b.dark.background))} ${level(contrast(b.dark.foreground, b.dark.background))}`,
      };
      const seen = await table(panel);
      results.check("the contrast table shows the stored palettes' ratios and levels, light and dark", seen["Button text on primary"] === expected["Button text on primary"] && seen["Text on the page background"] === expected["Text on the page background"], `${JSON.stringify(seen)} vs ${JSON.stringify(expected)}`);

      // Too low in the light theme: button text on the primary.
      const low = "#4A2E80";
      const lowRatio = contrast(low, b.light.primary);
      await pressSegment(panel, "Palette", "Light palette");
      await setColour(page, "Text on primary", low);
      const afterLow = await table(panel);
      results.check(`button text ${low} on the primary ${b.light.primary} shows ${shown(lowRatio)} "Too low" at once`, (afterLow["Button text on primary"] ?? "").startsWith(`${shown(lowRatio)} Too low`), JSON.stringify(afterLow));
      const readout = await pickerReadout(page, "Text on primary");
      results.check("…and the colour picker itself reads the ratio against the primary and says it fails", readout.includes(`Contrast ${lowRatio.toFixed(2)} to 1, fails`), readout.slice(0, 240));
      const stopped = await saveChanges(page);
      await shot(env, page, "ds-k-01-too-low");
      results.check("Save is stopped before anything is sent, saying which pair, by how much, and the minimum", !stopped.saved && stopped.text.includes(`In the light theme, button text on the primary colour is ${shown(lowRatio)}; it needs at least 4.5:1 so the page stays readable.`), stopped.text.slice(0, 300));

      // The server refuses the same, with the same number, naming the setting.
      const version = (await appDetail(ctx, APP)).config_version;
      const refused = await developerApi(env, page, `/apps/${APP}/signin-config`, { method: "PATCH", json: { branding: { light: { primary_foreground: low } } } });
      const message = errorFields(refused.body)["branding.light.primary_foreground"] ?? "";
      results.check("the server refuses it too (422), on branding.light.primary_foreground, with the same ratio and why", refused.status === 422 && errorCode(refused.body) === "validation_failed" && message.includes(`(${low}) and branding.light.primary (${b.light.primary}) is ${(Math.floor(lowRatio * 100) / 100).toFixed(2)}:1`) && /at least 4\.5:1 \(WCAG AA for text\) because button text must stay readable/.test(message), `${refused.status} ${message}`);
      const darkLow = await developerApi(env, page, `/apps/${APP}/signin-config`, { method: "PATCH", json: { branding: { dark: { foreground: "#3A3346" } } } });
      results.check("…and dark page text that is too low, on branding.dark.foreground (\"page text must stay readable\")", darkLow.status === 422 && /page text must stay readable/.test(errorFields(darkLow.body)["branding.dark.foreground"] ?? ""), JSON.stringify(errorFields(darkLow.body)).slice(0, 300));

      // The dark palette on the tab: too low there says so too.
      await page.getByRole("region", { name: "Unsaved changes" }).getByRole("button", { name: "Discard" }).click();
      await pressSegment(panel, "Palette", "Dark palette");
      await setColour(page, "Text", "#3A3346");
      const darkTable = await table(panel);
      const darkRatio = contrast("#3A3346", b.dark.background);
      results.check(`dark text #3A3346 on ${b.dark.background} shows ${shown(darkRatio)} Too low in the dark column`, (darkTable["Text on the page background"] ?? "").endsWith(`${shown(darkRatio)} Too low`), JSON.stringify(darkTable));
      await page.getByRole("region", { name: "Unsaved changes" }).getByRole("button", { name: "Discard" }).click();

      // The threshold: #777777 on white (4.47:1) refused, #767676 (4.54:1) accepted, by the tab and by the server.
      await pressSegment(panel, "Palette", "Light palette");
      await setColour(page, "Page background", "#FFFFFF");
      await setColour(page, "Text", "#777777");
      const under = await table(panel);
      const underSave = await saveChanges(page);
      const underRatio = shown(contrast("#777777", "#FFFFFF"));
      const overRatio = shown(contrast("#767676", "#FFFFFF"));
      results.check(`#777777 on white (${underRatio}) is "Too low" on the tab and Save is stopped`, (under["Text on the page background"] ?? "").startsWith(`${underRatio} Too low`) && !underSave.saved, `${JSON.stringify(under)} | ${underSave.text.slice(0, 120)}`);
      await setColour(page, "Text", "#767676");
      const over = await table(panel);
      const overSave = await saveChanges(page);
      results.check(`#767676 on white (${overRatio}) is AA on the tab and saves`, (over["Text on the page background"] ?? "").startsWith(`${overRatio} AA`) && overSave.saved, `${JSON.stringify(over)} | ${overSave.text.slice(0, 120)}`);
      const serverUnder = await developerApi(env, page, `/apps/${APP}/signin-config`, { method: "PATCH", json: { branding: { light: { foreground: "#777777" } } } });
      results.check(`…and the server draws the line at the same place (${underRatio} refused, ${overRatio} stored)`, serverUnder.status === 422 && (errorFields(serverUnder.body)["branding.light.foreground"] ?? "").includes(`is ${underRatio}`) && (await appDetail(ctx, APP)).signin_config.branding.light.foreground === "#767676", `${serverUnder.status} ${errorFields(serverUnder.body)["branding.light.foreground"]}`);
      results.check("nothing below 4.5:1 was ever stored (the version moved only for the 4.54:1 save)", (await appDetail(ctx, APP)).config_version === version + 1, `${version} → ${(await appDetail(ctx, APP)).config_version}`);
    } finally {
      await restoreConfig(ctx, APP, before);
      await context.close();
    }
  },
};
