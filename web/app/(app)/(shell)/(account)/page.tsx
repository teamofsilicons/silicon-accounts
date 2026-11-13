/**
 * "/" with a live session: Home, redesigned from a blank canvas (redesign/decisions.md, 2026-10-30): the page's
 * narrow centred column (Page, 720px), headed by the Carbon's picture, greeting and id (home-identity.tsx), then what
 * needs them (home-needs.tsx), the introduction's three cards until dismissed (home-cards.tsx), then Your Silicons
 * (home-sections.tsx). No apps or account cards for now (Anil, 2026-11-12; designs in /__account).
 * The previous Home stays in components/account/overview, unused. Without a session, proxy.ts serves the public
 * landing page at this address instead (app/landing), so crawlers only ever see the landing; this view keeps the
 * root's title (the site's name) and its noindex. Its text is the site's type system (Inter on the Radix scale,
 * styles/tokens.css; Anil, 2026-11-09).
 */
import { HomeIdentity } from "@/components/account/home-identity";
import { HomeCards } from "@/components/account/home-cards";
import { HomeNeeds } from "@/components/account/home-needs";
import { HomeSilicons } from "@/components/account/home-sections";
import { Page as Column } from "@/components/foundation/layout/layout";

export default function Page() {
  return (
    <Column>
      <HomeIdentity />
      <HomeNeeds />
      <HomeCards />
      <HomeSilicons />
    </Column>
  );
}
