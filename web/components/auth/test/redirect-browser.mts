/** Actual Complete component against a slow callback: pnpm exec tsx components/auth/test/redirect-browser.mts. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = await mkdtemp(join(tmpdir(), "accounts-redirect-"));
let calls = 0;
await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {Complete} from './components/auth/steps/complete';
      const flow = {id:'fixture', step:'complete', prompt:null, redirect_to:location.origin+'/callback',
        app:{app_id:'dm', name:'DM'}, signed_in_as:null};
      createRoot(document.getElementById('root')).render(<Complete flow={flow as any}/>);`,
    resolveDir: root, sourcefile: "fixture.tsx", loader: "tsx",
  },
  outfile: join(dir, "fixture.js"), bundle: true, format: "iife", platform: "browser", jsx: "automatic",
  tsconfig: join(root, "tsconfig.json"), loader: { ".css": "empty" }, logLevel: "silent",
  banner: { js: 'window.process={env:{NODE_ENV:"production"}};' }, define: { "process.env.NODE_ENV": '"production"' },
});
const script = await readFile(join(dir, "fixture.js"));
const server = createServer(async (request, response) => {
  if (request.url === "/callback") {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 1500));
    response.end("DM callback");
  } else if (request.url === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(script);
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end('<html><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of ["click", "double-click", "timer-first", "automatic", "reduced-motion", "storage-blocked"]) {
    calls = 0;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: scenario === "reduced-motion" ? "reduce" : "no-preference" });
    try {
      if (scenario === "storage-blocked") await context.addInitScript(() => {
        Object.defineProperty(window, "sessionStorage", { get() { throw new Error("storage blocked"); } });
      });
      const page = await context.newPage();
      await page.goto(origin);
      const link = page.getByRole("link", { name: "Continue to DM" });
      await link.waitFor();
      const element = await link.elementHandle();
      assert.ok(element);
      if (scenario === "timer-first") {
        // Schedule before navigation begins: Playwright otherwise waits for that navigation to finish.
        await element.evaluate(node => { window.setTimeout(() => (node as HTMLAnchorElement).click(), 800); });
      } else if (scenario === "double-click") await element.evaluate(node => { (node as HTMLAnchorElement).click(); (node as HTMLAnchorElement).click(); });
      else if (scenario !== "automatic") await link.click({ noWaitAfter: true });
      await page.waitForURL(`${origin}/callback`);
      assert.equal(calls, 1, `${scenario}: the one-time link must be opened only once`);
      console.log(`Passed ${scenario}: one callback request`);
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
}
