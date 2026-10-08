/** The BFF's own logic: sealing cookies, return paths, the proxy allowlist. Run with `pnpm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { proxyRoute } from "../lib/server/routes";
import { seal, unseal } from "../lib/server/seal";
import { safeReturnPath } from "../lib/server/session";

const SECRET = "test-secret-test-secret-test-secret-0001";

test("a sealed value opens only for its purpose and secret", () => {
  const sealed = seal({ at: "eyJ…", rt: "sar_x" }, "sa_dev_session", SECRET);
  assert.match(sealed, /^v1\./);
  assert.ok(!sealed.includes("sar_x"), "the refresh token is not readable in the cookie");
  assert.deepEqual(unseal(sealed, "sa_dev_session", SECRET), { at: "eyJ…", rt: "sar_x" });
  assert.equal(unseal(sealed, "sa_dev_signin", SECRET), null, "another cookie's purpose does not open it");
  assert.equal(unseal(sealed, "sa_dev_session", `${SECRET}-other`), null, "another secret does not open it");
  const tampered = `${sealed.slice(0, -2)}${sealed.endsWith("A") ? "B" : "A"}${sealed.slice(-1)}`;
  assert.equal(unseal(tampered, "sa_dev_session", SECRET), null, "a changed byte fails authentication");
  assert.equal(unseal("garbage", "sa_dev_session", SECRET), null);
  assert.equal(unseal(undefined, "sa_dev_session", SECRET), null);
});

test("return paths stay on this site and off the sign-in routes", () => {
  assert.equal(safeReturnPath("/apps/briefcase/flows?x=1#y"), "/apps/briefcase/flows?x=1#y");
  assert.equal(safeReturnPath("https://evil.example/x"), "/");
  assert.equal(safeReturnPath("//evil.example/x"), "/");
  assert.equal(safeReturnPath("/\\evil.example"), "/");
  assert.equal(safeReturnPath("/\t/evil.example/x"), "/");
  assert.equal(safeReturnPath("javascript:alert(1)"), "/");
  assert.equal(safeReturnPath("/auth/callback?code=x"), "/");
  assert.equal(safeReturnPath("/api/accounts/me"), "/");
  assert.equal(safeReturnPath("/sign-in"), "/");
  assert.equal(safeReturnPath(null), "/");
});

test("the proxy forwards only the developer audience's routes", () => {
  assert.deepEqual(proxyRoute("meta", "GET"), { path: "v1/meta", kind: "public" });
  assert.deepEqual(proxyRoute("apps/briefcase/public", "GET"), { path: "v1/apps/briefcase/public", kind: "public" });
  assert.deepEqual(proxyRoute(".well-known/openid-configuration", "GET"), { path: ".well-known/openid-configuration", kind: "public" });
  assert.deepEqual(proxyRoute("me", "GET"), { path: "v1/me", kind: "account" });
  assert.deepEqual(proxyRoute("me/owned-apps", "GET"), { path: "v1/me/owned-apps", kind: "account" });
  assert.deepEqual(proxyRoute("me/app-verifications", "GET"), { path: "v1/me/app-verifications", kind: "account" });
  assert.equal(proxyRoute("me/app-verifications", "POST"), null);
  assert.equal(proxyRoute("me/app-verifications/other", "GET"), null);
  assert.deepEqual(proxyRoute("apps/briefcase/proofs/example/history", "GET"), { path: "v1/apps/briefcase/proofs/example/history", kind: "account" });
  assert.deepEqual(proxyRoute("apps/briefcase/signin-config", "PATCH"), { path: "v1/apps/briefcase/signin-config", kind: "account" });
  assert.deepEqual(proxyRoute("apps/briefcase/proofs/ata", "POST"), { path: "v1/apps/briefcase/proofs/ata", kind: "account" });
  assert.equal(proxyRoute("me", "PATCH"), null, "the account itself is never changed through the developer site");
  assert.equal(proxyRoute("me/apps", "GET"), null);
  assert.equal(proxyRoute("me/silicons", "GET"), null);
  assert.equal(proxyRoute("session/signout", "POST"), null);
  assert.equal(proxyRoute("apps/briefcase/../../me", "GET"), null);
  assert.equal(proxyRoute("apps/briefcase/%2e%2e/x", "GET"), null);
  assert.equal(proxyRoute("apps/briefcase/a%2fb", "GET"), null);
  assert.equal(proxyRoute("apps/briefcase//users", "GET"), null);
  assert.equal(proxyRoute("apps/BRIEFCASE", "GET"), null);
  assert.equal(proxyRoute(".well-known/other", "GET"), null);
  assert.equal(proxyRoute("apps/briefcase/public", "POST"), null);
});

test("the account site's old developer tabs land on their new names", async () => {
  const { renamedAppTab, isUnknownAppTab } = await import("../lib/app-tabs");
  assert.equal(renamedAppTab("/apps/briefcase/branding"), "/apps/briefcase/pages");
  assert.equal(renamedAppTab("/apps/briefcase/proofs/"), "/apps/briefcase/ata");
  assert.equal(renamedAppTab("/apps/briefcase/flows"), null);
  assert.equal(isUnknownAppTab("/apps/briefcase/flows"), false);
  assert.equal(isUnknownAppTab("/apps/briefcase/bogus"), true);
  assert.equal(isUnknownAppTab("/apps/briefcase"), false);
});

test("production seals with nothing anyone can know: no secret, a short one or the public development secret are refused", async () => {
  const { DEV_SECRET, sessionSecret } = await import("../lib/server/config");
  const env = process.env as Record<string, string | undefined>;
  const saved = { node: env.NODE_ENV, secret: env.DEVELOPER_SESSION_SECRET };
  try {
    env.NODE_ENV = "production";
    delete env.DEVELOPER_SESSION_SECRET;
    assert.throws(() => sessionSecret(), /DEVELOPER_SESSION_SECRET is not set/);
    env.DEVELOPER_SESSION_SECRET = "short-secret-0123456";
    assert.throws(() => sessionSecret(), /20 characters; it must be at least 32/);
    env.DEVELOPER_SESSION_SECRET = DEV_SECRET;
    assert.throws(() => sessionSecret(), /public development secret/);
    env.DEVELOPER_SESSION_SECRET = `  ${DEV_SECRET}  `;
    assert.throws(() => sessionSecret(), /public development secret/, "surrounding spaces do not disguise it");
    env.DEVELOPER_SESSION_SECRET = SECRET;
    assert.equal(sessionSecret(), SECRET);
    env.NODE_ENV = "development";
    env.DEVELOPER_SESSION_SECRET = DEV_SECRET;
    assert.equal(sessionSecret(), DEV_SECRET, "development may use it");
  } finally {
    if (saved.node === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = saved.node;
    if (saved.secret === undefined) delete env.DEVELOPER_SESSION_SECRET;
    else env.DEVELOPER_SESSION_SECRET = saved.secret;
  }
});
