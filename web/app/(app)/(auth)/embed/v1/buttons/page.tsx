/**
 * /embed/v1/buttons?app_id=…&redirect_uri=…: the sign-in buttons apps put in an iframe (web-auth area). proxy.ts sets
 * this page's frame-ancestors from the app's allowed_origins and tells the page (x-sa-embed-framing) whether any are
 * configured; the root layout renders it as the transparent "embed" surface.
 */
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { EmbedButtons } from "@/components/auth/embed/embed-buttons";

export const metadata: Metadata = { title: "Sign in with Silicon Accounts", robots: { index: false, follow: false } };

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * `theme` describes the app's page around the frame. Declaring the same color scheme from the first byte keeps the
 * frame's canvas transparent on a dark page before the buttons hydrate (a frame whose scheme differs from its page's
 * is painted opaque). Without `theme` the frame declares nothing, like most pages.
 */
export async function generateViewport({ searchParams }: PageProps<"/embed/v1/buttons">): Promise<Viewport> {
  const theme = first((await searchParams).theme);
  if (theme === "dark" || theme === "light") return { colorScheme: theme };
  if (theme === "auto") return { colorScheme: "light dark" };
  return {};
}

export default async function Page({ searchParams }: PageProps<"/embed/v1/buttons">) {
  const raw = await searchParams;
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const value0 = first(value);
    if (typeof value0 === "string") query[key] = value0;
  }
  const framing = (await headers()).get("x-sa-embed-framing");
  return <EmbedButtons query={query} framingAllowed={framing === "allowed"} />;
}
