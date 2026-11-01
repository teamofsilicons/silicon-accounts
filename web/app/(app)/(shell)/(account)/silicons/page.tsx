/**
 * /silicons: the Silicons you are custodian of, custodian requests waiting for you, and creating a Silicon (web-account:
 * app/(app)/(shell)/(account)/ and components/account/). Each Silicon has its own page, /silicons/[uuid].
 */
import type { Metadata } from "next";
import { Suspense } from "react";
import { Silicons } from "@/components/account/silicons/silicons";

export const metadata: Metadata = { title: "Silicons" };

export default function Page() {
  // Silicons reads ?new from the address (useSearchParams), which needs a Suspense boundary.
  return (
    <Suspense>
      <Silicons />
    </Suspense>
  );
}
