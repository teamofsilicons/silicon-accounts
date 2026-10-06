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
 *     detail that went missing): the flow is read again, and the error stays visible on the step it moved to.
 *
 * Flow failures are never toasts: the Carbon reads them on the card.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";
import { ApiError } from "@/lib/api/errors";
import { request, seg } from "@/lib/api/http";
import type { ConsentSubmit, FlowView, PhotoInfo, SignupSubmit } from "@/lib/api/types";
import { queryKeys } from "@/lib/query/keys";
import { rememberLook, type HostedFlow } from "./model";

/** The flow itself is gone or not ours: nothing on the page can continue it. */
const FATAL = new Set(["flow_expired", "flow_not_found", "flow_not_bound"]);

/**
 * The server changed the flow while answering with an error (it saved the reason on the flow, or the step moved):
 * read it again so the page shows where it is now.
 */
const RESYNC = new Set([
  "email_domain_not_allowed", "signup_not_allowed", "account_unavailable", "account_not_active", "app_disabled", "signup_expired",
  "signup_already_completed", "requirements_missing", "requirement_not_needed", "flow_changed", "flow_completed", "flow_failed",
  "invalid_step", "code_already_used", "challenge_not_found", "no_code_sent", "session_required", "method_not_enabled",
  "continue_not_allowed", "reauthentication_required",
]);

/**
 * Refusals of a send (POST …/email, …/phone, …/requirements/{kind}) that the server answers before it touches the flow:
 * re-reading would change nothing, and the error belongs under the field that sent it. (A refused domain at verify
 * time is different: the server then saves it on the flow and moves it back to the methods.)
 */
const SEND_REFUSALS = new Set(["email_domain_not_allowed"]);

export type ActionResult = ApiError | null;

/** `POST /v1/flows/{id}/signup/photo` (201): the photo picked at sign-up, stored with the sign-up until it finishes. */
export interface SignupPhoto {
  pfp_url: string;
  photo: PhotoInfo;
}

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
  requirementEmail: (email: string) => Promise<ActionResult>;
  requirementPhone: (phone: string, country?: string) => Promise<ActionResult>;
  requirementVerify: (code: string) => Promise<ActionResult>;
  consent: (body: ConsentSubmit) => Promise<ActionResult>;
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
        const before = current()?.step;
        await reload();
        // The step moved: keep the reason visible there, unless the flow carries its own. (When the step stayed, the
        // step that asked shows the error itself.)
        const after = current();
        if (after && after.step !== before && !after.error) setNotice(error);
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
          // Not in lib/api yet (a request to the foundation): the flow-scoped upload of the sign-up step.
          return await request<SignupPhoto>(`/v1/flows/${seg(id)}/signup/photo`, { method: "POST", raw: file, contentType: file.type || "application/octet-stream" });
        } catch (raw) {
          const error = ApiError.from(raw);
          await handle(error);
          return error;
        }
      },
      signup: body => run(() => api.flows.signup(id, body)),
      requirementEmail: email => run(() => api.flows.requirementEmail(id, email), SEND_REFUSALS),
      requirementPhone: (phone, country) => run(() => api.flows.requirementPhone(id, phone, country), SEND_REFUSALS),
      requirementVerify: code => run(() => api.flows.requirementVerify(id, code)),
      consent: body => run(() => api.flows.consent(id, body)),
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
