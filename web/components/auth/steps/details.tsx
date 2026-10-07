"use client";

/**
 * details: one page of the app's flow (UNDERSTANDING.md "What's shared with the app" and "Flows"). An app picks the
 * details it wants, each required or optional, and its flow decides which of them are asked on which page, with the
 * page's own title, subtitle, continue label and layout (FlowView.details). An app without a flow of its own gets one
 * page with every detail: the what's-shared screen.
 *
 * - Required details are always shared (a lock says so). A required email or phone the account does not have yet is
 *   added right here, with a 6 digit code, before the page can continue.
 * - Optional details have a checkbox, unticked until the Carbon ticks it (a Carbon who shared it before finds it
 *   ticked). A missing optional email or phone can be added here too.
 * - The first page also shows who is signing in (with "Switch account") and the profile every app sees.
 * - Back returns to the previous page with its choices; Cancel ends the sign-in and the app gets nothing.
 */
import { useId, useRef, useState } from "react";
import { Lock } from "lucide-react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Checkbox } from "@/components/arc/checkbox/checkbox";
import type { ApiError } from "@/lib/api/errors";
import type { ContactField, FlowChallenge, FlowDetailField, FlowDetails } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { isValidTimezone, timezoneLabel, utcOffset } from "@/lib/timezones";
import type { ActionResult, FlowController } from "../flow/controller";
import { useFinePointer } from "../flow/hooks";
import type { HostedFlow } from "../flow/model";
import { StepMorph } from "../flow/morph";
import { AccountRow, CodeEntry, ContactForm, DestinationRow, FieldNote, FlowAlert, StepHeading, useStepErrors, type ContactKind } from "../flow/parts";
import styles from "../flow/flow.module.css";

export interface DetailsProps {
  flow: HostedFlow;
  ctl: FlowController;
  notice: ApiError | null;
}

/** Labels when the server sends none. */
export const DETAIL_LABEL: Record<ContactField | "profile", string> = {
  profile: "Name, id and profile photo",
  email: "Email address",
  phone: "Phone number",
  dob: "Date of birth",
  timezone: "Timezone",
};

/** Lower-case names for sentences ("Add your phone number"). */
const DETAIL_NAME: Record<ContactField, string> = { email: "email address", phone: "phone number", dob: "date of birth", timezone: "timezone" };

/** The same with its article ("Add an email address", "needs a phone number"). */
const A_DETAIL: Record<ContactField, string> = { email: "an email address", phone: "a phone number", dob: "a date of birth", timezone: "a timezone" };

/**
 * The first field in `root` the Carbon can type in. PhoneField's country search comes first in the DOM but sits in an
 * inert row while its list is closed, where focus() does nothing; a leaving morph step is inert too.
 */
function firstField(root: HTMLElement | null): HTMLInputElement | null {
  const inputs = root ? Array.from(root.querySelectorAll<HTMLInputElement>("input:not(:disabled)")) : [];
  return inputs.find(input => !input.closest("[inert], [aria-hidden='true']")) ?? null;
}

