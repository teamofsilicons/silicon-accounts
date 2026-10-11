/**
 * The developer site's mark: "</>", for building (the Carbon's drawing, 2026-10-11). The header draws the bare glyph in
 * ink beside the wordmark, as Silicon Writings, Silicon Apps and Silicon Accounts draw theirs; the icons
 * (public/icon.svg and the PNGs) draw it in #181818 on a cream square, like the family's other icons. Plain SVG
 * (server-rendered, no script), shared by the public header and the signed-in shell
 * (components/foundation/shell/brand-mark.tsx).
 */
export const GLYPH = "M43.516 105.588V99.792L77.116 114.156V125.412L38.98 108.108V97.272L77.116 79.968V91.224L43.516 105.588ZM84.1366 136.08L104.129 65.352H115.301L95.2246 136.08H84.1366ZM155.925 105.588L122.409 91.224V79.968L160.545 97.272V108.108L122.409 125.412V114.156L155.925 99.792V105.588Z";

/** The glyph alone, in currentColor, cropped to its own bounds (122 × 71). */
export function BrandGlyph() {
  return (
    <svg viewBox="38.5 65 122.5 71.5" fill="currentColor" aria-hidden="true" focusable="false">
      <path d={GLYPH} />
    </svg>
  );
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <BrandGlyph />
    </span>
  );
}
