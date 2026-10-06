/**
 * signup: "Set up your account", with everything already filled in (UNDERSTANDING.md): display name, c:id (checked
 * live as it changes, with free ids offered when it is taken), timezone, date of birth and photo. A new photo is
 * previewed here and uploaded right after the account exists (uploads need the account's session). Finishing an
 * account an app imported shows the app's data and keeps its id unless the Carbon picks another.
 */
import { For, Show, createMemo, createSignal, onCleanup, untrack, type Accessor } from "solid-js";
import { Check, CircleAlert, ImageUp, LoaderCircle, Mail, Smartphone } from "lucide-solid";
import { ApiError, api } from "../../../api";
import { Avatar } from "../../../arc/avatar/avatar";
import { Button } from "../../../arc/button/button";
import { Combobox } from "../../../arc/combobox/combobox";
import { DatePicker } from "../../../arc/date-picker/date-picker";
import { Input } from "../../../arc/input/input";
import { AppleMark, GoogleMark } from "../../../arc/blocks/sign-in/sign-in";
import { FieldMessage } from "../../../arc/lib/FieldMessage";
import { useSquircle } from "../../../arc/lib/squircle";
import { dateKey, fromDateKey } from "../../../arc/calendar/calendar";
import { formatTime } from "../../../lib/format";
import { isValidTimezone, timezoneOptions } from "../../../lib/timezones";
import type { FlowController } from "../flow/controller";
import { cleanHandle, createIdCheck, handleProblem } from "../flow/id-check";
import type { HostedFlow, HostedSignup } from "../flow/model";
import { FlowAlert, StepHeading, createNow, createStepErrors, latest } from "../flow/parts";
import styles from "../flow/flow.module.css";

export interface SignupProps {
  flow: Accessor<HostedFlow>;
  ctl: FlowController;
  notice: Accessor<ApiError | null>;
  /** The photo did not upload after the account was created (the account itself is fine). */
  onPhotoFailed: (error: ApiError) => void;
}

type PhotoChoice = "prefill" | "default" | "provider" | "upload";

const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_PHOTO = 2 * 1024 * 1024;
const MIN_DOB = new Date(1900, 0, 2);

function yesterday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
}

/** "1.4 MB". */
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;

export function Signup(props: SignupProps) {
  const signup = latest(() => props.flow().signup);
  return (
    <Show when={signup()}>
      {current => <SignupForm {...props} signup={current()} />}
    </Show>
  );
}

