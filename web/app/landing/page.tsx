/**
 * The public landing page (components/landing), served at "/" for anyone not signed in: proxy.ts rewrites a page load
 * of "/" without a live session here, and sends a direct visit to /landing back to "/". A route of its own, outside
 * app/(app), so its module graph holds no client providers and no account shell: the page ships only its two islands
 * (the theme switch and the copy buttons).
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { PublicLanding } from "@/components/landing/public-landing";
import { pageMetadata } from "@/lib/seo";
import { LANDING_TITLE, SITE_DESCRIPTION } from "@/lib/site";

export const metadata: Metadata = pageMetadata({ title: LANDING_TITLE, absoluteTitle: true, description: SITE_DESCRIPTION, path: "/" });

export default async function Page() {
  return <PublicLanding nonce={(await headers()).get("x-nonce") ?? undefined} />;
}