/** Values as people read them: "Mar 14, 1998", "Kolkata, Asia (UTC+05:30)"; contact values come masked. */
export function detailValue(field: string, value: string | null): string | null {
  if (value === null) return null;
  if (field === "dob" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  if (field === "timezone" && isValidTimezone(value)) return `${timezoneLabel(value)} (UTC${utcOffset(value)})`;
  return value;
}

const isContact = (field: string): field is ContactKind => field === "email" || field === "phone";

/** Failures about the account rather than a detail: they belong in the step's alert, with its "Sign in again". */
const ACCOUNT_GONE = new Set(["session_required", "account_changed"]);

/** "your phone number", "your email address and phone number". */
function listOf(fields: ContactField[]): string {
  const names = fields.map(field => DETAIL_NAME[field]);
  if (names.length <= 1) return `your ${names[0] ?? "details"}`;
  return `your ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The page's own title, unless the app gave it one. */
function defaultTitle(details: FlowDetails, fields: FlowDetailField[], app: string, asksAgain: boolean): string {
  if (details.count <= 1) return asksAgain ? `${app} would like a little more` : `Share your details with ${app}`;
  if (fields.length && fields.every(field => isContact(field.field))) return `How ${app} can reach you`;
  if (fields.length && fields.every(field => !isContact(field.field))) return "A little about you";
  return `Share your details with ${app}`;
}

export function Details(props: DetailsProps) {
  const details = props.flow.details;
  // Each page starts from what the server says it shares (choices made earlier come back with Back).
  return details ? <DetailsPage key={`${details.id}:${details.index}`} {...props} details={details} /> : null;
}

function DetailsPage({ flow, ctl, notice, details }: DetailsProps & { details: FlowDetails }) {
  const app = flow.app.name;
  const account = flow.signed_in_as;
  const fine = useFinePointer();
  // The server may list the profile itself; the page draws it (first page only), so it is left out here.
  const fields = details.fields.filter(field => (field.field as string) !== "profile");
  const [ticked, setTicked] = useState<Set<ContactField>>(() => new Set(fields.filter(field => field.mode === "optional" && field.shared && !field.missing).map(field => field.field)));
  /** The missing detail the Carbon chose to add (a required one opens by itself). */
  const [adding, setAdding] = useState<ContactKind | null>(null);
  /** The Carbon asked to send the code somewhere else. */
  const [changing, setChanging] = useState(false);
  const [lastValue, setLastValue] = useState<{ kind: ContactKind; value: string } | null>(null);
  const [pending, setPending] = useState<"continue" | "back" | "cancel" | "switch" | null>(null);
  /** Why Continue, Back or Cancel did not go through (shown by the buttons). */
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const errors = useStepErrors(flow.error ?? notice);
  const adder = useRef<HTMLDivElement>(null);
  // A detail added on this page (or meanwhile, elsewhere) takes the server's answer: an optional email or phone the
  // Carbon just added starts ticked.
  const presentKey = fields.filter(field => !field.missing).map(field => field.field).join(",");
  const [seenPresent, setSeenPresent] = useState(presentKey);
  if (seenPresent !== presentKey) {
    const before = new Set(seenPresent.split(",").filter(Boolean));
    const arrived = fields.filter(field => field.mode === "optional" && !field.missing && !before.has(field.field));
    setSeenPresent(presentKey);
    if (arrived.length) {
      setTicked(current => {
        const next = new Set(current);
        for (const field of arrived) {
          if (field.shared) next.add(field.field);
          else next.delete(field.field);
        }
        return next;
      });
    }
  }

  const missingRequired = fields.filter(field => field.mode === "required" && field.missing && isContact(field.field)).map(field => field.field as ContactKind);
  const challenge: FlowChallenge | null = details.challenge;
  // A detail is still being added when it is still missing: a code that went to a detail which is now there is done.
  const challengeFor = challenge && fields.some(field => field.field === challenge.channel && field.missing) ? challenge.channel : null;
  const addKind: ContactKind | null = challengeFor ?? (adding && fields.some(field => field.field === adding && field.missing) ? adding : missingRequired[0] ?? null);
  const codeMode = !!challenge && !changing && challengeFor === addKind && !!addKind;
  const addingRequired = !!addKind && missingRequired.includes(addKind);
  const asksAgain = fields.some(field => field.previously_granted) && fields.some(field => !field.previously_granted);
  const isNew = (field: FlowDetailField) => asksAgain && !field.previously_granted;
  const first = details.index === 0;
  const last = details.index >= details.count - 1;
  const title = details.title?.trim() || defaultTitle(details, fields, app, asksAgain);
  const description = details.subtitle?.trim() || `${app} sees these now and whenever they change. You can remove its access at any time in your account.`;
  // The last page of a flow with a review page goes there first: nothing is shared until the Carbon approves it.
  const continueLabel = details.continue_label?.trim() || (details.review_next ? "Review" : last ? "Share and continue" : "Continue");
  const locked = !!pending;

  const toggle = (field: ContactField, on: boolean) => {
    setBlocked(null);
    setTicked(current => {
      const next = new Set(current);
      if (on) next.add(field);
      else next.delete(field);
      return next;
    });
  };

  /** A failure about the account goes to the alert (with its fix); anything else stays by the field that caused it. */
  const routed = (failure: ActionResult): ActionResult => {
    if (failure && ACCOUNT_GONE.has(failure.code)) {
      errors.fail(failure);
      return null;
    }
    return failure;
  };
  const send = async (kind: ContactKind, value: string, country?: string) => {
    errors.begin();
    setBlocked(null);
    const failure = kind === "email" ? await ctl.detailsAddEmail(value) : await ctl.detailsAddPhone(value, country);
    if (!failure) {
      setLastValue({ kind, value });
      setChanging(false);
    }
    return routed(failure);
  };
  const verify = async (code: string) => {
    errors.begin();
    const failure = routed(await ctl.detailsVerify(code));
    if (!failure) {
      setAdding(null);
      setChanging(false);
    }
    return failure;
  };
  const resend = async () => {
    errors.begin();
    return routed(await ctl.resend());
  };

  const act = async (kind: "continue" | "back" | "cancel" | "switch", call: () => Promise<ActionResult>) => {
    setProblem(null);
    setBlocked(null);
    errors.begin();
    setPending(kind);
    const failure = await call();
    // On success the card moves on; the buttons stay busy until it does.
    if (!failure) return;
    setPending(null);
    if (ACCOUNT_GONE.has(failure.code)) errors.fail(failure);
    else setProblem(failure);
  };

  const proceed = () => {
    if (missingRequired.length) {
      // Nothing to ask the server yet: say what is missing and take the Carbon to it.
      setBlocked(`${app} needs ${listOf(missingRequired)} on your account to continue. Add it above.`);
      firstField(adder.current)?.focus();
      return;
    }
    const share = fields.filter(field => field.mode === "optional" && !field.missing && ticked.has(field.field)).map(field => field.field);
    void act("continue", () => ctl.detailsContinue(share));
  };

  const profileValue = account ? `${account.display_name}${account.id ? ` (${account.id})` : ""}` : null;

  return (
    <>
      {details.count > 1 ? <PageProgress index={details.index} count={details.count} /> : null}
      <StepHeading title={title} description={description} noFocus={codeMode && fine} />
      <FlowAlert error={errors.current} app={app} onSwitch={() => ctl.switchAccount()} />
      {first && account ? (
        <AccountRow
          account={account}
          size="sm"
          action={<Button variant="ghost" size="sm" loading={pending === "switch"} disabled={locked && pending !== "switch"} onClick={() => void act("switch", () => ctl.switchAccount())}>Switch account</Button>}
        />
      ) : null}
      <ul data-sq="surface" className={styles.shareList} aria-label={`Details shared with ${app}`}>
        {first && profileValue ? (
          <li className={styles.shareRow} data-field="profile" data-required="">
            <span className={styles.shareText}>
              <span className={styles.shareLabel}>{DETAIL_LABEL.profile}</span>
              <span className={styles.shareValue}>{profileValue}</span>
            </span>
            <span className={styles.shareLock} title="Always shared">
              <Lock size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>Always</span>
            </span>
          </li>
        ) : null}
        {fields.map(field => (
          <DetailRow
            key={field.field}
            field={field}
            isNew={isNew(field)}
            ticked={ticked.has(field.field)}
            onToggle={on => toggle(field.field, on)}
            disabled={locked}
            adding={addKind === field.field}
            onAdd={isContact(field.field) && field.missing ? () => { setAdding(field.field as ContactKind); setChanging(false); setBlocked(null); } : undefined}
          />
        ))}
      </ul>
      {addKind ? (
        <div ref={adder} className={styles.adder} data-adding={addKind}>
          <div className={styles.adderHead}>
            <p className={styles.adderTitle}>{addingRequired ? `Add your ${DETAIL_NAME[addKind]}` : `Add ${A_DETAIL[addKind]}`}</p>
            <p className={styles.adderText}>
              {addingRequired
                ? `${app} needs ${A_DETAIL[addKind]} on your account. We ${addKind === "phone" ? "text" : "email"} a 6 digit code to make sure it is yours.`
                : `It joins your account, ticked to share with ${app} (untick it to keep it to yourself). We ${addKind === "phone" ? "text" : "email"} a 6 digit code to make sure it is yours.`}
            </p>
          </div>
          {/* The field and the code morph into each other, like the sign-in steps. */}
          <StepMorph view={codeMode ? `code:${addKind}` : `form:${addKind}`} order={["form", "code"]}>
            {view =>
              view.startsWith("code") && challenge ? (
                <div className={styles.stack}>
                  <DestinationRow
                    channel={challenge.channel}
                    destination={challenge.destination}
                    action={<Button variant="ghost" size="sm" onClick={() => setChanging(true)} aria-label={`Change the ${challenge.channel === "email" ? "email address" : "phone number"} the code goes to`}>Change</Button>}
                  />
                  <CodeEntry
                    challenge={challenge}
                    verify={verify}
                    resend={resend}
                    label={challenge.channel === "email" ? "Code from the email" : "Code from the text message"}
                    submitLabel={challenge.channel === "email" ? "Add email" : "Add phone number"}
                  />
                </div>
              ) : (
                <div className={styles.stack}>
                  <ContactForm
                    kinds={[view.endsWith("phone") ? "phone" : "email"]}
                    initialEmail={lastValue?.kind === "email" ? lastValue.value : ""}
                    initialPhone={lastValue?.kind === "phone" ? lastValue.value : ""}
                    submitLabel="Send code"
                    onSubmit={send}
                    autoFocus={fine && first && !challenge}
                    note={view.endsWith("phone") ? "We text a 6 digit code to this number." : "We email a 6 digit code to this address."}
                    errorContext={{ app }}
                    kindsLabel="Add"
                  />
                  {changing && challenge ? <button type="button" className={styles.textButton} onClick={() => setChanging(false)}>Back to the code</button> : null}
                  {!addingRequired && !challengeFor ? <button type="button" className={styles.textButton} onClick={() => setAdding(null)}>Not now</button> : null}
                </div>
              )
            }
          </StepMorph>
        </div>
      ) : null}
      <FieldNote text={blocked} tone="error" alert />
      <FlowAlert error={problem} app={app} onSwitch={() => ctl.switchAccount()} />
      <div className={styles.actions}>
        {/* One primary action per page: while a detail is being added, adding it is the primary one. */}
        <Button variant={addKind ? "secondary" : "primary"} className={styles.wide} loading={pending === "continue"} disabled={locked && pending !== "continue"} onClick={proceed}>
          {continueLabel}
        </Button>
        {first ? (
          <Button variant="secondary" className={styles.wide} loading={pending === "cancel"} disabled={locked && pending !== "cancel"} onClick={() => void act("cancel", () => ctl.review(false))}>
            Cancel
          </Button>
        ) : (
          <>
            <Button variant="secondary" className={styles.wide} loading={pending === "back"} disabled={locked && pending !== "back"} onClick={() => void act("back", () => ctl.detailsBack())}>
              Back
            </Button>
            <button type="button" className={styles.textButton} disabled={locked} onClick={() => void act("cancel", () => ctl.review(false))}>
              {pending === "cancel" ? "Cancelling…" : "Cancel signing in"}
            </button>
          </>
        )}
      </div>
    </>
  );
}

/** "Step 1 of 3" with a dot per page: done, current, still to come. */
export function PageProgress({ index, count }: { index: number; count: number }) {
  return (
    <div className={styles.pageProgress}>
      <span className={styles.pageDots} aria-hidden="true">
        {Array.from({ length: count }, (_, position) => (
          <span key={position} data-state={position < index ? "done" : position === index ? "current" : "next"} />
        ))}
      </span>
      <span className={styles.pageCount}>{`Step ${Math.min(index + 1, count)} of ${count}`}</span>
    </div>
  );
}

interface DetailRowProps {
  field: FlowDetailField;
  isNew: boolean;
  ticked: boolean;
  onToggle: (on: boolean) => void;
  disabled: boolean;
  /** This row's detail is being added below the list. */
  adding: boolean;
  /** Opens the adder for this missing email or phone. */
  onAdd?: () => void;
}

/** One detail: a lock for a required one, a checkbox for an optional one, and "Add" for a missing email or phone. */
function DetailRow({ field, isNew, ticked, onToggle, disabled, adding, onAdd }: DetailRowProps) {
  const id = useId();
  const label = field.label?.trim() || DETAIL_LABEL[field.field] || field.field;
  const value = detailValue(field.field, field.value);
  const required = field.mode === "required";
  const missingText = required ? "Not added yet. Add it below to continue." : "You have not added one, so nothing is shared.";
  const addButton = onAdd && !adding ? <Button variant="ghost" size="sm" onClick={onAdd} disabled={disabled} aria-label={required ? `Add your ${DETAIL_NAME[field.field]}` : `Add ${A_DETAIL[field.field]}`}>Add</Button> : null;
  const newBadge = isNew ? <Badge tone="info" size="sm">New</Badge> : null;
  if (required) {
    return (
      <li className={styles.shareRow} data-field={field.field} data-required="" data-missing={field.missing || undefined}>
        <span className={styles.shareText}>
          <span className={styles.shareLabel}>{label}{newBadge}</span>
          <span className={styles.shareValue} data-missing={field.missing || undefined}>{field.missing ? (adding ? "Adding it below." : missingText) : value}</span>
        </span>
        {addButton}
        <span className={styles.shareLock} title="Always shared">
          <Lock size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>Required</span>
        </span>
      </li>
    );
  }
  return (
    <li className={styles.shareRow} data-field={field.field} data-optional="" data-missing={field.missing || undefined}>
      <span className={styles.shareCheck}>
        {/* Named by the row's label (Arc's own fallback name, "Checkbox", would win over a <label for>). */}
        <Checkbox id={id} checked={!field.missing && ticked} disabled={field.missing || disabled} onCheckedChange={next => onToggle(next === true)} aria-labelledby={`${id}-label`} aria-describedby={`${id}-value`} />
      </span>
      <label htmlFor={id} className={styles.shareText} data-disabled={field.missing || undefined}>
        <span id={`${id}-label`} className={styles.shareLabel}>{label}{newBadge}<span className={styles.shareOptional}>Optional</span></span>
        <span id={`${id}-value`} className={styles.shareValue}>{field.missing ? (adding ? "Adding it below." : missingText) : value}</span>
      </label>
      {addButton}
    </li>
  );
}
