"use client";

/**
 * signup, as the prototype draws it (Anil, 2026-11-12: "Name and CarbonID"): the photo in its ring, "Welcome to
 * {app}", "This is how people and Silicons will see you in every app.", then only Your name and Your CarbonID (checked
 * live, with free ids offered when it is taken) and Create Account. The timezone the browser reported, the default date
 * of birth (UNDERSTANDING.md: exactly 18 years ago) and the photo the sign-up was prefilled with go with it as they are;
 * all three change later in Personal info. "Not You?" stays above the form: the verified address is someone's, and the
 * next person must never finish a sign-up on it. Finishing an account an app imported keeps the app's data and its id
 * unless the Carbon picks another.
 */
import { useState, type FormEvent } from "react";
import { Mail, Smartphone } from "lucide-react";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Input } from "@teamofsilicons/silicon-ui/input";
import type { ApiError } from "@/lib/api/errors";
import type { FlowSignup, SignupSubmit } from "@/lib/api/types";
import { isValidTimezone, modernTimezone } from "@/lib/timezones";
import type { FlowController } from "../flow/controller";
import { cleanHandle, handleProblem, useIdCheck } from "../flow/id-check";
import { IdField } from "../flow/id-field";
import { destinationName, importerName, type HostedFlow } from "../flow/model";
import { AppleMark, DestinationRow, FlowAlert, GoogleMark, StepHeading, useStepErrors } from "../flow/parts";
import styles from "../flow/flow.module.css";

export interface SignupProps {
  flow: HostedFlow;
  ctl: FlowController;
  notice: ApiError | null;
}

export function Signup(props: SignupProps) {
  const signup = props.flow.signup;
  // A new sign-up (another address after "Not you?") starts the form afresh.
  return signup ? <SignupForm key={`${signup.email ?? ""}|${signup.phone ?? ""}|${signup.provider ?? ""}`} {...props} prefill={signup} /> : null;
}

