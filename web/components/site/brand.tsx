/**
 * The Silicon Accounts mark: a brand-blue squircle with a person, the same glyph as the account shell's
 * (components/foundation/shell/brand-mark.tsx), the favicon and "Powered by". Plain SVG, server-rendered.
 */
export function BrandGlyph() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <circle cx="32" cy="24" r="9" fill="currentColor" />
      <path fill="currentColor" d="M14 50c2.7-8.4 9.6-13.2 18-13.2S47.3 41.6 50 50c-4.8 3.2-10.9 4.9-18 4.9S18.8 53.2 14 50Z" />
    </svg>
  );
}

export function BrandMark({ className }: { className?: string }) {
  return (
    <span data-sq="clip" className={className} aria-hidden="true">
      <BrandGlyph />
    </span>
  );
}
