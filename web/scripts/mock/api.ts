/**
 * A Playwright-side mock of the Silicon Accounts API for screenshots and page work without the Rust server.
 * `mockApi(page, options)` answers /v1/*, /healthz and /.well-known/* from the fixtures; add or override routes per
 * screen with `routes`. Unknown routes answer 404 with an API error body, exactly like the server would.
 *
 *   await mockApi(page, { as: "carbon", routes: [["GET /v1/me/apps", () => ({ json: { items: [], next_cursor: null } })]] });
 */
import type { Page, Route } from "@playwright/test";
import * as data from "./fixtures";

export interface MockRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export interface MockReply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Milliseconds before answering (to see loading states). */
  delay?: number;
}

export type MockHandler = (request: MockRequest) => MockReply | null | undefined | Promise<MockReply | null | undefined>;
/** `["GET /v1/apps/:appId", handler]`; later entries win over earlier ones and over the defaults. */
export type MockRoute = [string, MockHandler];

export interface MockOptions {
  /** Who is signed in: a Carbon (default), nobody, or a custom session. */
  as?: "carbon" | "signed-out";
  routes?: MockRoute[];
  /** Called for every request the mock answers (for assertions). */
  onRequest?: (request: MockRequest) => void;
}

const error = (status: number, code: string, message: string, hint?: string): MockReply => ({ status, json: { error: { code, message, hint } } });

function compile(pattern: string): { method: string; regex: RegExp; keys: string[] } {
  const [method = "GET", path = "/"] = pattern.trim().split(/\s+/, 2);
  const keys: string[] = [];
  const source = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\:([A-Za-z_]\w*)|:([A-Za-z_]\w*)/g, (_, a: string | undefined, b: string | undefined) => {
    keys.push((a ?? b) as string);
    return "([^/]+)";
  });
  return { method: method.toUpperCase(), regex: new RegExp(`^${source}/?$`), keys };
}

/** The default answers: a signed-in Carbon with apps, Silicons, proofs and an owned app. */
export function defaultRoutes(signedIn: boolean): MockRoute[] {
  const auth = (reply: () => MockReply): MockHandler => () => (signedIn ? reply() : error(401, "unauthenticated", "This request needs a signed-in Carbon or Silicon, and this browser has no session.", "Sign in at /sign-in, then try again."));
  return [
    ["GET /healthz", () => ({ text: "ok" })],
    ["GET /readyz", () => ({ json: { database: "ok" } })],
    ["GET /v1/meta", () => ({ json: data.meta })],
    ["GET /v1/session", auth(() => ({ json: data.session }))],
    ["POST /v1/session/signout", () => ({ status: 204 })],
    ["GET /v1/me", auth(() => ({ json: data.carbon }))],
    ["PATCH /v1/me", auth(() => ({ json: data.carbon }))],
    ["GET /v1/me/emails", auth(() => ({ json: data.carbon.emails }))],
    ["GET /v1/me/phones", auth(() => ({ json: data.carbon.phones }))],
    ["GET /v1/me/identities", auth(() => ({ json: data.carbon.identities }))],
    ["GET /v1/me/apps", auth(() => ({ json: data.page(data.myApps) }))],
    ["GET /v1/me/sessions", auth(() => ({ json: data.page(data.sessions) }))],
    ["GET /v1/me/history", auth(() => ({ json: data.page(data.history) }))],
    ["GET /v1/me/proofs", auth(() => ({ json: data.page(data.proofs) }))],
    ["GET /v1/me/silicons", auth(() => ({ json: data.page(data.silicons) }))],
    ["GET /v1/me/custodian-requests", auth(() => ({ json: data.page(data.custodianRequests) }))],
    ["GET /v1/me/owned-apps", auth(() => ({ json: data.page(data.ownedApps()) }))],
    ["GET /v1/ids/available", ({ query }) => {
      const id = query.get("id") ?? "";
      const taken = ["c:saket", "c:shubham", "si:scout"].includes(id.toLowerCase());
      return { json: { id, available: !taken, reason: taken ? "taken" : null, message: taken ? `${id} is taken.` : `${id} is available.`, reclaimable: false } };
    }],
    ["GET /v1/apps/:appId/public", ({ params }) => {
      // Like the server: CORS * on success and on errors, so the SDK on an app's page can read either.
      const app = data.appPublic(params.appId ?? "");
      const reply = app ? { json: app } : error(404, "unknown_app", `No app with app_id '${params.appId}' exists.`, "Check the app_id; apps are created in Silicon Apps.");
      return { ...reply, headers: { ...reply.headers, "access-control-allow-origin": "*" } };
    }],
    ["GET /v1/apps/:appId/users", auth(() => ({ json: data.page(data.appUsers) }))],
    ["GET /v1/apps/:appId/imports", auth(() => ({ json: data.page([data.importJob]) }))],
    ["GET /v1/apps/:appId/webhook/deliveries", auth(() => ({ json: data.page(data.deliveries) }))],
    ["GET /v1/apps/:appId/proofs", auth(() => ({ json: data.page([]) }))],
    ["GET /v1/apps/:appId/signin-config/history", auth(() => ({ json: data.page([]) }))],
    ["GET /v1/flows/:id", ({ params }) => {
      const [, appId = "briefcase"] = /^flow_(.+)$/.exec(params.id ?? "") ?? [];
      const flow = data.flowView(appId);
      return flow ? { json: { flow } } : error(404, "flow_not_found", "This sign-in has ended or never existed.", "Start again from the app.");
    }],
  ];
}

