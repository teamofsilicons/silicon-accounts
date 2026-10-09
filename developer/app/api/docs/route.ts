/** GET /api/docs: what the public docs API offers, with links to each endpoint and the OpenAPI description. */
import { RATE_LIMITS } from "@/lib/site";
import { docsApi, methodNotAllowed } from "@/lib/server/docs-api";
import { preflight } from "@/lib/server/public-response";

export function GET(request: Request) {
  return docsApi(request, () => ({
    body: {
      name: "Silicon Developer docs API",
      description: "Search and read the Silicon Apps and Silicon Accounts docs as JSON. Public, no sign-in.",
      openapi: "/openapi.json",
      endpoints: {
        search: "/api/docs/search?q={query}&product={apps|accounts}&kind={start|learn|reference|overview}&limit={1-50}",
        pages: "/api/docs/pages?product={apps|accounts}&kind={start|learn|reference|overview}",
        page: "/api/docs/pages/{product}/{path}",
      },
      mcp: "/mcp",
      rate_limit: { requests: RATE_LIMITS.api.limit, window_seconds: RATE_LIMITS.api.windowSeconds, per: "client address" },
    },
  }));
}

export const OPTIONS = () => preflight();
export const POST = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
