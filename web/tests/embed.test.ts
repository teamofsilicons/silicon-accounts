/** proxy.ts: who may frame /embed/v1/buttons. Run with `pnpm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";

async function embed(appId: string, allowedOrigins: string[]) {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ allowed_origins: allowedOrigins });
    const response = await proxy(new NextRequest(`https://accounts.example.test/embed/v1/buttons?app_id=${appId}`));
    return { ancestors: /frame-ancestors ([^;]*)/.exec(response.headers.get("content-security-policy") ?? "")?.[1], deny: response.headers.get("x-frame-options") };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("stored wildcards and plain-http origins never reach frame-ancestors", async () => {
  const framing = await embed("legacy-app", ["https://*", "https://*.app.example", "http://site.example", "http://localhost:3000", "https://app.example"]);
  assert.equal(framing.ancestors, "'self' http://localhost:3000 https://app.example");
});

test("a Silicon Apps id's embed is framed by its allowed origins", async () => {
  for (const appId of ["my_app", "2fa-tool"]) {
    const framing = await embed(appId, ["https://myapp.example"]);
    assert.equal(framing.ancestors, "'self' https://myapp.example", appId);
    assert.equal(framing.deny, null, appId);
  }
});
