"use client";

/**
 * /authorize: where apps send browsers to sign in (`/authorize?app_id=…&redirect_uri=…&state=…`). It creates the flow
 * from the query (POST /v1/flows, with the browser's time zone for the sign-up suggestion) and continues at
 * /authorize/flow/[id] without asking for the flow again (the query cache hands it over).
 *
 * A link that cannot start shows why and never redirects: an unknown app or an unregistered redirect URI must not
 * send anyone anywhere. Mistakes the server can safely report to the app (its redirect URI is registered) offer a way
 * back to it; the visitor chooses to go.
 */
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/api/errors";
import type { FlowCreate } from "@/lib/api/types";
import { browserTimezone } from "@/lib/format";
import { modernTimezone } from "@/lib/timezones";
import { paths } from "@/lib/navigation";
import { useCreateFlow } from "@/lib/query/auth";
import { useHydrated } from "./flow/hooks";
import { HostedFrame } from "./flow/hosted-frame";
import { rememberAuthorizeQuery, rememberedLook, safeRedirect, SILICON_ACCOUNTS } from "./flow/model";
import { ArrivalScope, LoadingCard, Problem } from "./flow/problem";

export interface AuthorizeProps {
  /** The page's query, as the server received it (first value of each parameter). */
  query: Record<string, string>;
}

export function Authorize({ query }: AuthorizeProps) {
  const hydrated = useHydrated();
  if (!hydrated) {
    return (
      // No "Powered by" until hydration: its palette follows the visitor's theme, known only in the browser.
      <HostedFrame app={null} site title="Signing in" busy poweredBy={false}>
        <LoadingCard />
      </HostedFrame>
    );
  }
  return (
    <ArrivalScope>
      <AuthorizeStart query={query} />
    </ArrivalScope>
  );
}

function AuthorizeStart({ query }: AuthorizeProps) {
  const router = useRouter();
  const create = useCreateFlow();
  const params = new URLSearchParams(query);
  params.delete("timezone");
  const appId = (params.get("app_id") ?? params.get("client_id") ?? "").trim() || null;
  const redirectUri = (params.get("redirect_uri") ?? "").trim() || null;
  const search = params.toString();
  const empty = !appId && !redirectUri;
  const [look] = useState(() => rememberedLook(appId));
  const [error, setError] = useState<ApiError | null>(null);
  const started = useRef(false);

  const bodyOf = (): FlowCreate => ({ ...Object.fromEntries(new URLSearchParams(search)), timezone: modernTimezone(browserTimezone()) }) as unknown as FlowCreate;
  const run = async () => {
    try {
      const flow = await create.mutateAsync(bodyOf());
      rememberAuthorizeQuery(flow.id, search);
      router.replace(paths.flow(flow.id));
    } catch (raw) {
      setError(ApiError.from(raw));
    }
  };
  // Once per visit (a development remount reuses the first request).
  const onArrive = useEffectEvent(() => {
    if (empty || started.current) return;
    started.current = true;
    void run();
  });
  useEffect(() => {
    document.title = "Signing in · Silicon Accounts";
    onArrive();
  }, []);

  const retry = () => {
    setError(null);
    void run();
  };

  if (empty) {
    return (
      <Problem
        title="Nothing to sign in to"
        message="This address is where apps send you to sign in, and this visit did not come from an app."
        hint="Open the app you want to use and choose to sign in there. To manage your own account, go to your account."
        actions={[{ label: "Go to your account", href: paths.home }]}
      />
    );
  }
  if (error) return <AuthorizeProblem error={error} appId={appId} redirectUri={redirectUri} onRetry={retry} />;
  const firstParty = appId === "accounts";
  return (
    <HostedFrame
      app={look ? { app_id: look.app_id, name: look.name, branding: look.branding } : SILICON_ACCOUNTS}
      site={!look || firstParty}
      plain={!look && !firstParty}
      title={look ? `Sign in to ${look.name}` : "Signing in"}
      busy
    >
      <LoadingCard />
    </HostedFrame>
  );
}

