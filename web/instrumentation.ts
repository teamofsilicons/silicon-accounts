/**
 * Runs once when the Next server starts. Next bakes rewrites into the build, so the API address the /v1 proxy uses is
 * the one `next build` saw; say so loudly when the environment now names another one.
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  const built = process.env.ACCOUNTS_API_URL_AT_BUILD ?? "";
  const runtime = (process.env.ACCOUNTS_API_URL ?? "").replace(/\/+$/, "");
  if (runtime && built && runtime !== built) {
    console.warn(
      `Silicon Accounts web: /v1 and /.well-known are proxied to ${built} (the ACCOUNTS_API_URL this build was made with), ` +
      `but ACCOUNTS_API_URL is now ${runtime}. Rewrites are fixed at build time: rebuild with ACCOUNTS_API_URL=${runtime} pnpm build.`,
    );
  }
}
