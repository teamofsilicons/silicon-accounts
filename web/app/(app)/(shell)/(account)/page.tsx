/**
 * "/" with a live session: Home, what needs the signed-in account and its Silicons and apps (web-account: app/(app)/(shell)/(account)/
 * and components/account/). Without one, proxy.ts serves the public landing page at this address instead (app/landing),
 * so crawlers only ever see the landing; this view keeps the root's title (the site's name) and its noindex.
 */
import { Home } from "@/components/account/home";

export default function Page() {
  return <Home />;
}
