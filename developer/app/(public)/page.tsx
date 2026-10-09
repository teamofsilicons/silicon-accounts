/**
 * /: the public home page (components/home). A signed-in browser never sees it: proxy.ts sends it on to its apps at
 * /apps. Server-rendered; its only script is the header's theme switch and the copy buttons.
 */
import type { Metadata } from "next";
import { HomePage } from "@/components/home/home-page";
import { FAQ, plainAnswer } from "@/components/home/faq";
import { Enhancer } from "@/components/site/enhancer";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { JsonLd, faqLd, pageMetadata } from "@/lib/seo";
import { isSignedIn } from "@/lib/server/signed-in";
import { CANONICAL_ORIGIN, LINKS, ORGANIZATION, SITE_DESCRIPTION } from "@/lib/site";

/** Silicon Apps and Silicon Accounts are open source under MIT. */
const MIT_LICENSE = "https://opensource.org/license/mit";

export const metadata: Metadata = pageMetadata({
  title: "Silicon Developer: build apps for Carbons and Silicons",
  absoluteTitle: true,
  description: SITE_DESCRIPTION,
  path: "/",
});

export default async function Page() {
  const signedIn = await isSignedIn();
  return (
    <>
      <SiteHeader path="/" signedIn={signedIn} />
      <main id="main" tabIndex={-1}>
        <HomePage />
      </main>
      <SiteFooter />
      <Enhancer />
      <JsonLd
        graph={[
          {
            "@type": "WebPage",
            "@id": `${CANONICAL_ORIGIN}/#webpage`,
            url: `${CANONICAL_ORIGIN}/`,
            name: "Silicon Developer: build apps for Carbons and Silicons",
            description: SITE_DESCRIPTION,
            isPartOf: { "@id": `${CANONICAL_ORIGIN}/#website` },
            about: [
              { "@type": "SoftwareApplication", name: "Silicon Apps", applicationCategory: "DeveloperApplication", operatingSystem: "Linux, Windows, macOS", url: LINKS.apps, description: "Where apps for Carbons and Silicons are made, published, found and installed.", license: MIT_LICENSE, sameAs: [LINKS.appsGithub], publisher: { "@type": "Organization", name: ORGANIZATION.name, url: ORGANIZATION.url } },
              { "@type": "SoftwareApplication", name: "Silicon Accounts", applicationCategory: "DeveloperApplication", operatingSystem: "Web, Linux, Windows, macOS", url: LINKS.accounts, description: "Sign-in for Carbons and Silicons: Google, Apple, email, phone and short-lived tokens, with App verification and User verification.", license: MIT_LICENSE, sameAs: [LINKS.accountsGithub], publisher: { "@type": "Organization", name: ORGANIZATION.name, url: ORGANIZATION.url } },
            ],
          },
          faqLd(FAQ.map(faq => ({ question: faq.question, answer: plainAnswer(faq) }))),
        ]}
      />
    </>
  );
}
