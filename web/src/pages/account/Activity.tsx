/**
 * /activity — Activity. Placeholder from the web foundation; the web-account builder owns this file.
 */
import { PagePlaceholder } from "../../app/PagePlaceholder";

export default function Activity() {
  return (
    <PagePlaceholder
      title="Account activity"
      description="Sign-ins, id changes and everything else that happened to your account."
      note="A timeline grouped by day: sign-ins, id changes, custodian changes, proofs and app access."
      width="reading"
    />
  );
}
