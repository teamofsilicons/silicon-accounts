/**
 * The hosted flow's state on the page: the FlowView, what failed, and every action of the flow API.
 *
 * Every action answers with the new FlowView, which replaces the old one (the card morphs to the new step). Failures
 * come back to the step that asked, so it can show them next to their cause. Two kinds are handled here instead:
 *   - fatal ones (the flow expired, ended, or belongs to another browser): the page shows a full error;
 *   - ones after which the server moved the flow on its own (a sign-up that ran out, a domain the app refuses, a
 *     detail that went missing): the flow is read again, and the error stays visible on the step it moved to.
 */
import { batch, createSignal, type Accessor } from "solid-js";
import { ApiError, api, type ConsentSubmit, type FlowView, type SignupSubmit } from "../../../api";
import { asHosted, rememberLook, type HostedFlow } from "./model";

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

export interface FlowController {
  flow: Accessor<HostedFlow | null>;
  /** A failure that ends the page (expired, gone, another browser) or the first load failing. */
  failure: Accessor<ApiError | null>;
  /** An error to show on the step the server moved to (when the flow carries none of its own). */
  notice: Accessor<ApiError | null>;
  clearNotice: () => void;
  /** True while the flow is being read for the first time. */
  loading: Accessor<boolean>;
  /** Reads the flow again (Retry, a resync). */
  reload: () => Promise<void>;
  /** Shows a flow the page got another way (after a photo upload, for instance). */
  adopt: (next: HostedFlow) => void;
  continueAs: () => Promise<ActionResult>;
  switchAccount: () => Promise<ActionResult>;
  sendEmail: (email: string) => Promise<ActionResult>;
  sendPhone: (phone: string, country?: string) => Promise<ActionResult>;
  resend: () => Promise<ActionResult>;
  verify: (code: string) => Promise<ActionResult>;
  /** Starts Google or Apple and sends the browser there. Resolves with an error only when it could not. */
  startProvider: (provider: "google" | "apple") => Promise<ActionResult>;
  /** Creates the account; `before` runs with the next flow before it is shown (the photo upload). */
  signup: (body: SignupSubmit | Record<string, unknown>, before?: (next: HostedFlow) => Promise<void>) => Promise<ActionResult>;
  requirementEmail: (email: string) => Promise<ActionResult>;
  requirementPhone: (phone: string, country?: string) => Promise<ActionResult>;
  requirementVerify: (code: string) => Promise<ActionResult>;
  consent: (body: ConsentSubmit) => Promise<ActionResult>;
}

export function createFlowController(id: string, initial?: HostedFlow): FlowController {
  const [flow, setFlow] = createSignal<HostedFlow | null>(initial ?? null);
  const [failure, setFailure] = createSignal<ApiError | null>(null);
  const [notice, setNotice] = createSignal<ApiError | null>(null);
  const [loading, setLoading] = createSignal(!initial);

  const show = (next: HostedFlow) => {
    batch(() => {
      setFlow(next);
      setFailure(null);
    });
    rememberLook(next);
  };
  if (initial) rememberLook(initial);

  const reload = async () => {
    try {
      show(asHosted(await api.flows.get(id)));
    } catch (raw) {
      const error = ApiError.from(raw);
      // A failed re-read keeps the page as it was unless the flow itself is gone.
      if (FATAL.has(error.code) || !flow()) setFailure(error);
      else setNotice(error);
    } finally {
      setLoading(false);
    }
  };

  const handle = async (error: ApiError, keep?: ReadonlySet<string>): Promise<ActionResult> => {
    if (FATAL.has(error.code)) {
      setFailure(error);
      return error;
    }
    if (RESYNC.has(error.code) && !keep?.has(error.code)) {
      const before = flow()?.step;
      await reload();
      // The step moved: keep the reason visible there, unless the flow carries its own. (When the step stayed, the
      // step that asked shows the error itself.)
      const after = flow();
      if (after && after.step !== before && !after.error) setNotice(error);
    }
    return error;
  };

  const run = async (call: () => Promise<HostedFlow>, keep?: ReadonlySet<string>): Promise<ActionResult> => {
    try {
      const next = await call();
      batch(() => {
        setNotice(null);
        show(next);
      });
      return null;
    } catch (raw) {
      return handle(ApiError.from(raw), keep);
    }
  };

  const hosted = (call: () => Promise<FlowView>) => async () => asHosted(await call());

  return {
    flow,
    failure,
    notice,
    clearNotice: () => setNotice(null),
    loading,
    reload,
    adopt: show,
    continueAs: () => run(hosted(() => api.flows.continueAs(id))),
    switchAccount: () => run(hosted(() => api.flows.switchAccount(id))),
    sendEmail: email => run(hosted(() => api.flows.email(id, email)), SEND_REFUSALS),
    sendPhone: (phone, country) => run(hosted(() => api.flows.phone(id, phone, country)), SEND_REFUSALS),
    resend: () => run(hosted(() => api.flows.resend(id))),
    verify: code => run(hosted(() => api.flows.verify(id, code))),
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
    signup: async (body, before) => {
      try {
        const next = asHosted(await api.flows.signup(id, body as SignupSubmit));
        if (before) await before(next);
        batch(() => {
          setNotice(null);
          show(next);
        });
        return null;
      } catch (raw) {
        return handle(ApiError.from(raw));
      }
    },
    requirementEmail: email => run(hosted(() => api.flows.requirementEmail(id, email)), SEND_REFUSALS),
    requirementPhone: (phone, country) => run(hosted(() => api.flows.requirementPhone(id, phone, country)), SEND_REFUSALS),
    requirementVerify: code => run(hosted(() => api.flows.requirementVerify(id, code))),
    consent: body => run(hosted(() => api.flows.consent(id, body))),
  };
}