function SignupForm({ flow, ctl, notice, prefill }: SignupProps & { prefill: FlowSignup }) {
  const app = flow.app;
  const destination = destinationName(app);
  /**
   * Who added the Carbon, when finishing an import: the app whose import created the account, which need not be the
   * app being signed into (legacy-crm imported them, they first sign into briefcase). Never the flow's app by default.
   */
  const importer = importerName(prefill.imported_by?.name);
  const importedHere = !!prefill.imported_by && prefill.imported_by.app_id === app.app_id;
  const [name, setName] = useState(prefill.display_name);
  const [handle, setHandle] = useState(cleanHandle(prefill.id));
  // Some browsers report legacy zone names (Asia/Calcutta): the account gets the name people know (Asia/Kolkata).
  const [timezone] = useState(() => (isValidTimezone(modernTimezone(prefill.timezone)) ? modernTimezone(prefill.timezone) : prefill.timezone));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** Why "Create Account" did not work (shown by the button); the flow's own error and "Not you?" show at the top. */
  const [problem, setProblem] = useState<ApiError | null>(null);
  const errors = useStepErrors(flow.error ?? notice);
  const [pending, setPending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const ownHandle = prefill.finishing_import ? cleanHandle(prefill.id) : null;
  const ids = useIdCheck({ handle, own: ownHandle, displayName: name, dob: prefill.dob });

  const fieldError = (key: string) => fieldErrors[key] ?? null;
  const clearField = (key: string) => {
    if (!(key in fieldErrors)) return;
    const next = { ...fieldErrors };
    delete next[key];
    setFieldErrors(next);
  };
  const nameProblem = (() => {
    const value = name.trim();
    if (!value) return "Enter the name people see, like Saket or Saket Dev.";
    if (value.length > 100) return `Use at most 100 characters (this is ${value.length}).`;
    return null;
  })();
  const idError = (() => {
    const server = fieldError("id");
    if (server) return server;
    if (ids.status === "unavailable") return ids.message;
    // Too short is normal while typing: say so only once it is long enough to judge, or on submit.
    if (ids.status === "invalid" && (attempted || handle.length >= 3 || /[^a-z0-9_-]/.test(handle))) return ids.message;
    return null;
  })();
  const idDescription = (() => {
    switch (ids.status) {
      case "own":
        return importer ? `This is the CarbonID ${importer} set up for you. Keep it, or pick another.` : "This is the CarbonID set up for you when you were added. Keep it, or pick another.";
      case "checking":
        return `Checking c:${handle}\u2026`;
      case "available":
        return `${ids.message ?? `c:${handle} is available.`} Others type it to find you; you can change it later in Personal info.`;
      default:
        return "Others type this to find you. Suggested from your name; you can change it later in Personal info.";
    }
  })();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || leaving) return;
    setAttempted(true);
    setProblem(null);
    errors.begin();
    const local: Record<string, string> = {};
    if (nameProblem) local.display_name = nameProblem;
    const handleIssue = handleProblem(handle);
    if (handleIssue) local.id = handleIssue;
    else if (ids.status === "unavailable" && ids.message) local.id = ids.message;
    setFieldErrors(local);
    if (Object.keys(local).length) return;

    // The date of birth and photo are left to the server: the default date and the prefilled photo (an imported
    // account keeps its own). The timezone is the browser's.
    const body: SignupSubmit = { display_name: name.trim(), id: `c:${handle}` };
    if (timezone && isValidTimezone(timezone)) body.timezone = timezone;

    setPending(true);
    const failure = await ctl.signup(body);
    setPending(false);
    if (!failure) return;
    if (failure.code === "id_taken" || failure.code === "id_reserved" || failure.code === "invalid_id") {
      setFieldErrors({ id: failure.message });
      if (failure.suggestions.length) ids.setSuggestions(failure.suggestions.map(cleanHandle).filter(value => !handleProblem(value)));
      return;
    }
    const fields = failure.fields;
    if (Object.keys(fields).length) {
      setFieldErrors(fields);
      return;
    }
    setProblem(failure);
  };

  /**
   * "Not you?": this verified email, phone or provider account is not the visitor's. The server ends the waiting
   * sign-up in this browser (its cookie too) and the flow goes back to the methods, so the next person never finds
   * someone else's verified address filled in.
   */
  const notYou = async () => {
    if (leaving || pending) return;
    setLeaving(true);
    errors.begin();
    const failure = await ctl.switchAccount();
    setLeaving(false);
    if (failure) errors.fail(failure);
  };

  const provenIcon = prefill.provider === "google" ? <GoogleMark /> : prefill.provider === "apple" ? <AppleMark /> : prefill.email ? <Mail size={16} strokeWidth={1.75} /> : <Smartphone size={16} strokeWidth={1.75} />;
  const proven = prefill.email ?? prefill.phone ?? (prefill.provider === "apple" ? "your Apple account" : "your Google account");
  const providerName = prefill.provider === "apple" ? "Apple" : "Google";

  return (
    <>
      <span className={styles.welcomeRing} aria-hidden="true">
        <Avatar name={name.trim() || "New Carbon"} src={prefill.pfp_url ?? undefined} size="xl" />
      </span>
      <StepHeading
        title={prefill.finishing_import ? "Finish setting up your account" : `Welcome to ${destination}`}
        description={prefill.finishing_import
          ? importedHere && importer
            ? `${importer} added you to Silicon Accounts. Check the details it gave us, then continue.`
            : `${importer ?? "An app you use"} added you to Silicon Accounts. Check the details it gave us, then continue to ${destination}.`
          : "This is how people and Silicons will see you in every app."}
      />
      <FlowAlert error={errors.current} app={app.name} onSwitch={() => ctl.switchAccount()} />
      <DestinationRow
        channel={prefill.email ? "email" : "phone"}
        icon={provenIcon}
        destination={proven}
        note={prefill.provider ? `Verified by ${providerName}` : "Verified with a code"}
        action={<Button variant="ghost" size="sm" loading={leaving} disabled={pending} onClick={() => void notYou()} aria-label="Not you? Use another account">Not You?</Button>}
      />
      <form className={styles.form} noValidate onSubmit={event => void submit(event)}>
        <Input
          label="Your name"
          autoComplete="name"
          maxLength={100}
          value={name}
          onChange={event => {
            setName(event.currentTarget.value);
            clearField("display_name");
          }}
          error={fieldError("display_name") ?? (attempted ? nameProblem ?? undefined : undefined)}
        />

        <IdField
          label="Your CarbonID"
          value={handle}
          onChange={value => {
            setHandle(cleanHandle(value));
            clearField("id");
          }}
          status={ids.status}
          error={idError}
          description={idError ? null : idDescription}
          suggestions={ids.suggestions.length && (ids.status === "unavailable" || fieldError("id")) ? ids.suggestions : []}
          onPick={value => {
            setHandle(value);
            clearField("id");
          }}
        />

        <FlowAlert error={problem} title="Your account was not created" app={app.name} onSwitch={() => ctl.switchAccount()} />

        <Button type="submit" className={styles.wide} loading={pending} disabled={leaving}>
          {prefill.finishing_import ? "Finish Setup" : "Create Account"}
        </Button>
      </form>
    </>
  );
}
