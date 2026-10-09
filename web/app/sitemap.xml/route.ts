/** GET /sitemap.xml (lib/agent/sitemap.ts). */
import { sitemapXml } from "@/lib/agent/sitemap";
import { publicResponse } from "@/lib/server/public-response";

export function GET(request: Request) {
  return publicResponse(request, sitemapXml(), { type: "application/xml; charset=utf-8", maxAge: 3600 });
}

export const HEAD = GET;
