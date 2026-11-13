/**
 * /__delete-entry: ways to draw Data & privacy's Delete account row (Anil, 2026-11-12). Development only, like /__delete:
 * production builds answer 404 unless ACCOUNTS_KITCHEN=1. Every way links to the real /privacy/delete.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DeleteEntryLab } from "@/components/kitchen/delete-entry/delete-entry-lab";

export const metadata: Metadata = { title: "Delete account row designs", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <DeleteEntryLab />;
}
