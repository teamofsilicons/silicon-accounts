"use client";

/**
 * The hosted flow's state on the page: the FlowView, what failed, and every action of the flow API.
 *
 * The FlowView lives in the query cache (`queryKeys.flow(id)`), so the flow /authorize just created is handed over
 * without asking again. Every action answers with the new FlowView, which replaces it (the card morphs to the new
 * step). Failures come back to the step that asked, so it can show them next to their cause. Two kinds are handled
 * here instead:
 *   - fatal ones (the flow expired, ended, or belongs to another browser): the page shows a full problem page;
 *   - ones after which the server moved the flow on its own (a sign-up that ran out, a domain the app refuses, a
 *     detail that went missing or was added elsewhere, a page the app renamed): the flow is read again, and the error
 *     stays visible on the page it moved to (`placeOf`: a step, or one page of the app's flow).
 *
 * Flow failures are never toasts: the Carbon reads them on the card.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/errors";
import type { ContactField, FlowView, SignupPhoto, SignupSubmit } from "@/lib/api/types";
import { queryKeys } from "@/lib/query/keys";
import { placeOf, rememberLook, type HostedFlow } from "./model";

/** The flow itself is gone or not ours: nothing on the page can continue it. */
const FATAL = new Set(["flow_expired", "flow_not_found", "flow_not_bound"]);

/**
 * The server changed the flow while answering with an error (it saved the reason on the flow, or the step moved):
 * read it again so the page shows where it is now.
 */
const RESYNC = new Set([
  "email_domain_not_allowed", "signup_not_allowed", "account_unavailable", "account_not_active", "app_disabled", "signup_expired",
  "signup_already_completed", "requirements_missing", "detail_not_on_page", "no_previous_page",
  "flow_changed", "flow_completed", "flow_failed", "invalid_step", "code_already_used", "challenge_not_found", "no_code_sent",
  "session_required", "method_not_enabled", "continue_not_allowed", "reauthentication_required",
]);

/**
 * Refusals of a send (POST …/email, …/phone, …/details/add) that the server answers before it touches the flow:
 * re-reading would change nothing, and the error belongs under the field that sent it. (A refused domain at verify
 * time is different: the server then saves it on the flow and moves it back to the methods.)
 */
const SEND_REFUSALS = new Set(["email_domain_not_allowed"]);

export type ActionResult = ApiError | null;

export type { SignupPhoto };

export interface FlowActions {
  /** Reads the flow again (Retry, a resync). */
  reload: () => Promise<void>;
  clearNotice: () => void;
  continueAs: () => Promise<ActionResult>;
  switchAccount: () => Promise<ActionResult>;
  sendEmail: (email: string) => Promise<ActionResult>;
  sendPhone: (phone: string, country?: string) => Promise<ActionResult>;
  resend: () => Promise<ActionResult>;
  verify: (code: string) => Promise<ActionResult>;
  /** Starts Google or Apple and sends the browser there. Resolves with an error only when it could not. */
  startProvider: (provider: "google" | "apple") => Promise<ActionResult>;
  /** Uploads the sign-up photo (the flow and sign-up cookies prove it is this sign-up's). */
  uploadSignupPhoto: (file: Blob) => Promise<SignupPhoto | ApiError>;
  /** Creates the account (or finishes an imported one). */
  signup: (body: SignupSubmit) => Promise<ActionResult>;
  /** Sends a code to add a missing email of the current details page. */
  detailsAddEmail: (email: string) => Promise<ActionResult>;
  /** Sends a code to add a missing phone number of the current details page. */
  detailsAddPhone: (phone: string, country?: string) => Promise<ActionResult>;
  /** The code: the email or phone joins the account. */
  detailsVerify: (code: string) => Promise<ActionResult>;
  /** Shares the required details of this page and the ticked optional ones (`share`), then moves on. */
  detailsContinue: (share: ContactField[]) => Promise<ActionResult>;
  /** The previous details page (from the review: the last one). */
  detailsBack: () => Promise<ActionResult>;
  /** Approves what is shared (completes), or cancels the sign-in (`false`, from any details page or the review). */
  review: (approve: boolean) => Promise<ActionResult>;
}

export interface FlowController extends FlowActions {
  flow: HostedFlow | null;
  /** A failure that ends the page (expired, gone, another browser), or the first read failing. */
  failure: ApiError | null;
  /** An error to show on the step the server moved to (when the flow carries none of its own). */
  notice: ApiError | null;
  /** True while the flow is being read for the first time. */
  loading: boolean;
}

