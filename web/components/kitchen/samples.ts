/**
 * Sample data for the style guide. Nothing here reaches the API: names, ids and logos are made up, logos and
 * portraits are inline SVG so the page renders offline and in screenshot runs.
 */

/** A squircle app logo with one glyph (data URI). */
export function appLogo(hue: number, glyph: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M32 0C55.3 0 64 8.7 64 32S55.3 64 32 64 0 55.3 0 32 8.7 0 32 0Z" fill="hsl(${hue} 52% 42%)"/><text x="32" y="41" font-family="Georgia,serif" font-size="26" text-anchor="middle" fill="#fff">${glyph}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** A soft portrait with initials (data URI). */
export function portrait(name: string, hue = 212): string {
  const initials = name.split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase() ?? "").join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 46% 74%)"/><stop offset="1" stop-color="hsl(${hue + 28} 42% 58%)"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><text x="48" y="60" font-family="Georgia, serif" font-size="38" text-anchor="middle" fill="#FFFDF9">${initials}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const SAMPLE_APPS = [
  { app_id: "briefcase", name: "Briefcase", logo: appLogo(214, "B") },
  { app_id: "dm", name: "DM", logo: appLogo(160, "D") },
  { app_id: "commit", name: "Commit", logo: appLogo(256, "C") },
  { app_id: "remind", name: "Remind", logo: appLogo(36, "R") },
  { app_id: "waveform", name: "Waveform", logo: appLogo(12, "W") },
  { app_id: "interface", name: "Silicon Interface", logo: appLogo(220, "I") },
];

/** A fixed "now" (Oct 6, 2026, 09:41 UTC) so relative times read the same in every run. */
export const SAMPLE_NOW = Date.UTC(2026, 9, 6, 9, 41);
export const HOUR = 3_600_000;
