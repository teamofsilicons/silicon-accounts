/**
 * The public landing document under the root layout: the simple hero, and the page's own JSON-LD.
 * The Organization and WebSite JSON-LD come from the root layout. Server-rendered.
 */
import { APPLICATION_ID, JsonLd, WEBSITE_ID, applicationLd } from "@/lib/seo";
import { developerUrl } from "@/lib/server/meta";
import { CANONICAL_ORIGIN, LANDING_TITLE, SITE_DESCRIPTION } from "@/lib/site";
import { LandingPage } from "./landing-page";

export async function PublicLanding({ nonce }: { nonce?: string }) {
  return (
    <>
      <LandingPage developerUrl={await developerUrl()} />
      <JsonLd
        nonce={nonce}
        graph={[
          applicationLd(),
          {
            "@type": "WebPage",
            "@id": `${CANONICAL_ORIGIN}/#webpage`,
            url: `${CANONICAL_ORIGIN}/`,
            name: LANDING_TITLE,
            description: SITE_DESCRIPTION,
            inLanguage: "en",
            isPartOf: { "@id": WEBSITE_ID },
            about: { "@id": APPLICATION_ID },
            primaryImageOfPage: `${CANONICAL_ORIGIN}/og.png`,
          },
        ]}
      />
    </>
  );
}
