/**
 * Next.js config for the Silicon Accounts web app.
 *
 * Topology: Next serves the whole site on the public origin (dev http://localhost:8590, prod
 * https://account.teamofsilicons.com) and proxies the API with rewrites, so the browser stays same-origin (cookies,
 * the API's Origin check): /v1/* and /.well-known/* → ACCOUNTS_API_URL (default http://127.0.0.1:8589). Provider
 * callbacks (/v1/oauth/callback/*, Apple's form_post too) and every API call pass through unchanged, Set-Cookie and
 * Location included.
 *
 * ACCOUNTS_API_URL is read when this file loads: at `next dev` start, and at `next build` for `next start` and the
 * standalone server (Next bakes rewrites into the build). Build with the address the server will use; instrumentation.ts
 * warns at start when the environment says otherwise.
 *
 * Security headers for pages (nonce CSP, frame-ancestors, X-Frame-Options…) come from proxy.ts; this file adds the
 * SDK's CORS and cache headers.
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const root = dirname(fileURLToPath(import.meta.url));
const apiUrl = (process.env.ACCOUNTS_API_URL ?? "http://127.0.0.1:8589").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  // The floating dev badge would sit on top of the embed's iframes and the dock; build and runtime errors still show.
  devIndicators: false,
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
  },
  env: {
    // The rewrite destination this build was made with (instrumentation.ts compares it with the runtime value).
    ACCOUNTS_API_URL_AT_BUILD: apiUrl,
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/v1/:path*", destination: `${apiUrl}/v1/:path*` },
        { source: "/.well-known/:path*", destination: `${apiUrl}/.well-known/:path*` },
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
