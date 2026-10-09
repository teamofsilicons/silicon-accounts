/**
 * The branding runtime's derived inks read on what they are painted on (WCAG 1.4.3, 4.5:1).
 *
 *   web/node_modules/.bin/tsx --test web/lib/branding/apply.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Palette } from "../api/types";
import { accentStrong, brandingAttributes, brandingVariables } from "./apply";
import { contrastRatio, mixHex, mixOklab } from "./contrast";
import { DEFAULT_BRANDING, DEFAULT_DARK, DEFAULT_LIGHT, LEGACY_DARK, LEGACY_LIGHT, isSiliconLook, normalizeBranding } from "./defaults";

/** What --accent-strong is painted on: the page, the card, the info badge's tint over each, a hovered badge's tint. */
function grounds(p: Palette, dark: boolean): string[] {
  const tint = dark ? 0.18 : 0.11;
  return [p.background, p.surface, mixHex(p.surface, p.primary, tint), mixHex(p.background, p.primary, tint), mixOklab(p.surface, p.primary, 0.1)];
}

function worst(ink: string, p: Palette, dark: boolean): number {
  return Math.min(...grounds(p, dark).map(ground => contrastRatio(ink, ground) ?? 0));
}

describe("--accent-strong", () => {
  it("reads on the info badge's tint in the old default dark palette (was #5383C9, 2.9:1 on #313C4A)", () => {
    const ink = accentStrong(LEGACY_DARK, true);
    assert.ok(ink && /^#[0-9A-F]{6}$/.test(ink), `a derived colour, got ${ink}`);
    assert.equal(mixHex(LEGACY_DARK.surface, LEGACY_DARK.primary, 0.18), "#313C4A");
    assert.ok(worst(ink!, LEGACY_DARK, true) >= 4.5, `${ink}: ${worst(ink!, LEGACY_DARK, true).toFixed(2)}:1`);
  });

  it("reads on the info badge's tint in the default dark palette", () => {
    const ink = brandingVariables(DEFAULT_BRANDING, "dark")["--accent-strong"]!;
    assert.match(ink, /^#[0-9A-F]{6}$/, `a derived colour, got ${ink}`);
    assert.ok(worst(ink, DEFAULT_DARK, true) >= 4.5, `${ink}: ${worst(ink, DEFAULT_DARK, true).toFixed(2)}:1`);
  });

  it("keeps the theme's own ink when it already reads (the default light palette)", () => {
    assert.equal(accentStrong(DEFAULT_LIGHT, false), null);
    assert.equal(brandingVariables(DEFAULT_BRANDING, "light")["--accent-strong"], "color-mix(in oklab, #1F5FB8 78%, #292929)");
  });

  it("reads for a light primary on a light page and a dark primary on a dark page", () => {
    const amber: Palette = { ...DEFAULT_LIGHT, primary: "#F3AD20", primary_foreground: "#20190D" };
    const navy: Palette = { ...DEFAULT_DARK, primary: "#123A7A" };
    for (const [palette, dark] of [[amber, false], [navy, true]] as const) {
      const ink = accentStrong(palette, dark) ?? mixOklab(palette.primary, palette.foreground, 0.22);
      assert.ok(worst(ink, palette, dark) >= 4.5, `${palette.primary} → ${ink}: ${worst(ink, palette, dark).toFixed(2)}:1`);
    }
  });
});

describe("the Silicon Accounts look", () => {
  it("paints the service's old default palettes in the new look, and nothing else", () => {
    const stored = normalizeBranding({ light: { ...LEGACY_LIGHT }, dark: { ...LEGACY_DARK, primary: "#1f5fb8" } });
    assert.deepEqual(stored.light, DEFAULT_LIGHT);
    assert.deepEqual(stored.dark, DEFAULT_DARK);
    // One colour of the app's own keeps the whole palette exactly as the app stored it (dm's green on the old paper).
    const dm = normalizeBranding({ light: { ...LEGACY_LIGHT, primary: "#17775C" }, dark: LEGACY_DARK });
    assert.deepEqual(dm.light, { ...LEGACY_LIGHT, primary: "#17775C" });
    assert.deepEqual(dm.dark, DEFAULT_DARK);
  });

  it("takes the site's faces only when the app kept every default colour and the default font", () => {
    const defaults = normalizeBranding({ light: LEGACY_LIGHT, dark: LEGACY_DARK, font_family: "Geist" });
    assert.equal(isSiliconLook(defaults), true);
    assert.match(brandingVariables(defaults, "light")["--font-display"]!, /^"BDO Grotesk"/);
    assert.match(brandingVariables(defaults, "dark")["--font-body"]!, /^-apple-system/);
    assert.equal(brandingAttributes(defaults, "light")["data-look"], "silicon");
    for (const own of [
      { ...defaults, font_family: "Inter" as const },
      { ...defaults, heading_font_family: "Instrument Serif" as const },
      normalizeBranding({ light: { ...LEGACY_LIGHT, primary: "#17775C" }, dark: LEGACY_DARK }),
    ]) {
      assert.equal(isSiliconLook(own), false);
      assert.match(brandingVariables(own, "light")["--font-body"]!, /--font-geist|Inter/);
      assert.equal(brandingAttributes(own, "light")["data-look"], undefined);
    }
  });

  it("keeps button text, page text, muted text and error text at 4.5:1 in both themes", () => {
    for (const p of [DEFAULT_LIGHT, DEFAULT_DARK]) {
      for (const [text, ground] of [[p.primary_foreground, p.primary], [p.foreground, p.background], [p.foreground, p.surface], [p.muted, p.background], [p.muted, p.surface], [p.danger, p.surface], [p.danger, p.background]] as const) {
        assert.ok((contrastRatio(text, ground) ?? 0) >= 4.5, `${text} on ${ground}: ${contrastRatio(text, ground)?.toFixed(2)}:1`);
      }
    }
  });
});
