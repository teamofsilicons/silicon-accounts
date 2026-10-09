/**
 * /docs/404: the docs' "No page here" as a page of its own, rendered on the server. proxy.ts rewrites a page load of
 * an address under /docs that is no page and no group here to this route with status 404.
 */
import type { Metadata } from "next";
import { DocsFrame } from "@/components/docs/docs-frame";
import { DocsNotFound } from "@/components/docs/no-docs";

export const metadata: Metadata = { title: { absolute: "Page not found · Silicon Developer docs" }, robots: { index: false, follow: true } };

export default function DocsMissing() {
  return <DocsFrame path="/docs/404"><DocsNotFound /></DocsFrame>;
}
