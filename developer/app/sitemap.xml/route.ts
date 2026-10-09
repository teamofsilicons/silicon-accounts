/** GET /sitemap.xml (lib/agent/sitemap.ts). */
import { sitemapXml } from "@/lib/agent/sitemap";
import { publicResponse } from "@/lib/server/public-response";

let body: string | null = null;

export function GET(request: Request) {
  body ??= sitemapXml();
  return publicResponse(request, body, { type: "application/xml; charset=utf-8", maxAge: 3600 });
}
