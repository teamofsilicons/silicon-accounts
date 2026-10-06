/**
 * /sign-in — starts the hosted flow for the account site itself (app `accounts`, redirect `{origin}/`), remembering
 * `?return_to=` for after. Foundation version; the web-auth builder owns this file.
 */
import { useSearchParams } from "@solidjs/router";
import { onMount } from "solid-js";
import { firstPartySignInUrl } from "../../app/session";
import styles from "./auth.module.css";

export default function SignIn() {
  const [params] = useSearchParams<{ return_to?: string; prompt?: string; login_hint?: string }>();
  onMount(() => {
    const prompt = params.prompt === "login" || params.prompt === "select_account" ? params.prompt : undefined;
    location.replace(firstPartySignInUrl(params.return_to, { prompt, login_hint: params.login_hint }));
  });
  return <p class={styles.note} role="status">Opening sign-in…</p>;
}
