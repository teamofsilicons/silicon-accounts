/** Allo for /__google-signin (assets/fonts/allo, SIL OFL 1.1). Development only, like the page. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function GET() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") return new Response("Not found", { status: 404 });
  const font = await readFile(join(process.cwd(), "assets/fonts/allo/AlloVariable.woff2"));
  return new Response(new Uint8Array(font), { headers: { "content-type": "font/woff2", "cache-control": "no-store" } });
}
