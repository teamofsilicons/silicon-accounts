/**
 * /sign-in: the account site's own sign-in. It starts the hosted flow for the first-party app `accounts` (redirect
 * `{origin}/`) and remembers `?return_to=` for after. `prompt`, `login_hint` and `method` pass through, so the account
 * site (and the CLI's device page) can ask for a fresh sign-in or a method. It moves on inside the page, without a
 * reload, so the hosted flow opens at once.
 */
import { useNavigate, useSearchParams } from "@solidjs/router";
import { onMount } from "solid-js";
import { firstPartySignInUrl } from "../../app/session";
import { HostedFrame } from "./flow/HostedFrame";
import { LoadingCard } from "./Problem";

type Method = "google" | "apple" | "email" | "phone";

/**
 * A `return_to` this site can go back to: a path on this origin, as the browser itself reads it. Text that only looks
 * like a path can be another origin once parsed ("/\t/evil.example/x" loses its tab and becomes "//evil.example/x"),
 * and the page that restores the path after sign-in would then fail to load, so anything else is dropped (the sign-in
 * returns to the account site's home instead).
 */
export function sameSitePath(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return undefined;
  }
  if (url.origin !== window.location.origin) return undefined;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // "//host" and "/\host" read as other origins wherever a path is resolved again.
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return undefined;
  return path;
}

export default function SignIn() {
  const [params] = useSearchParams<{ return_to?: string; prompt?: string; login_hint?: string; method?: string }>();
  const navigate = useNavigate();
  onMount(() => {
    const prompt = params.prompt === "login" || params.prompt === "select_account" ? params.prompt : undefined;
    const method = (["google", "apple", "email", "phone"] as const).find(value => value === params.method) as Method | undefined;
    const loginHint = params.login_hint?.trim() ? params.login_hint.trim().slice(0, 320) : undefined;
    const returnTo = typeof params.return_to === "string" ? sameSitePath(params.return_to) : undefined;
    navigate(firstPartySignInUrl(returnTo, { prompt, login_hint: loginHint, method }), { replace: true });
  });
  return (
    <HostedFrame app={{ app_id: "accounts", name: "Silicon Accounts" }} site title="Sign in to Silicon Accounts" busy>
      <LoadingCard />
    </HostedFrame>
  );
}
