/**
 * /__signin: the hosted "Sign in to <app>" page in versions to compare (Anil, 2026-11-19: "let's create a playground and
 * work on them, starting with sign in to any app with team of silicons account"). Development only, like /__banner:
 * production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SigninLab } from "@/components/kitchen/signin/signin-lab";

export const metadata: Metadata = { title: "Sign-in lab", robots: { index: false, follow: false } };

export default function Page() {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  return <SigninLab />;
}
