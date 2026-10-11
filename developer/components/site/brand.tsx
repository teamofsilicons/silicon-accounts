/**
 * The developer site's mark: a pair of braces, for building. The header draws the bare glyph in ink beside the
 * wordmark, as Silicon Writings, Silicon Apps and Silicon Accounts draw theirs; the icons (public/icon.svg and the PNGs)
 * draw it in #181818 on a cream square, like the family's other icons. Plain SVG (server-rendered, no script), shared by
 * the public header and the signed-in shell (components/foundation/shell/brand-mark.tsx).
 */
export function BrandGlyph() {
  return (
    <svg viewBox="10 12 44 40" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M25 16c-5 0-7 2.5-7 7v4.5c0 2.5-1.5 4.5-4 4.5 2.5 0 4 2 4 4.5V41c0 4.5 2 7 7 7" />
      <path d="M39 16c5 0 7 2.5 7 7v4.5c0 2.5 1.5 4.5 4 4.5-2.5 0-4 2-4 4.5V41c0 4.5-2 7-7 7" />
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
