/**
 * /__delete: Delete account as built beside three other designs (Anil, 2026-11-12). Development only, like /__activity:
 * production builds answer 404 unless ACCOUNTS_KITCHEN=1. Nothing on it deletes.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DeleteLab } from "@/components/kitchen/delete/delete-lab";

export const metadata: Metadata = { title: "Delete account designs", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <DeleteLab />;
}
