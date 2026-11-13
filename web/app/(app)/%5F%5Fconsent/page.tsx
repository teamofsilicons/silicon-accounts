/**
 * /__consent: designs for the consent step of an app's sign-in (Anil, 2026-11-13), inside the real hosted frame.
 * Development only, like /__request: production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ConsentLab } from "@/components/kitchen/consent/consent-lab";

export const metadata: Metadata = { title: "Consent lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <ConsentLab />;
}
