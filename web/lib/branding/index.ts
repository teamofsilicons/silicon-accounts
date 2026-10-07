/**
 * The branding runtime for hosted sign-in pages (the developer site copies it for its previews). Framework-free pieces here;
 * the React components (BrandingScope, BrandStage, BrandAside, BrandPanel, PoweredBy) are in
 * components/foundation/branding. See web/README.md, "Branding runtime".
 */
export { applyBranding, brandingVariables, brandingAttributes, brandLogo, resolveBrandTheme, type PaintTheme } from "./apply";
export {
  DEFAULT_BRANDING, DEFAULT_COPY, DEFAULT_LIGHT, DEFAULT_DARK, BRAND_FONTS, THEME_MODES, CORNER_STYLES, BUTTON_STYLES, LAYOUTS,
  BACKGROUND_STYLES, DENSITIES, PALETTE_KEYS, LIMITS, normalizeBranding, normalizeCopy,
} from "./defaults";
export { FONT_STACKS, loadBrandFont, loadBrandingFonts } from "./fonts";
export { contrastRatio, formatRatio, wcagLevel, brandingContrastIssues, parseHex, luminance, mixHex, readableOn, type ContrastIssue } from "./contrast";
