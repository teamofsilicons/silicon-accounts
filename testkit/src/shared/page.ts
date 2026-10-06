// Minimal HTML shell for the testkit's own pages (mock provider screens, fake app pages).
// Pages are plain server-rendered HTML so Playwright and Carbons can drive them without JS.

import { escapeHtml } from './util.ts';

export interface PageOptions {
  title: string;
  body: string;
  /** Accent colour (#RRGGBB) used for buttons and links. */
  accent?: string;
  /** Extra <head> markup (trusted, built by the caller). */
  head?: string;
  /** Extra CSS appended after the base stylesheet. */
  css?: string;
  bodyAttributes?: string;
}

const BASE_CSS = `
:root { color-scheme: light; --accent: #1F5FB8; --fg: #353432; --muted: #6F6B66; --border: #E8E3DA; --bg: #FFFDF9; --surface: #FFFFFF; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 880px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; font-weight: 600; margin: 0 0 4px; }
h2 { font-size: 17px; font-weight: 600; margin: 0 0 8px; }
p { margin: 0 0 12px; }
a { color: var(--accent); }
.muted { color: var(--muted); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 20px; margin: 16px 0; }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.stack > * + * { margin-top: 8px; }
button, .button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; padding: 8px 16px; border-radius: 12px; border: 1px solid var(--accent); background: var(--accent); color: #fff; font: inherit; font-weight: 500; text-decoration: none; cursor: pointer; }
button.secondary, .button.secondary { background: transparent; color: var(--accent); }
button.ghost { background: transparent; color: var(--muted); border-color: var(--border); }
input[type=text], input[type=email] { min-height: 40px; padding: 8px 12px; border-radius: 10px; border: 1px solid var(--border); font: inherit; min-width: 0; }
pre, code { font-family: ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace; font-size: 13px; }
pre { background: #F6F3EE; border: 1px solid var(--border); border-radius: 12px; padding: 12px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); font-size: 12px; color: var(--muted); }
.error { border-color: #F4C7C3; background: #FEF3F2; }
.error h1, .error h2 { color: #B42318; }
img.logo { width: 40px; height: 40px; border-radius: 10px; }
@media (max-width: 480px) { main { padding: 20px 16px 48px; } }
`;

export function page(options: PageOptions): string {
  const accent = options.accent && /^#[0-9A-Fa-f]{6}$/.test(options.accent) ? options.accent : '#1F5FB8';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(options.title)}</title>
<style>${BASE_CSS}:root { --accent: ${accent}; }${options.css ?? ''}</style>
${options.head ?? ''}
</head>
<body${options.bodyAttributes ? ` ${options.bodyAttributes}` : ''}>
${options.body}
</body>
</html>
`;
}

/** Pretty JSON safe to drop inside <pre>…</pre>: the text content parses back with JSON.parse. */
export function jsonPre(id: string, value: unknown): string {
  return `<pre id="${escapeHtml(id)}">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}
