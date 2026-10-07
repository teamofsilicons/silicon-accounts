"use client";

/**
 * /sign-in: the account site's own sign-in, both ends of it.
 *
 *   /sign-in?return_to=/silicons        starts the hosted flow for the first-party app `accounts`, whose redirect is
 *                                       this page, and remembers return_to against the flow's state
 *   /sign-in?code=…&state=…             the flow came back (the session cookie is already set): go to return_to
 *   /sign-in?error=access_denied&state  it ended without signing in: say so and offer to start again
 *
 * A code or error is a return only when this browser saved its state when the sign-in started. Anyone can link to this
 * page with any `state`, `error` and `error_description`, so with an unknown state the page ignores them and acts as a
 * plain visit, and it never shows the address's own `error` or `error_description`: an ended sign-in reads in fixed
 * words chosen by its error code (`endedCopy`).
 *
 * `prompt`, `method` and `intent` pass through (never an email or phone: login_hint is ignored), so the account site
 * (and the CLI's device page) can ask for a fresh sign-in, a method or the sign-up page. A browser that is already
 * signed in (and asks for no prompt) goes straight to return_to.
 *
 * The round trip's helpers (firstPartySignInUrl, sameSitePath, the saved return per state) are the foundation's, in
 * lib/query/session.ts: every first-party sign-in ends here, and /device gets its code back after signing in.
 */
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { FlowPrompt, SigninMethod } from "@/lib/api/types";
import { paths } from "@/lib/navigation";
import { firstPartySignInUrl, forgetSignInReturn, sameSitePath, savedSignInReturn, useRefreshSession, useSession } from "@/lib/query/session";
import { useHydrated } from "./flow/hooks";
import { HostedFrame } from "./flow/hosted-frame";
import { SILICON_ACCOUNTS } from "./flow/model";
import { ArrivalScope, LoadingCard, Problem } from "./flow/problem";

/** A sign-in this browser started that came back here. */
interface Arrival {
  state: string;
  /** Set when it ended without signing in (`access_denied`, `login_required`…). */
  error: string | null;
  /** Where it was going (the account site's home when the saved path is not one this site can go back to). */
  path: string;
}

/** The return in this page's address, or null when there is none or this browser never started it. */
function arrivalOf(search: Pick<URLSearchParams, "get">): Arrival | null {
  const state = search.get("state");
  const error = search.get("error");
  if (!state || (!search.get("code") && !error)) return null;
  const saved = savedSignInReturn(state);
  if (saved === null) return null;
  return { state, error: error || null, path: sameSitePath(saved) ?? paths.home };
}

/**
 * An ended sign-in in fixed words, chosen by its error code. The page never repeats the address's `error` or
 * `error_description`: this is the account site's own page, and those are whatever the link says.
 */
function endedCopy(error: string): { title: string; message: string; hint: string } {
  switch (error) {
    case "access_denied":
      return { title: "You did not sign in", message: "You cancelled the sign-in, so nothing changed.", hint: "Sign in again whenever you are ready." };
    case "login_required":
    case "consent_required":
    case "interaction_required":
      return { title: "Sign-in did not finish", message: "The sign-in needed you to sign in or confirm something, so it stopped before you were signed in.", hint: "Sign in again whenever you are ready." };
    case "server_error":
    case "temporarily_unavailable":
      return { title: "Sign-in did not finish", message: "Silicon Accounts could not finish the sign-in just now, so you are not signed in.", hint: "Sign in again in a moment." };
    default:
      return { title: "Sign-in did not finish", message: "The sign-in stopped before you were signed in, so nothing changed.", hint: "Sign in again whenever you are ready." };
  }
}

export function SignIn() {
  const hydrated = useHydrated();
  if (!hydrated) {
    return (
      // No "Powered by" until hydration: its palette follows the visitor's theme, known only in the browser.
      <HostedFrame app={SILICON_ACCOUNTS} site title="Sign in to Silicon Accounts" busy poweredBy={false}>
        <LoadingCard />
      </HostedFrame>
    );
  }
  return (
    <ArrivalScope>
      <SignInRoundTrip />
    </ArrivalScope>
  );
}

const PROMPTS: readonly FlowPrompt[] = ["login", "select_account", "consent"];
const METHODS: readonly SigninMethod[] = ["google", "apple", "email", "phone"];

function SignInRoundTrip() {
  const router = useRouter();
  const search = useSearchParams();
  const { status } = useSession();
  const refreshSession = useRefreshSession();
  // Read once: the saved entry is removed below, and a later render must not turn this return into a fresh visit.
  // A code or error whose state this browser never saved is not a return (see the top of this file): ignored.
  const [arrival] = useState(() => arrivalOf(search));
  const left = useRef(false);

  const startFlow = (returnTo: string | null, prompt?: FlowPrompt) => {
    const method = METHODS.find(value => value === search.get("method"));
    const intent = search.get("intent") === "signup" ? "signup" : undefined;
    router.replace(firstPartySignInUrl(returnTo, { prompt, method, intent }));
  };

  const onReady = useEffectEvent(() => {
    if (left.current) return;
    if (arrival) {
      forgetSignInReturn(arrival.state);
      // A sign-in that ended without signing in stays here to say so.
      if (arrival.error) return;
      left.current = true;
      // The flow set the session cookie: read the session again, then show the page the Carbon asked for.
      void refreshSession().finally(() => router.replace(arrival.path));
      return;
    }
    if (status === "loading") return;
    left.current = true;
    const returnTo = sameSitePath(search.get("return_to"));
    const prompt = PROMPTS.find(value => value === search.get("prompt"));
    if (status === "signed_in" && !prompt) {
      router.replace(returnTo ?? paths.home);
      return;
    }
    startFlow(returnTo, prompt);
  });
  useEffect(() => {
    document.title = "Sign in · Silicon Accounts";
    onReady();
  }, [status]);

  if (arrival?.error) {
    const copy = endedCopy(arrival.error);
    return (
      <Problem
        app={SILICON_ACCOUNTS}
        title={copy.title}
        message={copy.message}
        hint={copy.hint}
        actions={[
          { label: "Sign in again", onClick: () => startFlow(arrival.path) },
          { label: "Go to the home page", href: paths.home },
        ]}
      />
    );
  }
  return (
    <HostedFrame app={SILICON_ACCOUNTS} site title="Sign in to Silicon Accounts" busy>
      <LoadingCard label={arrival ? "Signing you in" : "Opening sign-in"} />
    </HostedFrame>
  );
}
