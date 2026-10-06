/**
 * Toasts for results of background work and API failures. A foreground action still confirms in place (Arc rule);
 * use these for what happens out of view, and for errors in addition to an inline message near the cause.
 *
 *   notifyError(error, "Could not remove access")      // title + the server's message and hint
 *   notify.success("Copied", "c:saket is on your clipboard")
 */
import { toast } from "../arc/toast-stack/toast-stack";
import { ApiError, setErrorReporter } from "../api";

/** Shows an API failure: the server's message says what and why, the hint says what to do next. */
export function notifyError(error: unknown, title?: string): string {
  const failure = ApiError.from(error);
  const retry = failure.retryAfter ? ` Try again in ${failure.retryAfter} s.` : "";
  const description = [failure.message, failure.hint].filter(Boolean).join(" ") + (failure.hint ? "" : retry);
  return toast.error(title ?? titleFor(failure), description, { id: failure.code === "network_error" ? "network_error" : undefined });
}

function titleFor(error: ApiError): string {
  if (error.isNetwork) return "Silicon Accounts is unreachable";
  if (error.status === 401) return "You are signed out";
  if (error.status === 403) return "Not allowed";
  if (error.status === 404) return "Not found";
  if (error.status === 409) return "That conflicts with what is there";
  if (error.status === 410) return "That has expired";
  if (error.status === 422) return "Check the details";
  if (error.status === 423 || error.status === 429) return "Slow down for a moment";
  if (error.status >= 500) return "Silicon Accounts had a problem";
  return "That did not work";
}

export const notify = {
  success: (title: string, description?: string) => toast.success(title, description),
  info: (title: string, description?: string) => toast.info(title, description),
  warning: (title: string, description?: string) => toast.warning(title, description),
  error: notifyError,
  loading: (title: string, description?: string) => toast.loading(title, description),
  update: toast.update,
  dismiss: toast.dismiss,
};

/** Routes createAction failures to toasts. Called once by the app root. */
export function installErrorReporter(): void {
  setErrorReporter((error, title) => {
    notifyError(error, title);
  });
}
