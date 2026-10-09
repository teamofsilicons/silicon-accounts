/**
 * /sitemap.xml: every public address of the account site with its last change: the landing page and the agent files
 * (llms.txt, llms-full.txt, the API's OpenAPI description). Account pages and sign-in pages are not pages to index.
 */
import { LLMS_FULL_TXT_MODIFIED, LLMS_TXT_MODIFIED } from "@/lib/agent/generated/llms";
import { CANONICAL_ORIGIN } from "@/lib/site";

interface Entry {
  path: string;
  modified: string | null;
  priority: number;
  changefreq: "daily" | "weekly" | "monthly";
}

const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** When the landing page last changed: the newer of its words' sources (the llms files are written with it). */
export const LANDING_MODIFIED = "2026-10-09T00:00:00.000Z";

const newest = (...dates: Array<string | null>) => dates.filter((date): date is string => Boolean(date)).sort().at(-1) ?? null;

export function sitemapEntries(): Entry[] {
  return [
    { path: "/", modified: newest(LANDING_MODIFIED, LLMS_TXT_MODIFIED), priority: 1, changefreq: "weekly" },
    { path: "/llms.txt", modified: LLMS_TXT_MODIFIED, priority: 0.6, changefreq: "weekly" },
    { path: "/llms-full.txt", modified: LLMS_FULL_TXT_MODIFIED ?? LLMS_TXT_MODIFIED, priority: 0.5, changefreq: "weekly" },
    { path: "/openapi.json", modified: null, priority: 0.4, changefreq: "weekly" },
  ];
}

export function sitemapXml(): string {
  const urls = sitemapEntries().map(entry => [
    "  <url>",
    `    <loc>${escapeXml(entry.path === "/" ? `${CANONICAL_ORIGIN}/` : `${CANONICAL_ORIGIN}${entry.path}`)}</loc>`,
    entry.modified ? `    <lastmod>${new Date(entry.modified).toISOString()}</lastmod>` : null,
    `    <changefreq>${entry.changefreq}</changefreq>`,
    `    <priority>${entry.priority.toFixed(1)}</priority>`,
    "  </url>",
  ].filter(Boolean).join("\n"));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
