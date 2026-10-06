/**
 * /apps — Apps. Placeholder from the web foundation; the web-account builder owns this file.
 */
import { PagePlaceholder } from "../../app/PagePlaceholder";

export default function Apps() {
  return (
    <PagePlaceholder
      title="Apps you have signed into"
      description="Every app you have signed into, what it can see and when it last saw you."
      note="Each app with the details it can see, its last sign-in, and a way to remove its access."
      width="reading"
    />
  );
}
