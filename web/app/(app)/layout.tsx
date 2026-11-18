/**
 * Everything that runs in the browser as an app: the account pages, the hosted sign-in pages, device approval, the
 * embed and the style guide share the client providers here (query client, toasts, squircles), so moving between
 * them keeps one query cache. The public landing page (app/landing, served at "/" by proxy.ts) sits outside this
 * group and loads none of it.
 */
import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { DevTools } from "@/components/foundation/dev/dev-tools";
import { Providers } from "@/components/foundation/providers";
import { hasSessionCookie } from "@/lib/server/session";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const surface = (await headers()).get("x-sa-surface") === "embed" ? "embed" : "site";
  // No session cookie means signed out for sure: signed-out pages can render on the server instead of after a round
  // trip. With a cookie, the client asks GET /v1/session (the cookie may have expired).
  const sessionHint = hasSessionCookie(await cookies()) ? "cookie" : "none";
  // The dev tools (development only) on every page here: the account pages, the sign-in pages, device approval and the
  // playgrounds; not the embed, which other sites frame.
  return (
    <Providers surface={surface} sessionHint={sessionHint}>
      {children}
      {process.env.NODE_ENV === "development" && surface !== "embed" ? <DevTools /> : null}
    </Providers>
  );
}
