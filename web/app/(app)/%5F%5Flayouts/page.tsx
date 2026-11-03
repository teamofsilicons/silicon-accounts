/**
 * /__layouts: the layout lab, the account site's frame drawn in its loading state to explore shell, sidebar, element
 * and content layouts. Development only, like /__kitchen: production builds answer 404 unless ACCOUNTS_KITCHEN=1.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readLayout } from "@/components/kitchen/layouts/choices";
import { LayoutLab } from "@/components/kitchen/layouts/layout-lab";

export const metadata: Metadata = { title: "Layout lab", robots: { index: false, follow: false } };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production" && process.env.ACCOUNTS_KITCHEN !== "1") notFound();
  const params = await searchParams;
  return <LayoutLab initial={readLayout(params)} controls={params.ui !== "0"} />;
}
