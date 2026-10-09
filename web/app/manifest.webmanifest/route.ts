/** GET /manifest.webmanifest: the web app manifest (name, colours, icons). */
import { publicResponse } from "@/lib/server/public-response";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";

export function GET(request: Request) {
  const manifest = {
    name: SITE_NAME,
    short_name: "Accounts",
    description: SITE_DESCRIPTION,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#F7F8FA",
    theme_color: "#1F5FB8",
    lang: "en",
    categories: ["productivity", "security", "utilities"],
    icons: [
      { src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
      { src: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { src: "/icon-512.png", type: "image/png", sizes: "512x512" },
      { src: "/icon-maskable-512.png", type: "image/png", sizes: "512x512", purpose: "maskable" },
    ],
  };
  return publicResponse(request, `${JSON.stringify(manifest, null, 2)}\n`, { type: "application/manifest+json; charset=utf-8", maxAge: 86400 });
}
