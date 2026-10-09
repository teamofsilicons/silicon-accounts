/**
 * Next.js config for the Silicon Accounts web app.
 *
 * Topology: Next serves the whole site on the public origin (dev http://localhost:8590, prod
 * https://accounts.teamofsilicons.com) and proxies the API with rewrites, so the browser stays same-origin (cookies,
 * the API's Origin check): /v1/*, /.well-known/* and /openapi.json → ACCOUNTS_API_URL (default
 * http://127.0.0.1:8589). Provider callbacks (/v1/oauth/callback/*, Apple's form_post too), the API's discovery
 * (/openapi.json, /v1/openapi.json, /v1/capabilities, /.well-known/agent.json, /.well-known/openid-configuration), the
 * event stream (/v1/events/stream) and every API call pass through unchanged, Set-Cookie and Location included. One
 * file under /.well-known is the site's own: security.txt (app/.well-known/security.txt), which the API does not serve.
 * Production's Caddy sends /v1/events/stream and /openapi.json straight to the API (deploy/install.py); locally they go
 * through here.
 *
 * ACCOUNTS_API_URL is read when this file loads: at `next dev` start, and at `next build` for `next start` and the
 * standalone server (Next bakes rewrites into the build). Build with the address the server will use; instrumentation.ts
 * warns at start when the environment says otherwise.
 *
 * Security headers for pages (nonce CSP, frame-ancestors, X-Frame-Options…) come from proxy.ts; this file adds the
 * SDK's CORS and cache headers.
 *
 * NEXT_DIST_DIR gives a build its own directory (default `.next`): because the API address is baked into each build,
 * every local stack on other ports (scripts/dev.sh, scripts/e2e.sh) builds into `.next-<port>`, so stacks that run at
 * the same time never share or overwrite a build. See isolatedBuild() for what such a build does differently.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const root = dirname(fileURLToPath(import.meta.url));
const apiUrl = (process.env.ACCOUNTS_API_URL ?? "http://127.0.0.1:8589").replace(/\/+$/, "");

/** The build directory: `.next`, or NEXT_DIST_DIR (`.next-<name>`, inside web/, which .gitignore and tsconfig skip). */
function distDirFromEnv(): string {
  const wanted = process.env.NEXT_DIST_DIR?.trim() || ".next";
  if (!/^\.next(-[A-Za-z0-9_.-]+)?$/.test(wanted)) {
    throw new Error(`NEXT_DIST_DIR must look like .next-<name> (a directory in web/, e.g. .next-9600), got "${wanted}"`);
  }
  return wanted;
}

const distDir = distDirFromEnv();

/**
 * A build in its own directory (NEXT_DIST_DIR) runs beside other builds in this same web/ directory, so it must not
 * write the files they share. Next's TypeScript setup would add `<distDir>/types/**` to tsconfig.json; pointing it at
 * a per-directory config that only extends tsconfig.json makes it leave tsconfig.json alone. It also skips the
 * type-check pass: `pnpm typecheck` is the type gate, and that pass would read next-env.d.ts, which every build
 * rewrites for its own directory (scripts/dev.sh puts it back to `.next` afterwards). The compiled output is the same.
 */
function isolatedBuild(dir: string): NextConfig["typescript"] {
  const tsconfig = `${dir}.tsconfig.json`;
  const content = `${JSON.stringify({ extends: "./tsconfig.json" }, null, 2)}\n`;
  const path = join(root, tsconfig);
  // Every process that loads this config (the build and its workers) may get here at once: write a temporary file and
  // rename it, so nobody ever reads a half-written config.
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, content);
    renameSync(temporary, path);
  }
  return { tsconfigPath: tsconfig, ignoreBuildErrors: true };
}

const nextConfig: NextConfig = {
  output: "standalone",
  distDir,
  ...(distDir === ".next" ? {} : { typescript: isolatedBuild(distDir) }),
  reactStrictMode: true,
  poweredByHeader: false,
  // The floating dev badge would sit on top of the embed's iframes and the dock; build and runtime errors still show.
  devIndicators: false,
  // `next dev` would (re)write its managed block into AGENTS.md / CLAUDE.md when a coding assistant runs it. Both files
  // are kept in the repo by hand (the project's rules sit under that block), so the dev server never edits them.
  agentRules: false,
  // The repo has other lockfiles (testkit/); this app is its own root for Turbopack and the standalone trace.
  turbopack: { root },
  outputFileTracingRoot: root,
  // Profile photos and app logos are arbitrary https (and data:) URLs: shown as is, never through an image optimizer
  // that would fetch them server side.
  images: { unoptimized: true },
  experimental: {
    // User imports send up to 50 MB plus a small envelope through the /v1 rewrite; Next cuts proxied bodies at
    // 10 MB by default (the request then fails with a 500 after 30 s), and a big import can take minutes.
    proxyClientMaxBodySize: "52mb",
    proxyTimeout: 300_000,
    // A stack's own build directory is thrown away with the stack (scripts/e2e.sh), so its ~100 MB Turbopack cache would
    // never be read again; a cold build takes seconds.
    ...(distDir === ".next" ? {} : { turbopackFileSystemCacheForBuild: false }),
  },
  env: {
    // The rewrite destination this build was made with (instrumentation.ts compares it with the runtime value).
    ACCOUNTS_API_URL_AT_BUILD: apiUrl,
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/v1/:path*", destination: `${apiUrl}/v1/:path*` },
        { source: "/openapi.json", destination: `${apiUrl}/openapi.json` },
        // Every /.well-known path but security.txt, which the site serves itself.
        { source: "/.well-known/:path((?!security\\.txt$).+)", destination: `${apiUrl}/.well-known/:path` },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  async redirects() {
    // The SolidJS site had the identity card at /identity too; it lives at / now.
    return [{ source: "/identity", destination: "/", permanent: false }];
  },
  async headers() {
    return [
      // The site's own font files never change in place (a new cut gets a new name); the icons and social image may.
      { source: "/fonts/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      {
        source: "/:file(og.png|icon.svg|icon-192.png|icon-512.png|icon-maskable-512.png|apple-touch-icon.png|favicon.ico)",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
      {
        // sdk/v1.js (built by `pnpm build:sdk`) is loaded by apps' pages on other origins.
        source: "/sdk/:file*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "public, max-age=300" },
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
