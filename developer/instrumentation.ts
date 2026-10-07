/**
 * Runs once when the Next server starts. A production server refuses to start without a real session secret (the
 * cookies holding Carbons' tokens are sealed with it), and says where it sends people to sign in.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV !== "production") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { accountsApiUrl, accountsPublicUrl, developerPublicUrl, sessionSecret } = await import("./lib/server/config");
  // Throws with the exact problem (missing or shorter than 32 characters).
  sessionSecret();
  console.log(`developer site: ${developerPublicUrl()} signs Carbons in on ${accountsPublicUrl()} and calls the API at ${accountsApiUrl()}`);
}
