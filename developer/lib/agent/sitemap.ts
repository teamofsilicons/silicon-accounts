/**
 * /sitemap.xml: every public page with its last change: the home page, the docs landing page, every docs page and
 * group page, and the two agent files. The signed-in portal, the API and the search results are not pages to index.
 */
import "server-only";
import { docs } from "@/lib/docs/content";
import { LLMS_FILES } from "@/lib/docs/llms";
import { CANONICAL_ORIGIN } from "@/lib/site";

interface Entry {
  path: string;
  modified: string | null;
  priority: number;
}

const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const latest = (dates: Array<string | null | undefined>): string | null => dates.filter((date): date is string => Boolean(date)).sort().at(-1) ?? null;

export function sitemapEntries(): Entry[] {
  const { pages, nav } = docs();
  const newest = latest(pages.map(page => page.modified));
  const entries: Entry[] = [{ path: "/", modified: newest, priority: 1 }];
  for (const page of pages) entries.push({ path: page.href, modified: page.modified ?? null, priority: page.slug === "" ? 0.9 : page.slug.split("/").length <= 1 ? 0.8 : 0.7 });
  for (const group of nav) {
    if (!group.href) continue;
    entries.push({ path: group.href, modified: latest(pages.filter(page => page.group === group.key).map(page => page.modified)), priority: 0.6 });
  }
  entries.push({ path: "/llms.txt", modified: LLMS_FILES.index.modified ?? newest, priority: 0.5 });
  entries.push({ path: "/llms-full.txt", modified: LLMS_FILES.full.modified ?? newest, priority: 0.5 });
  const seen = new Set<string>();
  return entries.filter(entry => (seen.has(entry.path) ? false : (seen.add(entry.path), true)));
}

export function sitemapXml(): string {
  const urls = sitemapEntries().map(entry => {
    const location = entry.path === "/" ? `${CANONICAL_ORIGIN}/` : `${CANONICAL_ORIGIN}${entry.path}`;
    return [
      "  <url>",
      `    <loc>${escapeXml(location)}</loc>`,
      entry.modified ? `    <lastmod>${new Date(entry.modified).toISOString()}</lastmod>` : null,
      `    <priority>${entry.priority.toFixed(1)}</priority>`,
      "  </url>",
    ].filter(Boolean).join("\n");
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
