/**
 * The branding runtime for hosted sign-in pages (and the developer area's live preview):
 *   applyBranding(el, branding, theme) paints an app's Branding onto one subtree; BrandingScope does it declaratively;
 *   branding.css provides the layout (card/split/minimal) and background (plain/dots/grain/gradient/image) classes;
 *   PoweredBy renders the footer no app can remove. See web/README.md.
 */
export { applyBranding, brandingVariables, brandingAttributes, brandLogo, resolveBrandTheme, type PaintTheme } from "./apply";
export { BrandingScope, BrandStage, BrandAside, BrandPanel, PoweredBy, POWERED_BY_HREF, type BrandingScopeProps, type PoweredByProps } from "./BrandingScope";
export {
  DEFAULT_BRANDING, DEFAULT_COPY, DEFAULT_LIGHT, DEFAULT_DARK, BRAND_FONTS, THEME_MODES, CORNER_STYLES, BUTTON_STYLES, LAYOUTS,
  BACKGROUND_STYLES, DENSITIES, PALETTE_KEYS, LIMITS, normalizeBranding, normalizeCopy,
} from "./defaults";
export { FONT_STACKS, loadBrandFont, loadBrandingFonts } from "./fonts";
export { contrastRatio, formatRatio, wcagLevel, brandingContrastIssues, parseHex, luminance, mixHex, readableOn, type ContrastIssue } from "./contrast";
