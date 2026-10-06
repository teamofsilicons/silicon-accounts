/** Any address the app does not know. */
import { useLocation } from "@solidjs/router";
import { Compass } from "lucide-solid";
import { LinkButton } from "../arc/button/button";
import { EmptyState } from "../arc/empty-state/empty-state";
import styles from "./shell/shell.module.css";

export function NotFound() {
  const location = useLocation();
  return (
    <div class={styles.problem}>
      <EmptyState
        icon={<Compass width={24} height={24} stroke-width={1.5} />}
        title="Nothing lives at this address"
        description={`${location.pathname} is not a page of Silicon Accounts. Check the link, or start again from your account.`}
        action={<LinkButton href="/" variant="secondary">Go to your account</LinkButton>}
      />
    </div>
  );
}