function SignupForm(props: SignupProps & { signup: HostedSignup }) {
  const prefill = untrack(() => props.signup);
  const app = () => props.flow().app;
  const destinationName = () => (app().first_party ? "your account" : app().name);
  const [name, setName] = createSignal(prefill.display_name);
  const [handle, setHandle] = createSignal(cleanHandle(prefill.id));
  const [timezone, setTimezone] = createSignal(prefill.timezone);
  const [dob, setDob] = createSignal<string | null>(prefill.dob);
  const [photo, setPhoto] = createSignal<PhotoChoice>("prefill");
  const [file, setFile] = createSignal<File | null>(null);
  const [preview, setPreview] = createSignal<string | null>(null);
  const [photoError, setPhotoError] = createSignal<string | null>(null);
  const [fieldErrors, setFieldErrors] = createSignal<Record<string, string>>({});
  /** Why "Create account" did not work (shown by the button); the flow's own error and "Not you?" show at the top. */
  const [problem, setProblem] = createSignal<ApiError | null>(null);
  const errors = createStepErrors(() => props.flow().error ?? props.notice());
  const [pending, setPending] = createSignal<"creating" | "uploading" | null>(null);
  const [leaving, setLeaving] = createSignal(false);
  const [attempted, setAttempted] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;
  onCleanup(() => {
    const url = preview();
    if (url) URL.revokeObjectURL(url);
  });

  const ownHandle = () => (prefill.finishing_import ? cleanHandle(prefill.id) : null);
  const ids = createIdCheck({ handle, own: ownHandle, displayName: name, dob });
  const now = createNow(30_000);
  const zones = createMemo(() => timezoneOptions(new Date(), [prefill.timezone]));

  const photoSrc = () => {
    switch (photo()) {
      case "upload":
        return preview();
      case "provider":
        return prefill.provider_pfp_url ?? null;
      case "default":
        return prefill.finishing_import ? null : prefill.pfp_url;
      default:
        return prefill.pfp_url;
    }
  };

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
    const old = preview();
    if (old) URL.revokeObjectURL(old);
    setPreview(URL.createObjectURL(picked));
    setFile(picked);
    setPhoto("upload");
    setPhotoError(null);
  };

  const fieldError = (key: string) => fieldErrors()[key] ?? null;
  const clearField = (key: string) => {
    if (!(key in fieldErrors())) return;
    const next = { ...fieldErrors() };
    delete next[key];
    setFieldErrors(next);
  };
  const nameProblem = () => {
    const value = name().trim();
    if (!value) return "Enter the name people see, like Saket or Saket Dev.";
    if (value.length > 100) return `Use at most 100 characters (this is ${value.length}).`;
    return null;
  };
  const idError = () => {
    const server = fieldError("id");
    if (server) return server;
    const status = ids.status();
    if (status === "unavailable") return ids.message();
    // Too short is normal while typing: say so only once it is long enough to judge, or on submit.
    if (status === "invalid" && (attempted() || handle().length >= 3 || /[^a-z0-9_-]/.test(handle()))) return ids.message();
    return null;
  };
  const idDescription = () => {
    switch (ids.status()) {
      case "available":
        return ids.message();
      case "checking":
        return `Checking c:${handle()}…`;
      case "own":
        return `This is the id ${app().name} set up for you. Keep it, or pick another.`;
      case "unknown":
        return ids.message() ?? "Your id is how people find you. You can change it later.";
      default:
        return null;
    }
  };
  const idSuffix = () => {
    switch (ids.status()) {
      case "checking":
        return <LoaderCircle class={styles.spin} size={16} stroke-width={1.75} aria-hidden="true" />;
      case "available":
      case "own":
        return <Check class={styles.ok} size={16} stroke-width={2} aria-hidden="true" />;
      case "unavailable":
      case "invalid":
        return <CircleAlert class={styles.bad} size={16} stroke-width={1.75} aria-hidden="true" />;
      default:
        return undefined;
    }
  };
  const dobDate = () => fromDateKey(dob());
  const isDefaultDob = () => !prefill.finishing_import && dob() === prefill.dob;
  const localTime = () => (isValidTimezone(timezone()) ? formatTime(now(), timezone()) : null);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (pending() || leaving()) return;
    setAttempted(true);
    setProblem(null);
    errors.begin();
    const local: Record<string, string> = {};
    const nameIssue = nameProblem();
    if (nameIssue) local.display_name = nameIssue;
    const handleIssue = handleProblem(handle());
    if (handleIssue) local.id = handleIssue;
    else if (ids.status() === "unavailable" && ids.message()) local.id = ids.message() as string;
    if (!timezone() || !isValidTimezone(timezone())) local.timezone = "Pick your timezone from the list.";
    if (!dob()) local.dob = "Pick your date of birth.";
    setFieldErrors(local);
    if (Object.keys(local).length) return;

    const body: Record<string, unknown> = { display_name: name().trim(), id: `c:${handle()}`, timezone: timezone(), dob: dob() };
    if (photo() === "default" || photo() === "upload") body.pfp_url = null;
    if (photo() === "provider") body.pfp_url = prefill.provider_pfp_url ?? null;
    const upload = photo() === "upload" ? file() : null;

    setPending("creating");
    const failure = await props.ctl.signup(body, upload ? async () => {
      // The account exists and this browser is signed in to it: the photo can be stored now.
      setPending("uploading");
      try {
        await api.me.uploadPhoto(upload);
      } catch (raw) {
        props.onPhotoFailed(ApiError.from(raw));
      }
    } : undefined);
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
   * "Not you?": this verified email, phone or provider account is not the visitor's. Going back to the methods is not
   * enough, because the verified address stays ready for a new sign-up in this browser for 48 hours and the next
   * sign-in to any app would open on it again, with someone else's address filled in. The page cannot clear that
   * cookie itself (it is HttpOnly); signing out does, so a browser where nobody is signed in signs out first (the
   * server answers 401 and clears the cookie). A signed-in browser keeps its session: there the next sign-in offers
   * "Continue as" that account and never opens this sign-up again.
   */
  const notYou = async () => {
    if (leaving() || pending()) return;
    setLeaving(true);
    errors.begin();
    await forgetSignup();
    const failure = await props.ctl.switchAccount();
    setLeaving(false);
    if (failure) errors.fail(failure);
  };

  const ProvenAs = () => {
    const icon = () => {
      if (prefill.provider === "google") return <GoogleMark size={16} />;
      if (prefill.provider === "apple") return <AppleMark size={16} />;
      return prefill.email ? <Mail size={16} stroke-width={1.75} /> : <Smartphone size={16} stroke-width={1.75} />;
    };
    const what = () => prefill.email ?? prefill.phone ?? (prefill.provider === "apple" ? "your Apple account" : "your Google account");
    return (
      <div ref={el => useSquircle(el)} class={styles.destination}>
        <span class={styles.destinationIcon} aria-hidden="true">{icon()}</span>
        <span class={styles.accountText}>
          <span class={styles.accountName}>{what()}</span>
          <span class={styles.provenNote}>{prefill.provider ? `Verified by ${prefill.provider === "apple" ? "Apple" : "Google"}` : "Verified with a code"}</span>
        </span>
        <span class={styles.rowAction}>
          <Button variant="ghost" size="sm" loading={leaving()} disabled={!!pending()} onClick={() => void notYou()} aria-label="Not you? Use another account">Not you?</Button>
        </span>
      </div>
    );
  };

  return (
    <>
      <StepHeading
        title={prefill.finishing_import ? "Finish setting up your account" : "Set up your account"}
        description={prefill.finishing_import
          ? `${app().name} added you to Silicon Accounts. Check the details it gave us, then continue.`
          : `This is your first time here, so we filled it all in. Check it, then continue to ${destinationName()}. You can change any of it later.`}
      />
      <FlowAlert error={errors.current()} app={app().name} onSwitch={() => props.ctl.switchAccount()} />
      <ProvenAs />
      <form class={styles.form} novalidate onSubmit={submit}>
        <div class={styles.photoField}>
          <Avatar name={name().trim() || "New Carbon"} src={photoSrc()} size="xl" />
          <div class={styles.photoText}>
            <span class={styles.fieldLabel}>Profile photo</span>
            <div class={styles.photoActions}>
              <Button type="button" variant="secondary" size="sm" onClick={() => fileInput?.click()}>
                <ImageUp size={16} stroke-width={1.75} aria-hidden="true" /> {photo() === "upload" ? "Choose another" : "Upload photo"}
              </Button>
              <Show when={prefill.provider_pfp_url && photo() !== "provider"}>
                <Button type="button" variant="ghost" size="sm" onClick={() => { setPhoto("provider"); setPhotoError(null); }}>
                  Use {prefill.provider === "apple" ? "Apple" : "Google"} photo
                </Button>
              </Show>
              <Show when={photo() === "upload" || photo() === "provider" || (prefill.finishing_import && photo() === "prefill")}>
                <Button type="button" variant="ghost" size="sm" onClick={() => { setPhoto("default"); setPhotoError(null); }}>
                  Remove
                </Button>
              </Show>
            </div>
            <FieldMessage text={photoError() ?? fieldError("pfp_url") ?? (photo() === "upload" ? `${file()?.name ?? "Photo"} uploads when you continue.` : null)} tone={photoError() || fieldError("pfp_url") ? "error" : "hint"} alert={!!photoError()} />
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={PHOTO_TYPES.join(",")}
            class="sr-only"
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
          autocomplete="name"
          maxLength={100}
          value={name()}
          onInput={event => {
            setName(event.currentTarget.value);
            clearField("display_name");
          }}
          error={fieldError("display_name") ?? (attempted() ? nameProblem() : null)}
        />

        <div class={styles.idField}>
          <Input
            label="Your id"
            mono
            prefix="c:"
            suffix={idSuffix()}
            autocapitalize="off"
            autocomplete="username"
            spellcheck={false}
            maxLength={40}
            value={handle()}
            onInput={event => {
              const next = cleanHandle(event.currentTarget.value);
              if (event.currentTarget.value !== next) event.currentTarget.value = next;
              setHandle(next);
              clearField("id");
            }}
            description={idError() ? undefined : idDescription() ?? undefined}
            error={idError()}
          />
          <Show when={ids.suggestions().length && (ids.status() === "unavailable" || fieldError("id"))}>
            <div class={styles.suggestions} role="group" aria-label="Free ids">
              <span class={styles.muted}>Free:</span>
              <For each={ids.suggestions()}>
                {suggestion => (
                  <button type="button" ref={el => useSquircle(el)} class={styles.suggestion} onClick={() => { setHandle(suggestion); clearField("id"); }}>
                    c:{suggestion}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        <Combobox
          label="Timezone"
          options={zones()}
          value={timezone()}
          onValueChange={value => {
            setTimezone(value);
            clearField("timezone");
          }}
          placeholder="Search cities or offsets"
          emptyMessage="No timezone matches. Try a city, like Kolkata, or an offset, like +05:30."
          description={localTime() ? `It is ${localTime()} there now.` : undefined}
          error={fieldError("timezone")}
        />

        <DatePicker
          label="Date of birth"
          value={dobDate()}
          onChange={date => {
            setDob(date ? dateKey(date) : null);
            clearField("dob");
          }}
          minDate={MIN_DOB}
          maxDate={yesterday()}
          yearPicker
          required
          format={{ day: "numeric", month: "long", year: "numeric" }}
          description={isDefaultDob() ? "We started from 18 years ago. Set your real date of birth." : undefined}
          error={fieldError("dob")}
        />

        <FlowAlert error={problem()} title="Your account was not created" app={app().name} onSwitch={() => props.ctl.switchAccount()} />

        <Button type="submit" class={styles.wide} loading={!!pending()} disabled={leaving()}>
          {pending() === "uploading" ? "Uploading your photo" : prefill.finishing_import ? "Finish setup" : "Create account"}
        </Button>
      </form>
    </>
  );
}

/**
 * Ends the sign-up waiting in this browser (its `sa_signup` cookie) when nobody is signed in: POST
 * /v1/session/signout clears that cookie even without a session (it then answers 401, expected here). Best effort:
 * a failure leaves the sign-up as it was, which is no worse than before.
 */
async function forgetSignup(): Promise<void> {
  try {
    if (await api.session.get()) return;
    await api.session.signOut();
  } catch {
    // 401 (nobody was signed in: the cookie is cleared anyway) or the network: nothing more to do.
  }
}
