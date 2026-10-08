import { Suspense } from "react";
import { AppVerificationPage } from "@/components/developer/verification/app-verification-page";
import { PageSkeleton } from "@/components/foundation/shell/developer-shell";

export const metadata = { title: "App verification · Silicon Developer" };

export default function PageContent() {
  return <Suspense fallback={<PageSkeleton />}><AppVerificationPage /></Suspense>;
}
