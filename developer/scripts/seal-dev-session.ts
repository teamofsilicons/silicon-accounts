/**
 * Development only: seals a token pair into the developer site's session cookie, for checking pages against a local
 * stack without going through the hosted sign-in (for example before the `developer` app exists on that stack, with a
 * first-party token from `accounts login`).
 *
 *   ACCESS_TOKEN=eyJ… REFRESH_TOKEN=sar_… [EXPIRES_IN=1800] [SUB=a8K] pnpm seal-dev-session
 *
 * Prints `sa_dev_session=<sealed>` for a Cookie header (or a browser's cookie store). It refuses to run with
 * NODE_ENV=production, and it only works with the development secret or the DEVELOPER_SESSION_SECRET you pass.
 */
import { seal } from "../lib/server/seal";

if (process.env.NODE_ENV === "production") {
  console.error("error: seal-dev-session is for development stacks only (NODE_ENV=production)");
  process.exit(2);
}
const access = process.env.ACCESS_TOKEN?.trim();
const refresh = process.env.REFRESH_TOKEN?.trim();
if (!access || !refresh) {
  console.error("error: set ACCESS_TOKEN (eyJ…) and REFRESH_TOKEN (sar_…)");
  console.error("hint: ACCESS_TOKEN=eyJ… REFRESH_TOKEN=sar_… pnpm seal-dev-session");
  process.exit(2);
}
const now = Date.now();
const session = {
  v: 1,
  at: access,
  rt: refresh,
  ae: now + Number(process.env.EXPIRES_IN ?? 1800) * 1000,
  re: now + 900 * 24 * 60 * 60 * 1000,
  sub: process.env.SUB ?? "",
};
console.log(`sa_dev_session=${seal(session, "sa_dev_session")}`);
