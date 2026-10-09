/**
 * /docs/search?q=&product=&kind=: the docs search as a server-rendered page. It is where the header's search link goes
 * without script, the WebSite SearchAction's target, and where Enter lands from the search dialog with no result
 * picked. A plain GET form; results rank with the same code as the dialog and /api/docs/search.
 */
import type { Metadata } from "next";
import { Search } from "lucide-react";
import { DocsFrame } from "@/components/docs/docs-frame";
import { DocsSearchPage } from "@/components/docs/search-page";
import { pageMetadata } from "@/lib/seo";

export async function generateMetadata({ searchParams }: PageProps<"/docs/search">): Promise<Metadata> {
  const q = (await searchParams).q;
  const query = (Array.isArray(q) ? q[0] : q)?.trim();
  return pageMetadata({
    title: query ? `“${query.slice(0, 60)}”: search the docs` : "Search the docs",
    suffix: "Silicon Developer docs",
    description: "Search the Silicon Apps and Silicon Accounts docs: guides, explanations and references, every command, endpoint, field and error.",
    path: "/docs/search",
    index: false,
  });
}

export default async function Page({ searchParams }: PageProps<"/docs/search">) {
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? null;
  return (
    <DocsFrame path="/docs/search">
      <DocsSearchPage query={one(params.q)} product={one(params.product)} kind={one(params.kind)} icon={<Search size={18} strokeWidth={1.75} aria-hidden="true" />} />
    </DocsFrame>
  );
}
