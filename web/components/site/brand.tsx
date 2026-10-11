/**
 * The Silicon Accounts mark on the public pages: the bare glyph (a rounded square beside a circle) in ink beside the
 * wordmark, as Silicon Writings and Silicon Apps draw theirs. The same drawing as the account shell's
 * (components/foundation/shell/brand-mark.tsx), app/icon.svg and the PNG icons. Plain SVG, server-rendered.
 */
import { AccountsGlyph } from "@/components/foundation/shell/brand-mark";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true">
      <AccountsGlyph />
    </span>
  );
}
