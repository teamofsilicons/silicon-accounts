/**
 * The branding editor's defaults and the previews (lib/branding): the Silicon look, the same as the API gives new apps
 * (crates/core signin_config.rs default_light, default_dark) and the hosted pages paint (web/lib/branding/defaults.ts).
 * Apps that kept the older warm defaults show in the new look, and any colour of an app's own stays. Run with `pnpm test`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BRANDING, DEFAULT_DARK, DEFAULT_LIGHT, LEGACY_DARK, LEGACY_LIGHT, isSiliconLook, normalizeBranding } from "../lib/branding/defaults";
import { contrastRatio } from "../lib/branding/contrast";
import { normalizeConfig } from "../components/developer/lib/config";

test("the defaults are the Silicon look: #F7F8FA, #292929 and #1F5FB8 in light; #02040A, #F7F8FA and #1F5FB8 in dark", () => {
  assert.deepEqual(DEFAULT_LIGHT, { primary: "#1F5FB8", primary_foreground: "#FFFFFF", background: "#F7F8FA", surface: "#FFFFFF", foreground: "#292929", muted: "#5C6370", border: "#E2E5EB", danger: "#B42318" });
  assert.deepEqual(DEFAULT_DARK, { primary: "#1F5FB8", primary_foreground: "#F7F8FA", background: "#02040A", surface: "#0B0F18", foreground: "#F7F8FA", muted: "#9BA4B4", border: "#1F2635", danger: "#FF8A80" });
  assert.equal(DEFAULT_BRANDING.light, DEFAULT_LIGHT);
  assert.equal(DEFAULT_BRANDING.dark, DEFAULT_DARK);
  for (const p of [DEFAULT_LIGHT, DEFAULT_DARK]) {
    for (const [fg, bg] of [[p.primary_foreground, p.primary], [p.foreground, p.background], [p.foreground, p.surface], [p.muted, p.surface], [p.muted, p.background], [p.danger, p.surface]] as const) {
      assert.ok((contrastRatio(fg, bg) ?? 0) >= 4.5, `${fg} on ${bg}`);
    }
  }
  assert.equal(isSiliconLook(DEFAULT_BRANDING), true);
});

test("an app that kept the older warm defaults is edited and previewed in the new look; its own colours stay", () => {
  const legacy = normalizeBranding({ light: LEGACY_LIGHT, dark: LEGACY_DARK });
  assert.deepEqual(legacy.light, DEFAULT_LIGHT);
  assert.deepEqual(legacy.dark, DEFAULT_DARK);
  const own = normalizeBranding({ light: { ...LEGACY_LIGHT, primary: "#17775C" }, dark: LEGACY_DARK });
  assert.deepEqual(own.light, { ...LEGACY_LIGHT, primary: "#17775C" });
  assert.equal(isSiliconLook(own), false);
  const editor = normalizeConfig({ branding: { ...DEFAULT_BRANDING, light: LEGACY_LIGHT, dark: LEGACY_DARK } });
  assert.deepEqual(editor.branding.light, DEFAULT_LIGHT, "the editor's colour fields show what the hosted pages paint");
  assert.deepEqual(normalizeConfig(null).branding.light, DEFAULT_LIGHT, "a new app's editor starts from the Silicon look");
});
