"use client";

/**
 * signup: "Set up your account", with everything already filled in (UNDERSTANDING.md): display name, c:id (checked
 * live as it changes, with free ids offered when it is taken), timezone, date of birth and photo. A picked photo is
 * uploaded at once to the sign-up itself (POST /v1/flows/{id}/signup/photo) and becomes the account's own photo
 * when the account is created. Finishing an account an app imported shows the app's data and keeps its id unless
 * the Carbon picks another.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ImageUp, LoaderCircle, Mail, Smartphone } from "lucide-react";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import type { ApiError } from "@/lib/api/errors";
import type { FlowSignup, SignupSubmit } from "@/lib/api/types";
import { formatTime } from "@/lib/format";
import { isValidTimezone, modernTimezone, timezoneOptions } from "@/lib/timezones";
import { ComboboxField } from "../flow/combobox-field";
import type { FlowController } from "../flow/controller";
import { DobField } from "../flow/dob-field";
import { describe } from "../flow/errors";
import { useNow } from "../flow/hooks";
import { cleanHandle, handleProblem, useIdCheck } from "../flow/id-check";
import { IdField } from "../flow/id-field";
import type { HostedFlow } from "../flow/model";
import { AppleMark, DestinationRow, FieldNote, FlowAlert, GoogleMark, StepHeading, useStepErrors } from "../flow/parts";
import styles from "../flow/flow.module.css";

export interface SignupProps {
  flow: HostedFlow;
  ctl: FlowController;
  notice: ApiError | null;
}

type PhotoChoice = "prefill" | "default" | "provider" | "upload";

interface Upload {
  /** What the Carbon picked, shown at once while it uploads. */
  preview: string;
  name: string;
  state: "uploading" | "done";
  /** The sign-up's photo, exactly as the server returned it. */
  pfpUrl: string | null;
}

const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_PHOTO = 2 * 1024 * 1024;
const MIN_DOB = new Date(1900, 0, 2);
/** Only until the page's clock is known (never shown: the hosted steps render after hydration). */
const LATEST_DOB = new Date(2100, 0, 1);

/** "1.4 MB". */
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;

/** A photo Silicon Accounts stores (`{origin}/v1/photos/{id}`): what the server returns for an upload. */
function isUploadedPhoto(url: string | null | undefined): boolean {
  if (!url || typeof window === "undefined") return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === window.location.origin && parsed.pathname.startsWith("/v1/photos/");
  } catch {
    return false;
  }
}

export function Signup(props: SignupProps) {
  const signup = props.flow.signup;
  // A new sign-up (another address after "Not you?") starts the form afresh.
  return signup ? <SignupForm key={`${signup.email ?? ""}|${signup.phone ?? ""}|${signup.provider ?? ""}`} {...props} prefill={signup} /> : null;
}

