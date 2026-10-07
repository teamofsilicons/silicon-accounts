/**
 * The security suite's helpers that need no stack: Set-Cookie parsing and the cookie jar, and raw requests (byte-exact
 * request targets and Host headers) against the recording server.
 *
 *   web/node_modules/.bin/tsx --test web/e2e/suites/security/test/*.test.ts
 */
import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { Jar, parseSetCookie, raw, serve } from "../_helpers";

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(done => server.close(() => done()));
  return port;
}

describe("parseSetCookie", () => {
  it("reads the name, the value and every attribute (flags as empty values, names in lower case)", () => {
    const cookie = parseSetCookie("__Host-sa_session=sas_abc=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=77760000");
    assert.equal(cookie.name, "__Host-sa_session");
    assert.equal(cookie.value, "sas_abc=");
    assert.equal(cookie.attributes.get("samesite"), "Lax");
    assert.equal(cookie.attributes.get("max-age"), "77760000");
    assert.equal(cookie.attributes.get("path"), "/");
    assert.equal(cookie.attributes.get("httponly"), "");
    assert.ok(cookie.attributes.has("secure"));
    assert.ok(!cookie.attributes.has("domain"));
  });
});

describe("Jar", () => {
  it("keeps what is set, forgets what is cleared, sends the rest, and clones independently", () => {
    const jar = new Jar();
    const set = new Headers();
    set.append("set-cookie", "sa_flow=saf_1; Path=/; HttpOnly");
    set.append("set-cookie", "sa_signup=sau_2; Path=/; HttpOnly");
    jar.absorb(set);
    assert.equal(jar.header(), "sa_flow=saf_1; sa_signup=sau_2");
    const cleared = new Headers();
    cleared.append("set-cookie", "sa_signup=; Max-Age=0; Path=/");
    jar.absorb(cleared);
    assert.equal(jar.header(), "sa_flow=saf_1");
    assert.equal(jar.last("sa_signup")?.attributes.get("max-age"), "0");
    assert.equal(jar.seen.length, 3);
    const copy = jar.clone();
    copy.delete("sa_flow");
    assert.equal(jar.get("sa_flow"), "saf_1");
    assert.equal(copy.header(), undefined);
  });
});

describe("raw and serve", () => {
  it("send the request target and the Host header byte for byte, and never follow a redirect", async () => {
    const server = await serve(await freePort(), (hit, res) => {
      res.writeHead(308, { location: hit.path });
      res.end();
    });
    try {
      const target = "//evil.example/%2e%2e/\\x?next=//evil.example/";
      const reply = await raw(server.url, target, { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } });
      assert.equal(reply.status, 308);
      assert.equal(reply.headers.location, target);
      assert.equal(server.hits.length, 1);
      assert.equal(server.hits[0]?.path, target);
      assert.equal(server.hits[0]?.headers.host, "evil.example");
      assert.equal(server.hits[0]?.headers["x-forwarded-host"], "evil.example");
    } finally {
      await server.close();
    }
  });

  it("record the method and the body", async () => {
    const server = await serve(await freePort());
    try {
      const reply = await raw(server.url, "/hook", { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
      assert.equal(reply.status, 200);
      assert.equal(reply.text, "ok");
      assert.deepEqual({ method: server.hits[0]?.method, body: server.hits[0]?.body }, { method: "POST", body: '{"a":1}' });
    } finally {
      await server.close();
    }
  });

  it("report a refused connection as status -1", async () => {
    const reply = await raw(`http://127.0.0.1:${await freePort()}`, "/");
    assert.equal(reply.status, -1);
    assert.match(reply.text, /ECONNREFUSED/);
  });
});
