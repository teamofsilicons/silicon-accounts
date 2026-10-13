/**
 * The developer site's mark: a circle, a triangle and a square stacked, for building (the Carbon's drawing, 2026-10-13).
 * The header draws the bare glyph in ink beside the wordmark, as Silicon Writings, Silicon Apps and Silicon Accounts draw theirs; the icons
 * (the PNGs, the Open Graph image) draw it in #181818 on a cream square, like the family's other icons; the browser-tab
 * icon (public/icon.svg) is the glyph alone, ink on a light browser and cream on a dark one. Plain SVG
 * (server-rendered, no script), shared by the public header and the signed-in shell
 * (components/foundation/shell/brand-mark.tsx).
 */
export const GLYPH = {
  circle: { cx: 99, cy: 52, r: 20 },
  triangle: "M104.222 73.8965C104.485 72.3795 106.291 71.7158 107.473 72.7019L138.733 98.7714C139.915 99.7575 139.586 101.654 138.141 102.185L99.9349 116.221C98.4897 116.752 97.0118 115.519 97.2745 114.002L104.222 73.8965Z",
  square: { x: 80, y: 117, width: 40, height: 40, rx: 2 },
};

/** The glyph alone, in currentColor, cropped to its own bounds (61 × 125). */
export function BrandGlyph() {
  return (
    <svg viewBox="78.5 31.5 62 126" fill="currentColor" aria-hidden="true" focusable="false">
      <circle {...GLYPH.circle} />
      <path d={GLYPH.triangle} />
      <rect {...GLYPH.square} />
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
