/** sdk/v1.ts in just enough of a page: a script tag with data-method="email". Run with `pnpm test`. */
import assert from "node:assert/strict";
import { test } from "node:test";

type Api = { signIn(options: object): Promise<void>; renderButtons(target: unknown, options: object): Promise<unknown> };

class FakeScript {
  src = "https://accounts.example.test/sdk/v1.js";
  getAttribute(name: string) {
    return name === "data-method" ? "email" : null;
  }
  hasAttribute(name: string) {
    return this.getAttribute(name) !== null;
  }
}
const observers: Array<{ callback: () => void; disconnected: boolean }> = [];
class FakeObserver {
  disconnected = false;
  constructor(readonly callback: () => void) {
    observers.push(this);
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
}
const assigned: string[] = [];
const mediaListeners = new Set<unknown>();
const media = { matches: false, addEventListener: (_: string, fn: unknown) => mediaListeners.add(fn), removeEventListener: (_: string, fn: unknown) => mediaListeners.delete(fn) };
const page: { SiliconAccounts?: Api } & Record<string, unknown> = { addEventListener() {}, removeEventListener() {}, matchMedia: () => media };
Object.assign(globalThis, {
  __ACCOUNTS_WEB_VERSION__: "test",
  HTMLScriptElement: FakeScript,
  MutationObserver: FakeObserver,
  window: page,
  document: { currentScript: new FakeScript(), readyState: "complete", documentElement: {}, body: {}, dispatchEvent: () => true },
  location: { href: "https://app.example.test/", origin: "https://app.example.test", assign: (url: string) => assigned.push(url) },
  sessionStorage: { setItem() {} },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
});
const sdk = async () => {
  await import("../sdk/v1");
  return page.SiliconAccounts!;
};

test("method: null leaves the script tag's data-method out", async () => {
  const api = await sdk();
  const options = { appId: "my_app", redirectUri: "https://app.example.test/callback" };
  await api.signIn(options);
  assert.equal(new URL(assigned.at(-1)!).searchParams.get("method"), "email");
  await api.signIn({ ...options, method: null });
  assert.equal(new URL(assigned.at(-1)!).searchParams.get("method"), null);
});

test("a failed render stops following the page once the host is rendered again", async () => {
  const api = await sdk();
  let root: { parentNode: object | null } | null = null;
  const shadow = {
    set innerHTML(_: string) {
      if (root) root.parentNode = null;
      root = { parentNode: {}, style: { setProperty() {} }, dataset: {}, removeAttribute() {}, querySelectorAll: () => [] } as { parentNode: object | null };
    },
    querySelector: () => root,
  };
  const host = { shadowRoot: shadow };
  await assert.rejects(api.renderButtons(host, { theme: "light" }), /data-app-id is missing/);
  await assert.rejects(api.renderButtons(host, { theme: "light" }), /data-app-id is missing/);
  observers[0]!.callback();
  assert.equal(observers[0]!.disconnected, true);
  assert.equal(observers[1]!.disconnected, false);
  assert.equal(mediaListeners.size, 1);
});
