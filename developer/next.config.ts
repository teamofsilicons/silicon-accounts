/**
 * Next.js config for developers.teamofsilicons.com (the developer platform).
 *
 * Topology: this site is a BFF ("backend for frontend"). The browser only ever talks to this origin; the Next server
 * holds the Carbon's Silicon Accounts tokens in sealed httpOnly cookies and calls the Silicon Accounts API itself:
 *   /api/accounts/*  → ${ACCOUNTS_API_URL}/v1/* with Authorization: Bearer (app/api/accounts/[...path]/route.ts)
 *   /auth/sign-in    → the hosted sign-in on ${ACCOUNTS_PUBLIC_URL}/authorize (first-party app `developer`, PKCE S256)
 *   /auth/callback   → exchanges the code server side, seals the tokens into the session cookie
 *   /auth/sign-out   → revokes the refresh token and clears the cookie
 * No rewrites: every environment value is read at request time (lib/server/config.ts), so one build serves any stack.
 *
 * NEXT_DIST_DIR gives a build its own directory (default `.next`), so local stacks on other ports (scripts/dev.sh)
 * never share or overwrite a build, as in web/.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const root = dirname(fileURLToPath(import.meta.url));

/** The build directory: `.next`, or NEXT_DIST_DIR (`.next-<name>`, inside developer/, which .gitignore and tsconfig skip). */
function distDirFromEnv(): string {
  const wanted = process.env.NEXT_DIST_DIR?.trim() || ".next";
  if (!/^\.next(-[A-Za-z0-9_.-]+)?$/.test(wanted)) {
    throw new Error(`NEXT_DIST_DIR must look like .next-<name> (a directory in developer/, e.g. .next-8935), got "${wanted}"`);
  }
  return wanted;
}

const distDir = distDirFromEnv();

/**
 * A build in its own directory (NEXT_DIST_DIR) runs beside other builds in this directory: point Next's TypeScript setup
 * at a per-directory config that only extends tsconfig.json, so tsconfig.json is never rewritten, and skip the type pass
 * (`pnpm typecheck` is the type gate). Same as web/next.config.ts.
 */
function isolatedBuild(dir: string): NextConfig["typescript"] {
  const tsconfig = `${dir}.tsconfig.json`;
  const content = `${JSON.stringify({ extends: "./tsconfig.json" }, null, 2)}\n`;
  const path = join(root, tsconfig);
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
  // Keep the standalone listener's exact origin for internal proxy rewrites. NextURL otherwise
  // normalizes 127.0.0.1 to localhost, making a Caddy-forwarded HTTPS rewrite look external.
  skipProxyUrlNormalize: true,
  devIndicators: false,
  // AGENTS.md is kept by hand; `next dev` must not rewrite it.
  agentRules: false,
  // The repository has other lockfiles (web/, testkit/); this app is its own root for Turbopack and the standalone trace.
  turbopack: { root },
  outputFileTracingRoot: root,
  // Logos and profile photos are arbitrary https (and data:) URLs: shown as is, never fetched server side.
  images: { unoptimized: true },
  // `next dev` answers its dev assets to localhost only by default; local stacks are also opened on 127.0.0.1.
  allowedDevOrigins: ["127.0.0.1"],
  // The site's own font files never change in place (a new cut gets a new name); the icons and social image may.
  async headers() {
    return [
      { source: "/fonts/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/:file(og.png|icon.svg|icon-192.png|icon-512.png|icon-maskable-512.png|apple-touch-icon.png|favicon.ico)", headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }] },
      ...["/docs.md", "/docs/:path(.+\\.md)"].map(source => ({ source, headers: [{ key: "Content-Type", value: "text/markdown; charset=utf-8" }, { key: "Cache-Control", value: "public, max-age=300, stale-while-revalidate=86400" }, { key: "Access-Control-Allow-Origin", value: "*" }] })),
    ];
  },
  experimental: {
    ...(distDir === ".next" ? {} : { turbopackFileSystemCacheForBuild: false }),
  },
};

export default nextConfig;
