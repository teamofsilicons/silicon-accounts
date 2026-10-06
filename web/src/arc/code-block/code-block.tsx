import { ChevronDown, FileCode2 } from "lucide-solid";
import { For, Show, createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, onMount, untrack, type JSX } from "solid-js";
import { CopyButton } from "../copy-button/copy-button";
import { Swap, SwapText } from "../lib/presence";
import { animate, instant, motionTokens, prefersReducedMotion, spring, tween } from "../lib/motion";
import { cx } from "../lib/cx";
import { useSquircle } from "../lib/squircle";
import styles from "./code-block.module.css";

export interface CodeBlockProps {
  /** Source shown in the block and copied by the action. */
  code: string;
  /** File name or title displayed in the header. */
  filename?: string;
  /** Header label and lightweight syntax highlighting: ts, tsx, js, json, html, css, bash, http, sql. */
  language?: string;
  /** Collapse longer sources to this many lines, with a toggle that expands the rest in place. */
  maxLines?: number;
  /** Label for the copy action. Defaults to "Copy code". */
  copyLabel?: string;
  /** Wrap long lines instead of scrolling sideways. */
  wrap?: boolean;
  class?: string;
}

type TokenKind = "comment" | "string" | "number" | "keyword" | "type" | "function" | "property" | "tag" | "punctuation";

const keywordPattern = /^(?:abstract|as|async|await|break|case|catch|class|const|continue|default|delete|do|else|enum|export|extends|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|of|private|protected|public|readonly|return|set|static|switch|throw|try|type|typeof|var|void|while|with|yield|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|GET|POST|PUT|PATCH)$/;
const literalPattern = /^(?:true|false|null|undefined|NaN|Infinity)$/;
const typePattern = /^(?:Array|Boolean|Date|Error|Map|Number|Promise|Record|Set|String|HTMLElement|HTMLButtonElement|Event|unknown|never|void|any|boolean|number|string|object)$/;
const tokenPattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$-]*\b|[{}[\]();,.<>:=+*/!?|&-]/g;
const shellPattern = /#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?<=\s)--?[A-Za-z][\w-]*|\$[A-Za-z_]\w*|\b\d+(?:\.\d+)?\b|[A-Za-z_][\w./:-]*|[|&;<>\\]/g;

function normaliseLanguage(language: string) {
  const value = language.toLowerCase().replace(/^\./, "");
  return value === "sh" || value === "shell" || value === "zsh" ? "bash" : value;
}

