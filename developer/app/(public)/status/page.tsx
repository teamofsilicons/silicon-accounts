/**
 * /status: whether Silicon Accounts, Silicon Apps and this site are up right now (lib/status.ts, components/status).
 * Server-rendered from one round of checks kept for 30 seconds; no script of its own. /status.json is its JSON twin.
 */
import type { Metadata } from "next";
import { StatusPage } from "@/components/status/status-page";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { JsonLd, breadcrumbLd, pageMetadata } from "@/lib/seo";
import { isSignedIn } from "@/lib/server/signed-in";
import { CANONICAL_ORIGIN } from "@/lib/site";
import { statusReport } from "@/lib/status";

export const dynamic = "force-dynamic";

const TITLE = "Service status";
const DESCRIPTION = "Whether Silicon Accounts, Silicon Apps and Silicon Developer are up right now, with each one's response time, version and the time we checked.";

export const metadata: Metadata = pageMetadata({
  title: TITLE,
  description: DESCRIPTION,
  path: "/status",
  types: { "application/json": "/status.json" },
});

export default async function Page() {
  const [signedIn, report] = await Promise.all([isSignedIn(), statusReport()]);
  return (
    <>
      <SiteHeader path="/status" signedIn={signedIn} />
      <main id="main" tabIndex={-1}>
        <StatusPage report={report} />
      </main>
      <SiteFooter />
      <JsonLd
        graph={[
          {
            "@type": "WebPage",
            "@id": `${CANONICAL_ORIGIN}/status#webpage`,
            url: `${CANONICAL_ORIGIN}/status`,
            name: `${TITLE} · Silicon Developer`,
            description: DESCRIPTION,
            isPartOf: { "@id": `${CANONICAL_ORIGIN}/#website` },
            dateModified: report.checked_at,
            encoding: { "@type": "MediaObject", encodingFormat: "application/json", contentUrl: `${CANONICAL_ORIGIN}/status.json` },
          },
          breadcrumbLd([{ name: "Silicon Developer", path: "/" }, { name: TITLE, path: "/status" }]),
        ]}
      />
    </>
  );
}