/**
 * Why the sign-in link could not start, for the visitor and (in the details) for the app's developers.
 *
 * Every refusal of the link itself (a 4xx other than a rate limit or a disabled app: an unknown app, an unregistered or
 * missing redirect URI, a bad scope, prompt, response type, PKCE method or method) means the app built a broken link.
 * The visitor reads that in plain words and gets a way out (back to the app when the server can safely tell it what
 * went wrong, else their account); the server's exact reason and fix, written for the app's developers, go to the
 * details. A limit, a disabled app, an outage or no network keeps its own words and offers to try again.
 */
function AuthorizeProblem({ error, appId, redirectUri, onRetry }: { error: ApiError; appId: string | null; redirectUri: string | null; onRetry: () => void }) {
  const backTo = safeRedirect(error.redirectTo);
  const details: Array<[string, string | null]> = [["app_id", appId], ["redirect_uri", redirectUri]];
  const retry = [{ label: "Try again", onClick: onRetry }];
  // A limit, an outage, or a request that never got an answer (status 0: the network, or this page itself).
  const retryable = error.code === "rate_limited" || error.status === 0 || error.status >= 500;
  const brokenLink = !retryable && error.code !== "app_disabled" && error.status >= 400;
  const title = (() => {
    switch (error.code) {
      case "unknown_app":
        return "This app is not on Silicon Accounts";
      case "redirect_uri_not_registered":
        return "This sign-in link is not set up right";
      case "app_disabled":
        return "This app is not taking sign-ins right now";
      case "rate_limited":
        return "Too many sign-ins from this network";
      default:
        if (error.isNetwork) return "Silicon Accounts is unreachable";
        if (error.status >= 500) return "Silicon Accounts had a problem";
        if (error.status === 0) return "This sign-in could not start";
        return backTo ? "The app's sign-in link has a mistake" : "This sign-in link does not work";
    }
  })();
  const actions = (() => {
    if (retryable) return retry;
    // The server checked the redirect URI before building this: going back tells the app what went wrong.
    if (backTo) return [{ label: "Back to the app", href: backTo, external: true, variant: "secondary" as const }];
    // Nowhere safe to send the visitor back to: their own account is a way out of the dead end.
    return [{ label: "Go to your account", href: paths.home }];
  })();
  /** What the visitor reads (the server's words, written for the app's developers, go to the details). */
  const words = (() => {
    switch (error.code) {
      case "unknown_app":
        return { message: "The link you followed names an app that Silicon Accounts does not know, so there is nowhere safe to send you back to.", hint: "Go back to the app and try to sign in again. If this keeps happening, the app's sign-in link is wrong." };
      case "redirect_uri_not_registered":
        return { message: "The app asked to send you back to an address it never registered with Silicon Accounts, so the sign-in stops here to keep your account safe. Nothing was shared.", hint: "Go back to the app and tell the people who run it." };
      default:
        if (error.isNetwork) return { message: "The sign-in could not start because Silicon Accounts did not answer.", hint: "Check your connection, then try again." };
        if (error.status >= 500) return { message: "Silicon Accounts could not start this sign-in just now.", hint: "Try again in a moment." };
        if (error.status === 0) return { message: "Something in this page failed before the sign-in could start.", hint: "Reload the page and try again." };
        if (brokenLink) {
          // (The title already says the app's link has a mistake when there is a way back.)
          return backTo
            ? { message: "This sign-in can't start, and nothing was shared.", hint: "Going back to the app tells it what went wrong." }
            : { message: "The link that brought you here has a mistake, so this sign-in can't start. Nothing was shared.", hint: "Go back to the app and try again. If it keeps happening, tell the people who run it." };
        }
        return { message: error.message, hint: error.hint ?? null };
    }
  })();
  // The server's own words, for the app's developers, wherever the visitor reads plainer ones.
  const plain = brokenLink || error.status >= 500 || (error.status === 0 && !error.isNetwork);
  const developerDetails: Array<[string, string | null]> = plain ? [...details, ["reason", error.message], ["fix", error.hint ?? null]] : details;
  return <Problem title={title} message={words.message} hint={words.hint} error={error} details={developerDetails} actions={actions} />;
}
