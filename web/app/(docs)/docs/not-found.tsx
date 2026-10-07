/** An address under /docs with no page (and every notFound() from the docs routes), inside the docs frame. */
import type { Metadata } from "next";
import { DocsNotFound } from "@/components/docs/no-docs";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return <DocsNotFound />;
}
