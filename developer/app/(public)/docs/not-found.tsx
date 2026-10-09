/** An address under /docs with no page (and every notFound() from the docs routes), inside the docs frame. */
import type { Metadata } from "next";
import { DocsFrame } from "@/components/docs/docs-frame";
import { DocsNotFound } from "@/components/docs/no-docs";

export const metadata: Metadata = { title: { absolute: "Page not found · Silicon Developer docs" }, robots: { index: false, follow: true } };

export default function NotFound() {
  return <DocsFrame path="/docs/404"><DocsNotFound /></DocsFrame>;
}
