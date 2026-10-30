/**
 * A Silicon's mark, as the prototype draws every Silicon: a rounded square in the Silicon's own gradient (one of four
 * pairs, picked from its uuid so it never changes) with a white spark (filled, as drawn). `pending` adds the dashed outline of a Silicon
 * still waiting for its custodian.
 */
import type { CSSProperties } from "react";
import { Sparkle } from "lucide-react";
import styles from "./parts.module.css";

const PAIRS = 4;

function pairOf(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return (hash % PAIRS) + 1;
}

export function SiliconMark({ seed, size = 32, pending, className }: { seed: string; size?: number; pending?: boolean; className?: string }) {
  const pair = pairOf(seed);
  const style = { "--mark-size": `${size}px`, "--mark-from": `var(--silicon-mark-${pair}-from)`, "--mark-to": `var(--silicon-mark-${pair}-to)` } as CSSProperties;
  return (
    <span className={[styles.siliconMark, className].filter(Boolean).join(" ")} style={style} data-pending={pending ? "" : undefined} aria-hidden="true">
      <Sparkle fill="currentColor" strokeWidth={1} />
    </span>
  );
}
