/**
 * The public pages: the home page and the docs. Server-rendered HTML that search engines and Silicons may read
 * (the root layout keeps the signed-in portal out of indexes). Each page composes the site header and footer itself,
 * since the header's menu carries the page's own navigation (components/site).
 */
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { robots: { index: true, follow: true } };

export default function PublicLayout({ children }: { children: ReactNode }) {
  return children;
}
