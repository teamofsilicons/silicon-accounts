"use client";

/**
 * The client half of a docs code block: Arc's copy button, and "Show all N lines" for long blocks (it opens the block
 * in place by setting data-open on the block, which lifts the height cap; the code itself stays server-rendered).
 */
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { CopyButton } from "@/components/silicon-ui/copy-button/copy-button";
import styles from "./code-block.module.css";

export function CodeActions({ code, label }: { code: string; label: string }) {
  return <CopyButton value={code} label={label} iconOnly variant="plain" className={styles.copy} />;
}

export function CodeExpand({ lines }: { lines: number }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className={styles.expand}
      aria-expanded={open}
      onClick={event => {
        const block = event.currentTarget.closest("[data-docs-code]");
        const next = !open;
        setOpen(next);
        if (block instanceof HTMLElement) {
          if (next) block.setAttribute("data-open", "");
          else {
            block.removeAttribute("data-open");
            // Collapsing a block taller than the screen keeps its header in view.
            if (block.getBoundingClientRect().top < 0) block.scrollIntoView({ block: "start" });
          }
        }
      }}
    >
      <span>{open ? "Show fewer lines" : `Show all ${lines} lines`}</span>
      <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" className={styles.chevron} data-open={open ? "" : undefined} />
    </button>
  );
}
