/**
 * /__google-signin: the hosted sign-in drawn as Google's current sign-in, in Allo (Anil, 2026-11-19: "copy them exactly,
 * without our design system… use our typeface… playground"). The page is the standalone HTML in
 * redesign/explorations/google-like/index.html, served as it is, so it stays outside Silicon UI and the app's checks; its
 * font comes from /__google-signin/allo. Development only, like /__kitchen: production answers 404 unless ACCOUNTS_KITCHEN=1.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function GET() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") return new Response("Not found", { status: 404 });
  const html = await readFile(join(process.cwd(), "redesign/explorations/google-like/index.html"), "utf8");
  // The file points at the font beside the repository's assets for opening it straight from disk; here it's served.
  const served = html.replace("../../../assets/fonts/allo/AlloVariable.woff2", "/__google-signin/allo");
  return new Response(served, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
