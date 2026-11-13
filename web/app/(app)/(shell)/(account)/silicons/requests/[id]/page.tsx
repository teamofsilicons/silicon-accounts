/**
 * /silicons/requests/[id]: a request waiting for you, a Silicon asking you to look after it or a Carbon handing one to
 * you (components/account/silicons/request-page.tsx).
 */
import type { Metadata } from "next";
import { RequestPage } from "@/components/account/silicons/request-page";

export const metadata: Metadata = { title: "Request" };

export default async function Page({ params }: PageProps<"/silicons/requests/[id]">) {
  const { id } = await params;
  return <RequestPage id={decodeURIComponent(id)} />;
}
