/**
 * "/" with a live session: the identity card of the signed-in Carbon or Silicon (web-account: app/(app)/(shell)/(account)/
 * and components/account/). Without one, proxy.ts serves the public landing page at this address instead (app/landing),
 * so crawlers only ever see the landing; this view keeps the root's title (the site's name) and its noindex.
 */
import { Home } from "@/components/account/home";

export default function Page() {
  return <Home />;
}
