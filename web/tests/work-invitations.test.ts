import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { resetMetaCache } from "../lib/server/meta";
import { proxy } from "../proxy";

test("work invitation handoff permits only an explicitly configured loopback HTTP origin", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const configured of ["http://localhost:8661", "http://127.0.0.1:8661", "http://[::1]:8661"]) {
      resetMetaCache();
      globalThis.fetch = async () => Response.json({ organizations_url: configured });
      const response = await proxy(new NextRequest("https://accounts.example.test/work-invitations/test"));
      assert.ok(response.headers.get("content-security-policy")?.includes(`form-action 'self' https: ${configured}`));
      assert.equal(response.headers.get("referrer-policy"), "strict-origin", "send the exact Accounts origin without the private ticket path");
      const ordinary = await proxy(new NextRequest("https://accounts.example.test/settings"));
      assert.ok(!ordinary.headers.get("content-security-policy")?.includes(configured), "the local form exception applies only to invitations");
    }
    for (const configured of ["http://remote.example", "http://localhost.evil.example", "http://user@localhost:8661", "javascript:alert(1)", "invalid"]) {
      resetMetaCache();
      globalThis.fetch = async () => Response.json({ organizations_url: configured });
      const response = await proxy(new NextRequest("https://accounts.example.test/work-invitations/test"));
      assert.match(response.headers.get("content-security-policy") ?? "", /form-action 'self' https:;/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invitation pages ask the API for the Organizations origin once, not on every request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    resetMetaCache();
    globalThis.fetch = async () => {
      calls++;
      return Response.json({ organizations_url: "http://localhost:8661" });
    };
    for (let i = 0; i < 3; i++) {
      const response = await proxy(new NextRequest("https://accounts.example.test/work-invitations/test"));
      assert.ok(response.headers.get("content-security-policy")?.includes("form-action 'self' https: http://localhost:8661"));
    }
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