/** Installs the mock on a page. Call before page.goto(). */
export async function mockApi(page: Page, options: MockOptions = {}): Promise<void> {
  const signedIn = options.as !== "signed-out";
  const table = [...defaultRoutes(signedIn), ...(options.routes ?? [])].map(([pattern, handler]) => ({ ...compile(pattern), handler, pattern }));
  // app-or-owner GET /v1/apps/:appId needs the detail fixture; resolve it here so later overrides still win.
  table.unshift({ ...compile("GET /v1/apps/:appId"), pattern: "GET /v1/apps/:appId", handler: ({ params }) => {
    if (!signedIn) return error(401, "unauthenticated", "This request needs a session.", "Sign in first.");
    const detail = data.appDetail(params.appId ?? "");
    return detail ? { json: detail } : error(404, "unknown_app", `No app with app_id '${params.appId}' exists.`, "Check the app_id.");
  } });

  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body: unknown = null;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData();
    }
    const method = request.method().toUpperCase();
    // Later entries win: search from the end.
    for (let index = table.length - 1; index >= 0; index--) {
      const entry = table[index];
      if (!entry || entry.method !== method) continue;
      const match = entry.regex.exec(url.pathname);
      if (!match) continue;
      const params = Object.fromEntries(entry.keys.map((key, i) => [key, decodeURIComponent(match[i + 1] ?? "")]));
      const mockRequest: MockRequest = { method, path: url.pathname, params, query: url.searchParams, body };
      options.onRequest?.(mockRequest);
      const reply = await entry.handler(mockRequest);
      if (!reply) continue;
      if (reply.delay) await new Promise(resolve => setTimeout(resolve, reply.delay));
      const status = reply.status ?? 200;
      if (status === 204) return route.fulfill({ status, headers: { "x-request-id": "mock" } });
      return route.fulfill({
        status,
        headers: { "content-type": reply.text !== undefined ? "text/plain" : "application/json", "x-request-id": "mock", ...reply.headers },
        body: reply.text ?? JSON.stringify(reply.json ?? null),
      });
    }
    const reply = error(404, "not_found", `${method} ${url.pathname} is not part of the mock API.`, "Add a route to the screen's mocks (see web/README.md).");
    return route.fulfill({ status: 404, headers: { "content-type": "application/json", "x-request-id": "mock" }, body: JSON.stringify(reply.json) });
  };

  await page.route(url => /^\/(v1|healthz|readyz|\.well-known)(\/|$)/.test(new URL(url).pathname), handle);
}
