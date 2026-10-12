/**
 * The whole public landing document under the root layout: the site header, the landing page in <main>, the footer
 * and the page's own JSON-LD (Silicon Accounts as an application, the page). The code blocks' copy buttons are
 * Silicon UI's CopyButton, the page's only client code. The Organization and WebSite JSON-LD come from the root
 * layout. Server-rendered; the developer site's address comes from GET /v1/meta.
 */
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { APPLICATION_ID, JsonLd, WEBSITE_ID, applicationLd } from "@/lib/seo";
import { developerUrl } from "@/lib/server/meta";
import { CANONICAL_ORIGIN, LANDING_TITLE, SITE_DESCRIPTION } from "@/lib/site";
import { LandingPage } from "./landing-page";

export async function PublicLanding({ nonce }: { nonce?: string }) {
  const developer = await developerUrl();
  return (
    <>
      <SiteHeader docsUrl={`${developer}/docs/accounts`} />
      <main id="main" tabIndex={-1}>
        <LandingPage developerUrl={developer} />
      </main>
      <SiteFooter developerUrl={developer} />
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
