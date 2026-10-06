/**
 * /device — approve a CLI sign-in (device flow): sign in first if needed, show the client label and code, then
 * Approve or Deny. Placeholder from the web foundation; the web-auth builder owns this file.
 */
import { useSearchParams } from "@solidjs/router";
import { PagePlaceholder } from "../../app/PagePlaceholder";

export default function Device() {
  const [params] = useSearchParams<{ code?: string }>();
  return (
    <PagePlaceholder
      title="Approve a sign-in"
      description="The accounts CLI is asking to sign in as you. Check the code matches what your terminal shows."
      note={params.code ? `Code ${params.code}: approve or deny it here.` : "Enter the code your terminal shows, then approve or deny it."}
      width="narrow"
    />
  );
}