export function useFlowController(id: string): FlowController {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.flow(id),
    // No abort signal on purpose: the read that finishes a Google or Apple sign-in sets the session cookie, so it is
    // never cancelled halfway (a remount reuses the request in flight instead of aborting it and asking again).
    queryFn: () => api.flows.get(id),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    meta: { toast: false },
  });
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<ApiError | null>(null);

  const actions = useMemo<FlowActions>(() => {
    const key = queryKeys.flow(id);
    const current = () => client.getQueryData<HostedFlow>(key) ?? null;
    const show = (next: HostedFlow) => {
      client.setQueryData(key, next);
      setFailure(null);
      rememberLook(next);
    };

    const reload = async () => {
      try {
        const next = await client.fetchQuery({ queryKey: key, queryFn: () => api.flows.get(id), staleTime: 0, retry: false });
        setFailure(null);
        rememberLook(next);
      } catch (raw) {
        const error = ApiError.from(raw);
        // A failed re-read keeps the page as it was unless the flow itself is gone.
        if (FATAL.has(error.code) || !current()) setFailure(error);
        else setNotice(error);
      }
    };

    const handle = async (error: ApiError, keep?: ReadonlySet<string>): Promise<ActionResult> => {
      if (FATAL.has(error.code)) {
        setFailure(error);
        return error;
      }
      if (RESYNC.has(error.code) && !keep?.has(error.code)) {
        const before = placeOf(current());
        await reload();
        // The flow moved to another page (another step, or another page of the app's flow on the same step): the page
        // that asked is gone, so the reason shows on the new one, unless the flow carries its own. (When the page
        // stayed, the page that asked shows the error itself.)
        const after = current();
        if (after && placeOf(after) !== before && !after.error) setNotice(error);
      }
      return error;
    };

    const run = async (call: () => Promise<FlowView>, keep?: ReadonlySet<string>): Promise<ActionResult> => {
      try {
        const next = await call();
        setNotice(null);
        show(next);
        return null;
      } catch (raw) {
        return handle(ApiError.from(raw), keep);
      }
    };

    return {
      reload,
      clearNotice: () => setNotice(null),
      continueAs: () => run(() => api.flows.continueAs(id)),
      switchAccount: () => run(() => api.flows.switchAccount(id)),
      sendEmail: email => run(() => api.flows.email(id, email), SEND_REFUSALS),
      sendPhone: (phone, country) => run(() => api.flows.phone(id, phone, country), SEND_REFUSALS),
      resend: () => run(() => api.flows.resend(id)),
      verify: code => run(() => api.flows.verify(id, code)),
      startProvider: async provider => {
        try {
          const { authorize_url: url } = await api.flows.oauthStart(id, provider);
          if (!/^https?:\/\//i.test(url)) {
            return new ApiError({ status: 0, code: "invalid_provider_url", message: `Silicon Accounts answered with an address for ${provider === "google" ? "Google" : "Apple"} that is not a web address.`, hint: "Try again. If it keeps happening, report it with `accounts report`." });
          }
          window.location.assign(url);
          return null;
        } catch (raw) {
          return handle(ApiError.from(raw));
        }
      },
      uploadSignupPhoto: async file => {
        try {
          return await api.flows.uploadSignupPhoto(id, file);
        } catch (raw) {
          const error = ApiError.from(raw);
          await handle(error);
          return error;
        }
      },
      signup: body => run(() => api.flows.signup(id, body)),
      detailsAddEmail: email => run(() => api.flows.detailsAdd(id, { email }), SEND_REFUSALS),
      detailsAddPhone: (phone, country) => run(() => api.flows.detailsAdd(id, country ? { phone, country } : { phone }), SEND_REFUSALS),
      detailsVerify: code => run(() => api.flows.detailsVerify(id, code)),
      detailsContinue: share => run(() => api.flows.detailsContinue(id, share)),
      detailsBack: () => run(() => api.flows.detailsBack(id)),
      review: approve => run(() => api.flows.review(id, approve)),
    };
  }, [client, id]);

  const flow = query.data ?? null;
  // Remember the app's look (the next sign-in to it paints in its colours at once) and which app this flow is for.
  useEffect(() => {
    if (flow) rememberLook(flow);
  }, [flow]);
  return {
    ...actions,
    flow,
    failure: failure ?? (flow ? null : query.error ?? null),
    notice,
    loading: !flow && query.isFetching,
  };
}
