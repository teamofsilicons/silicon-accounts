// Hand-made SVG marks for the fake apps. Each mark is a 64×64 squircle tile with a
// stroke glyph; the dark variant lifts the tile colour so it stays visible on dark
// surfaces. Emitted as base64 data: URIs so no external image host is needed.

interface MarkSpec {
  /** Tile colour on light surfaces. */
  bg: string;
  /** Tile colour on dark surfaces. */
  darkBg: string;
  /** Glyph colour. */
  fg: string;
  /** Optional second glyph colour. */
  accent?: string;
  /** Glyph markup; `{fg}` and `{accent}` are substituted. */
  glyph: string;
}

const SQUIRCLE = 'M32 0C55.3 0 64 8.7 64 32S55.3 64 32 64 0 55.3 0 32 8.7 0 32 0Z';

const MARKS: Record<string, MarkSpec> = {
  briefcase: {
    bg: '#2F4B7C',
    darkBg: '#3D5F99',
    fg: '#FFFDF9',
    glyph: `<g fill="none" stroke="{fg}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><rect x="15" y="23" width="34" height="24" rx="5"/><path d="M26 23v-3.5a3.5 3.5 0 0 1 3.5-3.5h5a3.5 3.5 0 0 1 3.5 3.5V23"/><path d="M15 33h34"/><path d="M29 33v3.5h6V33"/></g>`,
  },
  dm: {
    bg: '#17775C',
    darkBg: '#1F9472',
    fg: '#FFFDF9',
    glyph: `<path d="M19 19h26a5 5 0 0 1 5 5v13a5 5 0 0 1-5 5H31l-8 6.5V42h-4a5 5 0 0 1-5-5V24a5 5 0 0 1 5-5z" fill="none" stroke="{fg}" stroke-width="3.5" stroke-linejoin="round"/><g fill="{fg}"><circle cx="25" cy="30.5" r="2.2"/><circle cx="32" cy="30.5" r="2.2"/><circle cx="39" cy="30.5" r="2.2"/></g>`,
  },
  commit: {
    bg: '#5B4BD5',
    darkBg: '#6D5EE0',
    fg: '#FFFDF9',
    glyph: `<g fill="none" stroke="{fg}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><rect x="16" y="16" width="32" height="32" rx="9"/><path d="M24 32.5l5.5 5.5L41 26.5"/></g>`,
  },
  waveform: {
    bg: '#C2410C',
    darkBg: '#DD5A1F',
    fg: '#FFFDF9',
    glyph: `<path d="M19 28v8M25.5 22v20M32 16v32M38.5 24v16M45 29v6" fill="none" stroke="{fg}" stroke-width="4" stroke-linecap="round"/>`,
  },
  remind: {
    bg: '#A16207',
    darkBg: '#B9770E',
    fg: '#FFFDF9',
    glyph: `<g fill="none" stroke="{fg}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 41V31a10 10 0 0 1 20 0v10l3.5 4h-27z"/><path d="M28.5 48.5a3.5 3.5 0 0 0 7 0"/><path d="M32 16.5v4.5"/></g>`,
  },
  browser: {
    bg: '#0E7490',
    darkBg: '#1489A8',
    fg: '#FFFDF9',
    glyph: `<g fill="none" stroke="{fg}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><rect x="13" y="17" width="38" height="30" rx="5"/><path d="M13 26h38"/></g><g fill="{fg}"><circle cx="19" cy="21.5" r="1.6"/><circle cx="24.5" cy="21.5" r="1.6"/><circle cx="30" cy="21.5" r="1.6"/><path d="M30 31l12 4.5-5.2 1.9-1.9 5.2z"/></g>`,
  },
  spacestation: {
    bg: '#111827',
    darkBg: '#3B4A63',
    fg: '#E5E7EB',
    accent: '#60A5FA',
    glyph: `<g fill="none" stroke="{accent}" stroke-width="2.6" stroke-linejoin="round"><rect x="11" y="23" width="12" height="18" rx="1.5"/><rect x="41" y="23" width="12" height="18" rx="1.5"/><path d="M11 32h12M41 32h12M17 23v18M47 23v18"/></g><g fill="none" stroke="{fg}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M23 32h18"/><rect x="27" y="26" width="10" height="12" rx="2.5" fill="{fg}"/><path d="M32 26v-7"/></g><circle cx="32" cy="17.5" r="2.4" fill="{fg}"/>`,
  },
  interface: {
    bg: '#353432',
    darkBg: '#5A5753',
    fg: '#FFFDF9',
    accent: '#5B8FE0',
    glyph: `<path d="M19 23l10 9-10 9" fill="none" stroke="{fg}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><path d="M34 42h12" fill="none" stroke="{accent}" stroke-width="4" stroke-linecap="round"/>`,
  },
  'acme-notes': {
    bg: '#1A1714',
    darkBg: '#4A3F33',
    fg: '#E8B04B',
    glyph: `<g fill="none" stroke="{fg}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14h17l9 9v27H20z"/><path d="M37 14v9h9"/><path d="M25.5 31h15M25.5 37h15M25.5 43h9"/></g>`,
  },
  'pixel-studio': {
    bg: '#E5007E',
    darkBg: '#FF2B98',
    fg: '#FFFFFF',
    glyph: `<g fill="{fg}"><rect x="17" y="17" width="7" height="7"/><rect x="25" y="17" width="7" height="7"/><rect x="33" y="17" width="7" height="7"/><rect x="17" y="25" width="7" height="7"/><rect x="41" y="25" width="7" height="7"/><rect x="17" y="33" width="7" height="7"/><rect x="25" y="33" width="7" height="7"/><rect x="33" y="33" width="7" height="7"/><rect x="17" y="41" width="7" height="7"/></g>`,
  },
  ledgerly: {
    bg: '#14532D',
    darkBg: '#1C6B3B',
    fg: '#ECFDF5',
    glyph: `<g fill="none" stroke="{fg}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 47h32"/><rect x="19" y="34" width="6.5" height="8.5" rx="1.5"/><rect x="28.75" y="26.5" width="6.5" height="16" rx="1.5"/><rect x="38.5" y="18" width="6.5" height="24.5" rx="1.5"/></g>`,
  },
  'campus-connect': {
    bg: '#7C2D12',
    darkBg: '#9A3A18',
    fg: '#FFF7ED',
    glyph: `<g fill="none" stroke="{fg}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11 27l21-9.5L53 27l-21 9.5z"/><path d="M20.5 31.5v8c0 3.3 5.1 6.5 11.5 6.5s11.5-3.2 11.5-6.5v-8"/><path d="M50 28.5v10"/></g>`,
  },
  'legacy-crm': {
    bg: '#475569',
    darkBg: '#5B6B82',
    fg: '#F8FAFC',
    glyph: `<g fill="none" stroke="{fg}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><rect x="13" y="18" width="38" height="28" rx="4.5"/><circle cx="25" cy="29.5" r="4.2"/><path d="M18.5 40.5c1.2-3.6 3.6-5.4 6.5-5.4s5.3 1.8 6.5 5.4"/><path d="M37 28h9M37 33h9M37 38h6"/></g>`,
  },
  'orbit-games': {
    bg: '#312E81',
    darkBg: '#433FA8',
    fg: '#C7D2FE',
    accent: '#22D3EE',
    glyph: `<circle cx="32" cy="32" r="10.5" fill="{fg}"/><ellipse cx="32" cy="32" rx="21" ry="6.8" transform="rotate(-20 32 32)" fill="none" stroke="{accent}" stroke-width="3"/><circle cx="48" cy="17.5" r="2.2" fill="{accent}"/><circle cx="17" cy="47" r="1.5" fill="{fg}"/>`,
  },
  'quill-docs': {
    bg: '#3B1D6E',
    darkBg: '#4F2A8F',
    fg: '#FBBF24',
    glyph: `<g fill="none" stroke="{fg}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M47 15c-12.5 1.5-21 9.5-25 22l-2.5 8.5 8.5-2.5c12.5-4 20.5-12.5 22-25z"/><path d="M17 49l17-17"/><path d="M29.5 29.5h7.5"/></g>`,
  },
};

export type LogoVariant = 'light' | 'dark';

export function logoSvg(appId: string, variant: LogoVariant = 'light'): string {
  const spec = MARKS[appId];
  if (!spec) throw new Error(`No logo is designed for fake app "${appId}".`);
  const glyph = spec.glyph.replaceAll('{fg}', spec.fg).replaceAll('{accent}', spec.accent ?? spec.fg);
  const bg = variant === 'dark' ? spec.darkBg : spec.bg;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><path d="${SQUIRCLE}" fill="${bg}"/>${glyph}</svg>`;
}

export function logoDataUri(appId: string, variant: LogoVariant = 'light'): string {
  return `data:image/svg+xml;base64,${Buffer.from(logoSvg(appId, variant), 'utf8').toString('base64')}`;
}

export function hasLogo(appId: string): boolean {
  return appId in MARKS;
}
