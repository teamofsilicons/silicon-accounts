/**
 * /authorize — the entry point apps send browsers to. Creates the flow from the query (POST /v1/flows, with the
 * browser's time zone) and continues at /authorize/flow/:id. Unknown apps and unregistered redirect URIs show an
 * error page and never redirect. Foundation version; the web-auth builder owns this file.
 */
import { useLocation, useNavigate } from "@solidjs/router";
import { Show, createSignal, onMount } from "solid-js";
import { Alert } from "../../arc/alert/alert";
import { ApiError, api, type FlowCreate } from "../../api";
import { paths } from "../../app/navigation";
import { browserTimezone } from "../../lib/format";
import styles from "./auth.module.css";

export default function Authorize() {
  const location = useLocation();
  const navigate = useNavigate();
  const [error, setError] = createSignal<ApiError | null>(null);
  onMount(async () => {
    const query = Object.fromEntries(new URLSearchParams(location.search)) as Record<string, string>;
    const body = { ...query, timezone: browserTimezone() } as unknown as FlowCreate;
    try {
      const flow = await api.flows.create(body);
      navigate(paths.flow(flow.id), { replace: true });
    } catch (raw) {
      setError(ApiError.from(raw));
    }
  });
  return (
    <div class={styles.center}>
      <Show when={error()} fallback={<p class={styles.note} role="status">Opening sign-in…</p>}>
        {failure => <Alert tone="danger" title="This sign-in link does not work">{failure().message} {failure().hint}</Alert>}
      </Show>
    </div>
  );
}
