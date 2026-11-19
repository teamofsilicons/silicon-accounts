/**
 * /__landing: the signed-out landing page drawn in the account site's own look (Allo, the site's tokens, the
 * sidebar), with real screens of the account app (Anil, 2026-11-19: "we're just experimenting"). The page at "/" is
 * unchanged; versions are kept here. Development only, like /__kitchen: production builds answer 404 unless
 * ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LandingLab } from "@/components/kitchen/landing/landing-lab";

export const metadata: Metadata = { title: "Landing lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <LandingLab />;
}
