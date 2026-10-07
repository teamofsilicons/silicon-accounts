/**
 * A fenced code block in the docs: Arc's code-block anatomy (a squircle panel, a header with the language and Arc's
 * copy button, the source in JetBrains Mono, the same colour roles in both themes), highlighted on the server by
 * lib/docs/highlight.ts so the page ships plain spans. Blocks longer than LONG_LINES lines scroll inside a capped
 * height until "Show all" opens them (find-in-page still reaches every line).
 *
 * A fence can name its block: ```sh title="Start the stack"```.
 */
import { highlight, languageLabel } from "@/lib/docs/highlight";
import { CodeActions, CodeExpand } from "./code-actions";
import styles from "./code-block.module.css";

const LONG_LINES = 30;

function titleFrom(meta: string): string | null {
  const match = /(?:^|\s)(?:title|file|filename)=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() || null : null;
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
        <CodeActions code={code} label={title ? `Copy ${title}` : `Copy ${label === "Text" || label === "Output" ? "text" : `${label} code`}`} />
      </figcaption>
      <pre className={styles.pre} tabIndex={0} aria-label={title ?? `${label} code`} data-lang={lang || undefined}>
        <code>
          {tokens.map((token, index) => (token.k ? <span key={index} className={styles[token.k]}>{token.v}</span> : token.v))}
        </code>
      </pre>
      {long ? <CodeExpand lines={lines} /> : null}
    </figure>
  );
}
