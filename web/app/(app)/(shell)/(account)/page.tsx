/**
 * "/" with a live session: Home, redesigned from a blank canvas (redesign/decisions.md, 2026-10-30): the page's
 * narrow centred column (Page, 720px), headed by the Carbon's picture, greeting and id (home-identity.tsx), then what
 * needs them (home-needs.tsx), the introduction's three cards until dismissed (home-cards.tsx), then Your Silicons
 * and Your apps (home-sections.tsx).
 * The previous Home stays in components/account/overview, unused. Without a session, proxy.ts serves the public
 * landing page at this address instead (app/landing), so crawlers only ever see the landing; this view keeps the
 * root's title (the site's name) and its noindex.
 */
import { HomeIdentity } from "@/components/account/home-identity";
import { HomeCards } from "@/components/account/home-cards";
import { HomeNeeds } from "@/components/account/home-needs";
import { HomeApps, HomeSilicons } from "@/components/account/home-sections";
import { Page as Column } from "@/components/foundation/layout/layout";

export default function Page() {
  return (
    <Column>
      <HomeIdentity />
      <HomeNeeds />
      <HomeCards />
      <HomeSilicons />
      <HomeApps />
    </Column>
  );
}
