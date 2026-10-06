/**
 * /authorize: where apps send browsers to sign in (`/authorize?app_id=…&redirect_uri=…&state=…`). It creates the flow
 * from the query (POST /v1/flows, with the browser's time zone for the sign-up suggestion) and continues at
 * /authorize/flow/:id without asking for the flow again.
 *
 * A link that cannot start shows why and never redirects: an unknown app or an unregistered redirect URI must not
 * send anyone anywhere. Mistakes the server can safely report to the app (its redirect URI is registered) offer a way
 * back to it; the visitor chooses to go.
 */
import { useLocation, useNavigate } from "@solidjs/router";
import { Show, createSignal, onMount } from "solid-js";
import { ApiError, api, type FlowCreate } from "../../api";
import { paths } from "../../app/navigation";
import { browserTimezone } from "../../lib/format";
import { HostedFrame } from "./flow/HostedFrame";
import { asHosted, handOver, rememberAuthorizeQuery, rememberedLook, safeRedirect } from "./flow/model";
import { LoadingCard, Problem } from "./Problem";

export default function Authorize() {
  const location = useLocation();
  const navigate = useNavigate();
  const query = new URLSearchParams(location.search);
  query.delete("timezone");
  const appId = (query.get("app_id") ?? query.get("client_id") ?? "").trim() || null;
  const redirectUri = (query.get("redirect_uri") ?? "").trim() || null;
  const look = rememberedLook(appId);
  const [error, setError] = createSignal<ApiError | null>(null);
  const empty = !appId && !redirectUri;

  const start = async () => {
    setError(null);
    const body = { ...Object.fromEntries(query), timezone: browserTimezone() } as unknown as FlowCreate;
    try {
      const flow = asHosted(await api.flows.create(body));
      handOver(flow);
      rememberAuthorizeQuery(flow.id, query.toString());
      navigate(paths.flow(flow.id), { replace: true });
    } catch (raw) {
      setError(ApiError.from(raw));
    }
  };

  onMount(() => {
    document.title = "Signing in · Silicon Accounts";
    if (!empty) void start();
  });

  return (
    <Show
      when={!empty}
      fallback={
        <Problem
          title="Nothing to sign in to"
          message="This address is where apps send you to sign in, and this visit did not come from an app."
          hint="Open the app you want to use and choose to sign in there. To manage your own account, go to your account."
          actions={[{ label: "Go to your account", href: paths.home }]}
        />
      }
    >
      <Show
        when={error()}
        fallback={
          <HostedFrame app={look ?? { app_id: "accounts", name: "Silicon Accounts" }} site={!look || appId === "accounts"} plain={!look && appId !== "accounts"} title={look ? `Sign in to ${look.name}` : "Signing in"} busy>
            <LoadingCard />
          </HostedFrame>
        }
      >
        {failure => <AuthorizeProblem error={failure()} appId={appId} redirectUri={redirectUri} onRetry={() => void start()} />}
      </Show>
    </Show>
  );
}

/** Why the sign-in link could not start, for the visitor and (in the details) for the app's developers. */
function AuthorizeProblem(props: { error: ApiError; appId: string | null; redirectUri: string | null; onRetry: () => void }) {
  const error = () => props.error;
  const backTo = () => {
    const value = error().details.redirect_to;
    return typeof value === "string" ? safeRedirect(value) : null;
  };
  const details = (): Array<[string, string | null]> => [["app_id", props.appId], ["redirect_uri", props.redirectUri]];
  const retry = () => [{ label: "Try again", onClick: props.onRetry }];
  const title = (): string => {
    switch (error().code) {
      case "unknown_app":
        return "This app is not on Silicon Accounts";
      case "redirect_uri_not_registered":
        return "This sign-in link is not set up right";
      case "app_disabled":
        return "This app is not taking sign-ins right now";
      case "rate_limited":
        return "Too many sign-ins from this network";
      default:
        if (error().isNetwork) return "Silicon Accounts is unreachable";
        if (error().status >= 500) return "Silicon Accounts had a problem";
        return backTo() ? "The app's sign-in link has a mistake" : "This sign-in link does not work";
    }
  };
  const actions = () => {
    if (error().code === "rate_limited" || error().isNetwork || error().status >= 500) return retry();
    // The server checked the redirect URI before building this: going back tells the app what went wrong.
    if (backTo()) return [{ label: "Back to the app", href: backTo() as string, variant: "secondary" as const }];
    return [];
  };
  /**
   * What the visitor reads. A link that names no known app, or a return address the app never registered, means the
   * app's link is broken: the visitor gets that in plain words, and the server's exact reason goes to the details for
   * the app's developers. Everything else keeps the server's own sentence.
   */
  const words = (): { message: string; hint: string | null } => {
    switch (error().code) {
      case "unknown_app":
        return { message: "The link you followed names an app that Silicon Accounts does not know, so there is nowhere safe to send you back to.", hint: "Go back to the app and try to sign in again. If this keeps happening, the app's sign-in link is wrong." };
      case "redirect_uri_not_registered":
        return { message: "The app asked to send you back to an address it never registered with Silicon Accounts, so the sign-in stops here to keep your account safe. Nothing was shared.", hint: "Go back to the app and tell the people who run it." };
      default:
        return { message: error().message, hint: error().hint ?? null };
    }
  };
  const developerDetails = (): Array<[string, string | null]> =>
    error().code === "unknown_app" || error().code === "redirect_uri_not_registered" ? [...details(), ["reason", error().message], ["fix", error().hint ?? null]] : details();
  return <Problem title={title()} message={words().message} hint={words().hint} error={error()} details={developerDetails()} actions={actions()} />;
}
