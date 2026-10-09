/**
 * The Apps proxy's 401s (app/api/apps/[...path]/route.ts, lib/server/apps-refusal.ts): Silicon Apps refusing the
 * developer token is never relayed as "signed out" unless Silicon Accounts says the sign-in ended, so the shell and the
 * sign-in page can never send a signed-in Carbon back and forth. Run with `pnpm test`.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { NextRequest } from "next/server";
import { actionForAppsRefusal, appsRefusalBody, isLoopbackOrigin, signInStateFor } from "../lib/server/apps-refusal";
import { seal } from "../lib/server/seal";
import type { StoredSession } from "../lib/server/session";

const SIGNED_OUT = new Set(["signed_out", "token_revoked", "account_deleted", "unauthenticated", "invalid_token"]);

test("what a 401 code of Silicon Accounts says about the sign-in", () => {
  assert.equal(signInStateFor("invalid_token"), "expired");
  for (const code of ["token_revoked", "account_deleted", "unauthenticated", "signed_out", "session_expired"]) assert.equal(signInStateFor(code), "ended", code);
  assert.equal(signInStateFor("token_wrong_audience"), "unknown");
  assert.equal(signInStateFor(""), "unknown");
});

test("a refusal by Silicon Apps signs out only when Silicon Accounts says the sign-in ended", () => {
  assert.equal(actionForAppsRefusal("ended", false), "signed_out");
  assert.equal(actionForAppsRefusal("ended", true), "signed_out");
  assert.equal(actionForAppsRefusal("expired", false), "refresh");
  assert.equal(actionForAppsRefusal("expired", true), "refused", "one refresh at most");
  assert.equal(actionForAppsRefusal("valid", false), "refused");
  assert.equal(actionForAppsRefusal("unknown", false), "refused");
});

test("the refusal's answer is in words, keeps Apps' own code, and is never a code the browser reads as signed out", () => {
  const upstream = JSON.stringify({ error: { code: "invalid_token", message: "The access token was not issued by http://127.0.0.1:1.", hint: "Sign in to Silicon Apps again." } });
  const remote = appsRefusalBody(upstream);
  assert.equal(remote.error.code, "apps_rejected_sign_in");
  assert.ok(!SIGNED_OUT.has(remote.error.code));
  assert.match(remote.error.message, /Silicon Apps did not accept your developer site sign-in/);
  assert.match(remote.error.message, /still signed in/);
  assert.deepEqual(remote.error.details, { upstream_status: 401, upstream_code: "invalid_token", upstream_message: "The access token was not issued by http://127.0.0.1:1." });
  assert.match(remote.error.hint ?? "", /silicon-accounts report/);
  assert.match(appsRefusalBody(upstream, true).error.hint ?? "", /APPS_ACCOUNTS_URL/);
  assert.deepEqual(appsRefusalBody("not json").error.details, { upstream_status: 401 });
  assert.ok(!/[\u2013\u2014]/.test(JSON.stringify([remote, appsRefusalBody(upstream, true)])), "no em or en dashes in the words");
});

test("loopback origins are local stacks", () => {
  assert.equal(isLoopbackOrigin("http://localhost:8745"), true);
  assert.equal(isLoopbackOrigin("http://127.0.0.1:8600"), true);
  assert.equal(isLoopbackOrigin("http://developer.localhost:3000"), true);
  assert.equal(isLoopbackOrigin("https://developers.teamofsilicons.com"), false);
  assert.equal(isLoopbackOrigin("nonsense"), false);
});

/* The route handler itself, with Silicon Apps and Silicon Accounts stubbed (global fetch). */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

process.env.APPS_API_URL = "http://apps.test";
process.env.ACCOUNTS_API_URL = "http://accounts.test";
process.env.DEVELOPER_PUBLIC_URL = "https://developers.example";

/** A sealed session; every test its own refresh token (refreshes are remembered per refresh token for a minute). */
const session = (): StoredSession => ({ v: 1, at: "access-token", rt: `sar_${Math.random().toString(36).slice(2)}`, ae: Date.now() + 20 * 60_000, re: Date.now() + 86_400_000, sub: "uuid" });

