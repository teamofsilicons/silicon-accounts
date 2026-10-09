/**
 * Renders the site's brand files into public/ from the sources here, with Playwright's Chromium:
 *   og.html          → public/og.png (1200 by 630, the social image every page shares)
 *   icon.svg         → public/icon-192.png, icon-512.png and favicon.ico (16, 32 and 48 px)
 *   maskable.svg     → public/icon-maskable-512.png (full bleed, for the web manifest)
 *   apple.svg        → public/apple-touch-icon.png (180 px)
 * public/icon.svg is icon.svg as is. Run it after changing any source: node scripts/brand/render.mjs
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "public");
const browser = await chromium.launch();

const og = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await og.goto(`file://${join(here, "og.html")}`);
await og.evaluate(() => document.fonts.ready);
await og.screenshot({ path: join(out, "og.png") });

const render = async (file, size) => {
  const svg = readFileSync(join(here, file), "utf8");
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0;background:transparent"><img style="display:block;width:${size}px;height:${size}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body>`);
  const png = await page.screenshot({ omitBackground: true });
  await page.close();
  return png;
};

writeFileSync(join(out, "icon-192.png"), await render("icon.svg", 192));
writeFileSync(join(out, "icon-512.png"), await render("icon.svg", 512));
writeFileSync(join(out, "icon-maskable-512.png"), await render("maskable.svg", 512));
writeFileSync(join(out, "apple-touch-icon.png"), await render("apple.svg", 180));
copyFileSync(join(here, "icon.svg"), join(out, "icon.svg"));

// favicon.ico: PNG images in an ICO container (a 6-byte header, one 16-byte entry per image, then the images).
const sizes = [16, 32, 48];
const images = [];
for (const size of sizes) images.push(await render("icon.svg", size));
const header = Buffer.alloc(6);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((size, index) => {
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size, 0);
  entry.writeUInt8(size, 1);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(images[index].length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += images[index].length;
  return entry;
});
writeFileSync(join(out, "favicon.ico"), Buffer.concat([header, ...entries, ...images]));

await browser.close();
console.log("brand: wrote og.png, icon.svg, icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png, favicon.ico");