function SignupForm({ flow, ctl, notice, prefill }: SignupProps & { prefill: FlowSignup }) {
  const app = flow.app;
  const destinationName = app.first_party ? "your account" : app.name;
  const [name, setName] = useState(prefill.display_name);
  const [handle, setHandle] = useState(cleanHandle(prefill.id));
  // Some browsers report legacy zone names (Asia/Calcutta): the page offers the name people know (Asia/Kolkata).
  const [initialZone] = useState(() => (isValidTimezone(modernTimezone(prefill.timezone)) ? modernTimezone(prefill.timezone) : prefill.timezone));
  const [timezone, setTimezone] = useState(initialZone);
  const [dob, setDob] = useState<string | null>(prefill.dob);
  const [photo, setPhoto] = useState<PhotoChoice>("prefill");
  const [upload, setUpload] = useState<Upload | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** Why "Create account" did not work (shown by the button); the flow's own error and "Not you?" show at the top. */
  const [problem, setProblem] = useState<ApiError | null>(null);
  const errors = useStepErrors(flow.error ?? notice);
  const [pending, setPending] = useState<"creating" | "uploading" | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = useRef<Promise<unknown> | null>(null);
  const previews = useRef<string[]>([]);
  // Picked photos are object URLs: free them when the form goes away.
  useEffect(() => () => previews.current.forEach(url => URL.revokeObjectURL(url)), []);

  const ownHandle = prefill.finishing_import ? cleanHandle(prefill.id) : null;
  const ids = useIdCheck({ handle, own: ownHandle, displayName: name, dob });
  const now = useNow(30_000);
  const zones = useMemo(() => timezoneOptions(undefined, [initialZone]), [initialZone]);
  /**
   * The prefill is a photo uploaded on this sign-up: the server prefills the upload once there is one (after a reload,
   * a re-read of the flow, or when the 48 hour sign-up resumes in another flow). The Carbon can still take it away.
   */
  const prefillUploaded = isUploadedPhoto(prefill.pfp_url);
  /** A prefilled photo the Carbon may remove: an imported account's photo, or an upload of this sign-up. */
  const removablePrefill = prefill.finishing_import || prefillUploaded;

  const photoSrc = (() => {
    switch (photo) {
      case "upload":
        return upload?.preview ?? null;
      case "provider":
        return prefill.provider_pfp_url ?? null;
      case "default":
        // The default photo is made when the account is: until then the initials stand in for it, unless the prefill
        // still is the default's preview.
        return removablePrefill ? null : prefill.pfp_url;
      default:
        return prefill.pfp_url;
    }
  })();

  const pickFile = (picked: File | undefined) => {
    if (!picked) return;
    if (!PHOTO_TYPES.includes(picked.type)) {
      setPhotoError(`${picked.name} is not a PNG, JPEG, WebP or GIF image. Pick one of those.`);
      return;
    }
    if (picked.size > MAX_PHOTO) {
      setPhotoError(`${picked.name} is ${megabytes(picked.size)}; photos can be at most 2 MB. Pick a smaller one (512 by 512 pixels is plenty).`);
      return;
    }
    const preview = URL.createObjectURL(picked);
    previews.current.push(preview);
    const previous = { photo, upload };
    setUpload({ preview, name: picked.name, state: "uploading", pfpUrl: null });
    setPhoto("upload");
    setPhotoError(null);
    const job = ctl.uploadSignupPhoto(picked).then(result => {
      if ("pfp_url" in result) {
        setUpload(current => (current?.preview === preview ? { ...current, state: "done", pfpUrl: result.pfp_url } : current));
        return;
      }
      // The photo did not make it: back to what was there, with the reason.
      setUpload(current => (current?.preview === preview ? previous.upload : current));
      setPhoto(current => (current === "upload" ? previous.photo : current));
      setPhotoError(describe(result, { app: app.name }));
    });
    uploading.current = job;
    void job.finally(() => {
      if (uploading.current === job) uploading.current = null;
    });
  };

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
      case "available":
        return ids.message;
      case "checking":
        return `Checking c:${handle}…`;
      case "own":
        return `This is the id ${app.name} set up for you. Keep it, or pick another.`;
      case "unknown":
        return ids.message ?? "Your id is how people find you. You can change it later.";
      default:
        return null;
    }
  })();
  const isDefaultDob = !prefill.finishing_import && dob === prefill.dob;
  const localTime = isValidTimezone(timezone) && now ? formatTime(now, timezone) : null;
  /** Yesterday (the server refuses a date of birth in the future); known once the page has a clock. */
  const maxDob = useMemo(() => {
    if (!now) return LATEST_DOB;
    const today = new Date(now);
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  }, [now]);

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
    if (!timezone || !isValidTimezone(timezone)) local.timezone = "Pick your timezone from the list.";
    if (!dob) local.dob = "Pick your date of birth.";
    setFieldErrors(local);
    if (Object.keys(local).length) return;

    // A photo still on its way finishes first: it belongs to the sign-up, and the account takes it from there.
    if (uploading.current) {
      setPending("uploading");
      await uploading.current;
    }
    const body: SignupSubmit = { display_name: name.trim(), id: `c:${handle}`, timezone, dob: dob ?? undefined };
    if (photo === "default") body.pfp_url = null;
    if (photo === "provider") body.pfp_url = prefill.provider_pfp_url ?? null;
    if (photo === "upload" && upload?.pfpUrl) body.pfp_url = upload.pfpUrl;

    setPending("creating");
    const failure = await ctl.signup(body);
    setPending(null);
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
  const photoNote = photoError ?? fieldError("pfp_url") ?? (photo === "upload" && upload
    ? (upload.state === "uploading" ? `Uploading ${upload.name}…` : `${upload.name} is ready. It becomes your photo when you continue.`)
    : photo === "prefill" && prefillUploaded ? "The photo you uploaded becomes your photo when you continue." : null);
  const showsUpload = photo === "upload" || (photo === "prefill" && prefillUploaded);

  return (
    <>
      <StepHeading
        title={prefill.finishing_import ? "Finish setting up your account" : "Set up your account"}
        description={prefill.finishing_import
          ? `${app.name} added you to Silicon Accounts. Check the details it gave us, then continue.`
          : `This is your first time here, so we filled it all in. Check it, then continue to ${destinationName}. You can change any of it later.`}
      />
      <FlowAlert error={errors.current} app={app.name} onSwitch={() => ctl.switchAccount()} />
      <DestinationRow
        channel={prefill.email ? "email" : "phone"}
        icon={provenIcon}
        destination={proven}
        note={prefill.provider ? `Verified by ${providerName}` : "Verified with a code"}
        action={<Button variant="ghost" size="sm" loading={leaving} disabled={!!pending} onClick={() => void notYou()} aria-label="Not you? Use another account">Not you?</Button>}
      />
      <form className={styles.form} noValidate onSubmit={event => void submit(event)}>
        <div className={styles.photoField}>
          <span className={styles.photoFrame}>
            <Avatar name={name.trim() || "New Carbon"} src={photoSrc ?? undefined} size="xl" />
            {upload?.state === "uploading" && photo === "upload" ? (
              <span className={styles.photoBusy} aria-hidden="true"><LoaderCircle className={styles.spin} size={22} strokeWidth={2} /></span>
            ) : null}
          </span>
          <div className={styles.photoText}>
            <span className={styles.fieldLabel}>Profile photo</span>
            <div className={styles.photoActions}>
              <Button type="button" variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
                <span className={styles.buttonIcon}><ImageUp size={16} strokeWidth={1.75} aria-hidden="true" />{showsUpload ? "Choose another" : "Upload photo"}</span>
              </Button>
              {prefill.provider_pfp_url && photo !== "provider" ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => { setPhoto("provider"); setPhotoError(null); }}>Use {providerName} photo</Button>
              ) : null}
              {photo === "upload" || photo === "provider" || (photo === "prefill" && removablePrefill) ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => { setPhoto("default"); setPhotoError(null); }}>Remove</Button>
              ) : null}
            </div>
            <FieldNote text={photoNote} tone={photoError || fieldError("pfp_url") ? "error" : "hint"} alert={!!photoError} />
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={PHOTO_TYPES.join(",")}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={event => {
              pickFile(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
        </div>

        <Input
          label="Display name"
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
          label="Your id"
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

        <div className={styles.stack}>
          <ComboboxField
            label="Timezone"
            options={zones}
            value={timezone}
            onValueChange={value => {
              setTimezone(value);
              clearField("timezone");
            }}
            placeholder="Search cities or offsets"
            emptyMessage="No timezone matches. Try a city, like Kolkata, or an offset, like +05:30."
            description={localTime ? `It is ${localTime} there now.` : undefined}
          />
          {fieldError("timezone") ? <span className={styles.fieldError} role="alert">{fieldError("timezone")}</span> : null}
        </div>

        <DobField
          label="Date of birth"
          value={dob}
          onChange={value => {
            setDob(value);
            clearField("dob");
          }}
          minDate={MIN_DOB}
          maxDate={maxDob}
          description={isDefaultDob ? "We started from 18 years ago. Set your real date of birth." : undefined}
          error={fieldError("dob")}
        />

        <FlowAlert error={problem} title="Your account was not created" app={app.name} onSwitch={() => ctl.switchAccount()} />

        <Button type="submit" className={styles.wide} loading={!!pending} disabled={leaving}>
          {pending === "uploading" ? "Uploading your photo" : prefill.finishing_import ? "Finish setup" : "Create account"}
        </Button>
      </form>
    </>
  );
}
