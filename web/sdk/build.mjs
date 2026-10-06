/**
 * Builds the SDK: sdk/v1.ts → public/sdk/v1.js, one dependency-free IIFE that third-party pages load with a plain
 * <script> (served at /sdk/v1.js with CORS * and a 5 minute cache, see next.config.ts). Runs before `dev` and `build`.
 *
 *   node sdk/build.mjs            build once (minified)
 *   node sdk/build.mjs --watch    rebuild on change while working on the SDK
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import * as esbuild from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const watch = process.argv.includes("--watch");
/** The SDK must stay small enough to load on any sign-in page. */
const BUDGET_GZIP = 12 * 1024;

const options = {
  entryPoints: [resolve(root, "sdk/v1.ts")],
  outfile: resolve(root, "public/sdk/v1.js"),
  bundle: true,
  format: "iife",
  globalName: "SiliconAccountsSdk",
  platform: "browser",
  target: ["es2019"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  define: { __ACCOUNTS_WEB_VERSION__: JSON.stringify(pkg.version ?? "0.0.0") },
  banner: { js: `/* Silicon Accounts SDK v1 (${pkg.version}). https://account.teamofsilicons.com */` },
  logLevel: "warning",
};

async function report() {
  const code = await readFile(options.outfile);
  const gzip = gzipSync(code).length;
  const line = `sdk: public/sdk/v1.js ${(code.length / 1024).toFixed(1)} KB (${(gzip / 1024).toFixed(1)} KB gzipped)`;
  if (gzip > BUDGET_GZIP) {
    console.error(`${line}: over the ${BUDGET_GZIP / 1024} KB gzip budget`);
    process.exitCode = 1;
  } else console.log(line);
}

if (watch) {
  const context = await esbuild.context({ ...options, plugins: [{ name: "report", setup(build) { build.onEnd(result => { if (!result.errors.length) void report(); }); } }] });
  await context.watch();
  console.log("sdk: watching sdk/ for changes");
} else {
  await esbuild.build(options);
  await report();
}
