/**
 * A fenced code block in the docs: Arc's code-block anatomy (a squircle panel, a header with the language and a copy
 * button, the source in the monospace face, the same colour roles in both themes), highlighted on the server by
 * lib/docs/highlight.ts so the page ships plain spans. Blocks longer than LONG_LINES lines scroll inside a capped
 * height until "Show all" opens them (find-in-page still reaches every line).
 *
 * Everything here is server-rendered HTML. The copy and "Show all" buttons are wired by the docs' one script island
 * (docs-enhancer.tsx) through their data attributes; without script they stay hidden ([data-js-only]).
 *
 * A fence can name its block: ```sh title="Start the stack"```.
 */
import { ChevronDown, Copy, Check } from "lucide-react";
import { highlight, languageLabel } from "@/lib/docs/highlight";
import copyStyles from "@/components/silicon-ui/copy-button/copy-button.module.css";
import styles from "./code-block.module.css";

const LONG_LINES = 30;

function titleFrom(meta: string): string | null {
  const match = /(?:^|\s)(?:title|file|filename)=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() || null : null;
}

/** Arc's icon-only copy button, as markup: the island swaps data-state between idle and copied. */
export function CopyCode({ label }: { label: string }) {
  return (
    <button type="button" className={`${copyStyles.button} ${copyStyles.iconOnly} ${copyStyles.plain} ${styles.copy}`} data-copy="" data-js-only="" data-state="idle" aria-label={label} data-label={label}>
      <span className={styles.copyIcon} aria-hidden="true">
        <Copy size={16} strokeWidth={1.75} data-icon="idle" />
        <Check size={16} strokeWidth={1.75} data-icon="copied" />
      </span>
    </button>
  );
}

export function CodeBlock({ code, lang, meta = "" }: { code: string; lang: string; meta?: string }) {
  const tokens = highlight(code, lang);
  const lines = code.split("\n").length;
  const long = lines > LONG_LINES;
  const label = languageLabel(lang);
  const title = titleFrom(meta);
  return (
    <figure className={styles.block} data-sq="clip" data-long={long ? "" : undefined} data-docs-code="">
      <figcaption className={styles.header}>
        <span className={styles.label}>
          {title ? <span className={styles.title}>{title}</span> : null}
          <span className={title ? styles.language : styles.languageOnly}>{label}</span>
        </span>
        <CopyCode label={title ? `Copy ${title}` : `Copy ${label === "Text" || label === "Output" ? "text" : `${label} code`}`} />
      </figcaption>
      <pre className={styles.pre} tabIndex={0} aria-label={title ?? `${label} code`} data-lang={lang || undefined}>
        <code>
          {tokens.map((token, index) => (token.k ? <span key={index} className={styles[token.k]}>{token.v}</span> : token.v))}
        </code>
      </pre>
      {long ? (
        <button type="button" className={styles.expand} data-code-expand="" data-js-only="" aria-expanded="false" data-more={`Show all ${lines} lines`} data-less="Show fewer lines">
          <span data-expand-label="">Show all {lines} lines</span>
          <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" className={styles.chevron} />
        </button>
      ) : null}
    </figure>
  );
}