function request(): NextRequest {
  const cookie = `__Host-sa_dev_session=${seal(session(), "sa_dev_session")}`;
  return new NextRequest("https://developers.example/api/apps/apps?mine=true&limit=100", { headers: { cookie } });
}

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stub(answers: { apps: () => Response; session: () => Response; token?: () => Response }): Promise<string[]> {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url.replace(/\?.*$/, ""));
    if (url.startsWith("http://apps.test/")) return answers.apps();
    if (url === "http://accounts.test/v1/session") return answers.session();
    if (url === "http://accounts.test/v1/oauth/token" && answers.token) return answers.token();
    throw new Error(`unexpected call to ${url}`);
  }) as typeof fetch;
  return calls;
}

const appsRefuses = () => jsonResponse(401, { error: { code: "invalid_token", message: "The access token was not issued by http://127.0.0.1:1." } });

test("Apps refuses while Silicon Accounts accepts: 502 apps_rejected_sign_in, the cookie kept, no refresh spent", async () => {
  const calls = await stub({ apps: appsRefuses, session: () => jsonResponse(200, { kind: "token" }) });
  const { GET } = await import("../app/api/apps/[...path]/route");
  const response = await GET(request());
  const body = (await response.json()) as { error: { code: string; details: Record<string, unknown> } };
  assert.equal(response.status, 502);
  assert.equal(body.error.code, "apps_rejected_sign_in");
  assert.equal(body.error.details.upstream_code, "invalid_token");
  assert.equal(response.headers.get("set-cookie"), null, "the session cookie is neither cleared nor rewritten");
  assert.deepEqual(calls, ["http://apps.test/v1/apps", "http://accounts.test/v1/session"]);
});

test("Apps refuses and Silicon Accounts says the sign-in ended: 401 signed_out and the cookie cleared", async () => {
  await stub({ apps: appsRefuses, session: () => jsonResponse(401, { error: { code: "token_revoked", message: "The sign-in behind this access token no longer exists." } }) });
  const { GET } = await import("../app/api/apps/[...path]/route");
  const response = await GET(request());
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, 401);
  assert.equal(body.error.code, "signed_out");
  assert.match(response.headers.get("set-cookie") ?? "", /__Host-sa_dev_session=;.*Max-Age=0/i);
});

test("Apps refuses and the token expired at Silicon Accounts too: one refresh, one retry", async () => {
  let appsCalls = 0;
  const calls = await stub({
    apps: () => (++appsCalls === 1 ? appsRefuses() : jsonResponse(200, { items: [], total: 0 })),
    session: () => jsonResponse(401, { error: { code: "invalid_token", message: "expired" } }),
    token: () => jsonResponse(200, { access_token: "fresh", refresh_token: "sar_fresh", expires_in: 1800, account: { uuid: "uuid" } }),
  });
  const { GET } = await import("../app/api/apps/[...path]/route");
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /__Host-sa_dev_session=v1\./, "the rotated session is written back");
  assert.deepEqual(calls, ["http://apps.test/v1/apps", "http://accounts.test/v1/session", "http://accounts.test/v1/oauth/token", "http://apps.test/v1/apps"]);
});

test("Apps refuses again after the refresh: 502, never a loop of refreshes", async () => {
  const calls = await stub({
    apps: appsRefuses,
    session: () => jsonResponse(401, { error: { code: "invalid_token", message: "expired" } }),
    token: () => jsonResponse(200, { access_token: "fresh2", refresh_token: "sar_fresh2", expires_in: 1800, account: { uuid: "uuid" } }),
  });
  const { GET } = await import("../app/api/apps/[...path]/route");
  const response = await GET(request());
  assert.equal(response.status, 502);
  assert.equal(calls.filter(call => call.endsWith("/v1/oauth/token")).length, 1);
  assert.match(response.headers.get("set-cookie") ?? "", /__Host-sa_dev_session=v1\./, "the refreshed session is kept");
});
