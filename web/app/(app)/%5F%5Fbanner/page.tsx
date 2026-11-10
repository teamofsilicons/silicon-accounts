/**
 * /__banner: alternatives for Home's introduction banner, to compare and pick from (Anil, 2026-11-10). Development
 * only, like /__kitchen and /__needs: production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BannerLab } from "@/components/kitchen/banner/banner-lab";

export const metadata: Metadata = { title: "Banner lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <BannerLab />;
}
