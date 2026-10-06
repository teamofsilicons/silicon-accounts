import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, defineConfig, type Plugin, type ProxyOptions, type ResolvedConfig } from "vite";
import solid from "vite-plugin-solid";

const root = dirname(fileURLToPath(import.meta.url));

/** Where the Accounts API server listens in development (see spec 00-overview: port 8590). */
const apiTarget = process.env.ACCOUNTS_API_URL ?? "http://127.0.0.1:8590";

/**
 * Paths the API server owns. Everything else is the single-page app. The embed and SDK are proxied at their served
 * paths only, so their sources stay reachable in development: /embed/buttons.html?app_id=… (with hot reload) and
 * /sdk/v1.ts. The proxied /embed/v1/buttons and /sdk/v1.js are the built files the API server serves from
 * ACCOUNTS_WEB_DIST.
 */
const proxied = ["/v1/", "/.well-known/", "/embed/v1/", "/sdk/v1.js", "/healthz", "/readyz"];
const proxy: Record<string, ProxyOptions> = Object.fromEntries(
  // changeOrigin stays false so cookies and the CSRF Origin check see the browser-facing origin.
  proxied.map(path => [path, { target: apiTarget, changeOrigin: false, ws: false }]),
);

/**
 * The embed page is authored at `embed/buttons.html` but served at `/embed/v1/buttons`, so the built file
 * moves to `dist/embed/v1/buttons.html` once Vite has written it.
 */
function embedLayout(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "accounts:embed-layout",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
    },
    async writeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      const from = resolve(outDir, "embed/buttons.html");
      const to = resolve(outDir, "embed/v1/buttons.html");
      try {
        await stat(from);
      } catch {
        return;
      }
      await mkdir(dirname(to), { recursive: true });
      await rm(to, { force: true });
      await rename(from, to);
    },
  };
}

/**
 * `sdk/v1.ts` ships as one dependency-free IIFE at `dist/sdk/v1.js` that third-party pages load with a
 * plain <script>. Rolldown cannot mix an IIFE with the app's ES modules in one pass, so the main build
 * runs a second, isolated library build when it finishes.
 */
function sdkBundle(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "accounts:sdk-bundle",
    apply: "build",
    configResolved(resolved) {
      config = resolved;
    },
    async closeBundle() {
      if (config.build.ssr || config.build.watch) return;
      const outDir = resolve(config.root, config.build.outDir, "sdk");
      await build({
        configFile: false,
        root: config.root,
        logLevel: "warn",
        publicDir: false,
        define: { __ACCOUNTS_WEB_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0") },
        build: {
          outDir,
          emptyOutDir: false,
          target: "es2019",
          minify: true,
          sourcemap: false,
          copyPublicDir: false,
          lib: {
            entry: resolve(config.root, "sdk/v1.ts"),
            formats: ["iife"],
            name: "SiliconAccountsSdk",
            fileName: () => "v1.js",
          },
        },
      });
    },
  };
}

export default defineConfig({
  root,
  plugins: [solid(), embedLayout(), sdkBundle()],
  define: {
    __ACCOUNTS_WEB_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.0.0"),
  },
  server: {
    // The canonical development origin is http://localhost:5190 (it must match ACCOUNTS_EXTRA_ALLOWED_ORIGINS).
    port: 5190,
    strictPort: true,
    proxy,
  },
  preview: {
    port: 5191,
    strictPort: false,
    proxy,
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: true,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: {
        app: resolve(root, "index.html"),
        embed: resolve(root, "embed/buttons.html"),
      },
    },
  },
});
