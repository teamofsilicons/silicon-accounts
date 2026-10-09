/**
 * GET /api/docs/pages/{product}/{path}: one docs page as JSON, with its headings, related pages, previous and next
 * page and its Markdown as written. /api/docs/pages/apps/start/publish, /api/docs/pages/accounts (the product's
 * overview), /api/docs/pages/index (the docs landing page). A trailing .md is accepted.
 */
import { readPage } from "@/lib/docs/api";
import { docsApi, methodNotAllowed } from "@/lib/server/docs-api";
import { preflight } from "@/lib/server/public-response";

export async function GET(request: Request, { params }: RouteContext<"/api/docs/pages/[...path]">) {
  const { path } = await params;
  return docsApi(request, () => {
    const joined = path.join("/");
    if (!/^(index|apps|accounts)(\/|$|\.md$)/.test(joined)) {
      return { status: 404, problem: { code: "page_not_found", message: `There is no docs page at "${joined.slice(0, 120)}".`, hint: "Pages live under apps/ or accounts/, such as apps/start/publish; GET /api/docs/pages lists every one." } };
    }
    const page = readPage(joined);
    if (!page) return { status: 404, problem: { code: "page_not_found", message: `There is no docs page at "${joined.slice(0, 120)}".`, hint: "GET /api/docs/pages lists every page, or search with GET /api/docs/search?q=." } };
    return { body: page };
  });
}

export const OPTIONS = () => preflight();
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