function tokenKind(value: string, source: string, index: number, language: string): TokenKind | undefined {
  if (language === "bash") {
    if (value.startsWith("#")) return "comment";
    if (value.startsWith("\"") || value.startsWith("'")) return "string";
    if (value.startsWith("-")) return "property";
    if (value.startsWith("$")) return "type";
    if (/^\d/.test(value)) return "number";
    if (/^[|&;<>\\]$/.test(value)) return "punctuation";
    // The first word of a line (or after a pipe) is the command.
    const before = source.slice(0, index);
    if (/(^|\n|[|;&]\s*)\s*$/.test(before)) return "function";
    return undefined;
  }
  if (value.startsWith("//") || value.startsWith("/*") || value.startsWith("<!--")) return "comment";
  if (value.startsWith("\"") || value.startsWith("'") || value.startsWith("`")) {
    return language === "json" && /^\s*:/.test(source.slice(index + value.length)) ? "property" : "string";
  }
  if (/^\d/.test(value)) return "number";
  if (keywordPattern.test(value) || literalPattern.test(value)) return "keyword";
  if (typePattern.test(value)) return "type";
  if (/^[{}[\]();,.<>:=+*/!?|&-]$/.test(value)) return "punctuation";
  const before = source.slice(0, index);
  const after = source.slice(index + value.length);
  if ((language === "tsx" || language === "jsx" || language === "html") && /<\/?$/.test(before)) return "tag";
  if (/^\s*\(/.test(after) && language !== "json") return "function";
  if ((language === "css" || language === "tsx" || language === "jsx" || language === "html") && /^\s*[:=]/.test(after)) return "property";
  return undefined;
}

/** Splits source into plain runs and classed tokens. Colour supports the text; it never replaces it. */
export function highlight(code: string, language: string): Array<{ text: string; kind?: TokenKind }> {
  const parts: Array<{ text: string; kind?: TokenKind }> = [];
  let cursor = 0;
  const pattern = language === "bash" ? shellPattern : tokenPattern;
  for (const match of code.matchAll(pattern)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (cursor < index) parts.push({ text: code.slice(cursor, index) });
    parts.push({ text: value, kind: tokenKind(value, code, index, language) });
    cursor = index + value.length;
  }
  if (cursor < code.length) parts.push({ text: code.slice(cursor) });
  return parts;
}

/**
 * Arc CodeBlock: a file header with a copy action over lightly highlighted source. Longer sources collapse to
 * `maxLines` with a toggle that expands the rest in place; the source area follows its content on a spring.
 */
export function CodeBlock(props: CodeBlockProps) {
  const language = () => normaliseLanguage(props.language ?? "tsx");
  const preId = `code-${createUniqueId()}`;
  const lineCount = () => props.code.split("\n").length;
  const collapsible = () => props.maxLines != null && props.maxLines > 0 && lineCount() > props.maxLines;
  const [expanded, setExpanded] = createSignal(false);
  const open = () => !collapsible() || expanded();
  const tokens = createMemo(() => highlight(props.code, language()));
  let pre: HTMLPreElement | undefined;
  let viewport: HTMLDivElement | undefined;
  let sizes: { full: number; collapsed: number } | null = null;

  const settle = (immediate: boolean) => {
    if (!sizes || !viewport) return;
    const next = open() ? sizes.full : sizes.collapsed;
    if (immediate || prefersReducedMotion()) { viewport.style.height = `${next}px`; return; }
    animate(viewport, { height: `${next}px` }, spring.smooth);
  };
  onMount(() => {
    if (!pre || typeof ResizeObserver === "undefined") return;
    const node = pre;
    const observer = new ResizeObserver(() => {
      const style = getComputedStyle(node);
      const full = node.offsetHeight;
      const lines = props.maxLines;
      const collapsed = lines ? Math.min(full, Math.round(lines * parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom))) : full;
      const first = !sizes;
      sizes = { full, collapsed };
      settle(first);
    });
    observer.observe(node);
    onCleanup(() => observer.disconnect());
  });
  createEffect(on(open, () => settle(false), { defer: true }));

  const labels = () => [`Show all ${lineCount()} lines`, "Show fewer lines"] as const;
  let chevron: HTMLSpanElement | undefined;
  createEffect(on(expanded, (value, before) => {
    if (chevron) animate(chevron, { rotate: value ? 180 : 0 }, before === undefined || prefersReducedMotion() ? instant : spring.snappy);
  }));

  return (
    <section
      ref={el => useSquircle(el)}
      class={cx(styles.block, props.wrap && styles.wrap, props.class)}
      aria-label={props.filename ? `${props.filename} source code` : `${language()} source code`}
      style={props.maxLines ? { "--code-lines": String(props.maxLines) } : undefined}
    >
      <header class={styles.header}>
        <div class={styles.file}>
          <FileCode2 size={16} stroke-width={1.75} aria-hidden="true" />
          <span class={styles.filename}><SwapText text={props.filename ?? "Source code"} class={styles.swapText} /></span>
          <span class={styles.language}>{language()}</span>
        </div>
        <CopyButton value={props.code} label={props.copyLabel ?? "Copy code"} size="xs" />
      </header>
      <div ref={viewport} class={styles.viewport} style={untrack(() => (open() ? undefined : { height: "var(--code-collapsed)" }))}>
        <pre ref={pre} id={preId} class={styles.pre} tabIndex={0} aria-label="Selectable source code">
          <Swap
            value={props.code}
            as="span"
            class={styles.code}
            enter={el => (prefersReducedMotion() ? undefined : animate(el, { opacity: [0, 1], y: [4, 0] }, tween(motionTokens.duration.standard, motionTokens.ease.enter)))}
            exit={el => animate(el, { opacity: 0 }, prefersReducedMotion() ? instant : tween(motionTokens.duration.instant))}
          >
            {() => <For each={tokens()}>{part => (part.kind ? <span class={styles[part.kind]}>{part.text}</span> : part.text)}</For>}
          </Swap>
        </pre>
      </div>
      <Show when={collapsible()}>
        <button type="button" class={styles.expand} aria-expanded={expanded()} aria-controls={preId} onClick={() => setExpanded(value => !value)}>
          <span class={styles.swap} aria-hidden="true">
            <For each={[...labels()]}>{text => <span class={styles.reserve}>{text}</span>}</For>
            <span class={styles.swapStack}><SwapText text={labels()[expanded() ? 1 : 0]} class={styles.swapText} /></span>
          </span>
          <span class={styles.srOnly}>{labels()[expanded() ? 1 : 0]}</span>
          <span ref={chevron} class={styles.chevron} aria-hidden="true"><ChevronDown size={16} stroke-width={1.75} /></span>
        </button>
      </Show>
    </section>
  );
}

/** Inline code for ids and values inside prose. */
export function InlineCode(props: { children: JSX.Element; class?: string }) {
  return <code class={cx(styles.inline, props.class)}>{props.children}</code>;
}

export default CodeBlock;
