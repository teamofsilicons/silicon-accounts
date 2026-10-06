/**
 * /developer — the apps this Carbon owns. Placeholder from the web foundation; the web-developer builder owns this
 * file (app grid, "New app" linking to Silicon Apps from /v1/meta).
 */
import { PagePlaceholder } from "../../app/PagePlaceholder";

export default function Developer() {
  return (
    <PagePlaceholder
      title="Your apps"
      description="Apps you own and how they sign Carbons and Silicons in. New apps are created in Silicon Apps."
      note="Your apps as a grid of icons, each opening its sign-in setup, branding, users, webhooks, proofs and embed code."
      width="default"
    />
  );
}
