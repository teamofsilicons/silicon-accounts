import assert from "node:assert/strict";
import { test } from "node:test";
import { proxyRoute } from "../lib/server/apps-routes";
import { proxyRoute as accountsRoute } from "../lib/server/routes";
import { APP_TABS, appTabFrom } from "../lib/app-tabs";

test("publishing proxy forwards only authoring with own-app catalog and immutable resource paths", () => {
  const own = new URLSearchParams("mine=true&limit=100");
  for (const [path, verb] of [["apps", "POST"], ["apps/my_app", "PATCH"], ["apps/my_app/access", "PUT"], ["apps/my_app/packages/linux-x86_64", "POST"], ["apps/my_app/media/a1b2", "GET"], ["apps/my_app/authors/uuid-1", "DELETE"], ["apps/my_app/releases/release-1/promote", "POST"], ["invites/invite-1/accept", "POST"]]) {
    assert.deepEqual(proxyRoute(path, verb), {path: `v1/${path}`});
  }
  assert.deepEqual(proxyRoute("apps", "GET", own), {path: "v1/apps"});
  for (const [path, verb] of [["apps", "GET"], ["apps/my_app/review", "PUT"], ["apps/my_app/install", "POST"], ["apps/my_app/resolve", "GET"], ["reports", "POST"], ["platforms", "POST"], ["auth/login", "GET"], ["apps/my_app/../secret", "POST"], ["apps/my_app/%2e%2e", "GET"], ["apps/my_app/authors/a%2fb", "DELETE"], ["apps/my_app/admin/extra", "POST"], ["apps/my_app/packages/x64", "GET"]]) assert.equal(proxyRoute(path, verb), null, `${verb} ${path}`);
});

test("the same underscore app ID reaches Accounts settings and all native publishing tabs", () => {
  assert.ok(accountsRoute("apps/my_app/signin-config", "PATCH"));
  assert.ok(accountsRoute("apps/_my_app/signin-config", "PATCH"));
  for (const tab of ["publishing", "releases", "authors", "history", "sign-in", "details", "flows", "pages", "users", "import", "webhooks", "app-verification", "embed"]) {
    assert.ok(APP_TABS.includes(tab as typeof APP_TABS[number]));
    assert.equal(appTabFrom([tab]), tab);
  }
  assert.equal(appTabFrom(["explore"]), null);
});


test("private Apps media remains on the authenticated developer BFF origin", async () => {
  const {publishingMediaUrl} = await import("../lib/apps-media");
  assert.equal(publishingMediaUrl("/v1/apps/my_app/media/digest"), "/api/apps/apps/my_app/media/digest");
  assert.equal(publishingMediaUrl("https://apps.teamofsilicons.com/v1/apps/my_app/media/digest"), "/api/apps/apps/my_app/media/digest");
  assert.equal(publishingMediaUrl("https://images.example/logo.png"), "https://images.example/logo.png");
});
