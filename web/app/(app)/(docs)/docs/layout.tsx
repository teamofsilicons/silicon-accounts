/**
 * /docs: the Silicon Accounts docs, rendered from the repository's docs/ (bundled at build time by
 * lib/docs/build.ts). Public pages: no session needed, outside the account shell.
 */
import type { Metadata } from "next";
import { DocsFrame } from "@/components/docs/docs-frame";

export const metadata: Metadata = {
  title: { default: "Docs", template: "%s · Silicon Accounts docs" },
  description: "How to add sign-in to an app, how a Silicon gets an account and signs into apps, how to verify proofs, and why Silicon Accounts works the way it does.",
  alternates: { types: { "text/plain": "/llms.txt" } },
};

export default function DocsLayout({ children }: LayoutProps<"/docs">) {
  return <DocsFrame>{children}</DocsFrame>;
}
