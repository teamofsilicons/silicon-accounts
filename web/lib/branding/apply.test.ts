/**
 * The branding runtime's derived inks read on what they are painted on (WCAG 1.4.3, 4.5:1).
 *
 *   web/node_modules/.bin/tsx --test web/lib/branding/apply.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Palette } from "../api/types";
import { accentStrong, brandingVariables } from "./apply";
import { contrastRatio, mixHex, mixOklab } from "./contrast";
import { DEFAULT_BRANDING, DEFAULT_DARK, DEFAULT_LIGHT } from "./defaults";

/** What --accent-strong is painted on: the page, the card, the info badge's tint over each, a hovered badge's tint. */
function grounds(p: Palette, dark: boolean): string[] {
  const tint = dark ? 0.18 : 0.11;
  return [p.background, p.surface, mixHex(p.surface, p.primary, tint), mixHex(p.background, p.primary, tint), mixOklab(p.surface, p.primary, 0.1)];
}

function worst(ink: string, p: Palette, dark: boolean): number {
  return Math.min(...grounds(p, dark).map(ground => contrastRatio(ink, ground) ?? 0));
}

describe("--accent-strong", () => {
  it("reads on the info badge's tint in the default dark palette (was #5383C9, 2.9:1 on #313C4A)", () => {
    const ink = brandingVariables(DEFAULT_BRANDING, "dark")["--accent-strong"]!;
    assert.match(ink, /^#[0-9A-F]{6}$/, `a derived colour, got ${ink}`);
    assert.equal(mixHex(DEFAULT_DARK.surface, DEFAULT_DARK.primary, 0.18), "#313C4A");
    assert.ok(worst(ink, DEFAULT_DARK, true) >= 4.5, `${ink}: ${worst(ink, DEFAULT_DARK, true).toFixed(2)}:1`);
  });

  it("keeps the theme's own ink when it already reads (the default light palette)", () => {
    assert.equal(accentStrong(DEFAULT_LIGHT, false), null);
    assert.equal(brandingVariables(DEFAULT_BRANDING, "light")["--accent-strong"], "color-mix(in oklab, #1F5FB8 78%, #353432)");
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
