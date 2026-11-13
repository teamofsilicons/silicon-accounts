"use client";

import { useRouter, useSearchParams as useNextSearchParams } from "next/navigation";
import { confirmNavigation } from "@/lib/navigation-guard";

export function publishingPath(to: string): string {
  if (to === "/developer") return "/apps";
  if (to === "/developer/invitations") return "/invitations";
  if (to.startsWith("/developer/apps/")) return to.replace("/developer/apps/", "/apps/").replace(/(\/apps\/[^/?]+)(\?|$)/, "$1/publishing$2");
  if (to === "/store" || to.startsWith("/store/")) return `https://apps.teamofsilicons.com${to}`;
  return to;
}
export function useNavigate() {
  const router = useRouter();
  return (to: string) => {
    const href = publishingPath(to);
    void confirmNavigation(href).then(allow => { if (allow) router.push(href); });
  };
}
export function useSearchParams() {
  const params = useNextSearchParams();
  return [params, (values: Record<string, string>) => {
    window.history.pushState(null, "", `${window.location.pathname}?${new URLSearchParams(values)}`);
  }] as const;
}
