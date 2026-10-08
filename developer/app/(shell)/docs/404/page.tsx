/**
 * /docs/404: the docs' "No page here" as a page of its own, rendered on the server. proxy.ts rewrites a page load of
 * an address under /docs that is no page and no group here to this route with status 404 (a notFound() below the
 * root layout would render only in the browser). Client-side navigations still reach the [...slug] route's notFound().
 */
import type { Metadata } from "next";
import { DocsNotFound } from "@/components/docs/no-docs";

export const metadata: Metadata = { title: "Page not found", robots: { index: false, follow: false } };

export default function DocsMissing() {
  return <DocsNotFound />;
}
