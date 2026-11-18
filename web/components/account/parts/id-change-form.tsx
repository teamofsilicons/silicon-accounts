"use client";

/**
 * Changing a c:id or si:id: the live-checked field with what happens to the old id as its hint (reserved 10 days, and
 * it can be taken back), who is told, and the submit. Used for your own id (the identity card) and for a Silicon's (its drawer). For a Silicon the
 * check runs with `for=<its uuid>`, so an id still reserved for that Silicon comes back as one it can take back.
 */
import { useState, type FormEvent, type Ref } from "react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { ApiError } from "@/lib/api/errors";
import { describeError } from "./common";
import { IdField, useIdCheck, type IdPrefix } from "./id-field";
import styles from "./id-field.module.css";

export interface IdChangeFormProps {
  prefix: IdPrefix;
  currentId: string | null;
  uuid: string;
  /** Whose id this is: the signed-in account's own, or a Silicon's (custodian view). */
  subject: "self" | "silicon";
  /** Performs the change. Reject with the API error; the form explains it. */
  submit: (id: string) => Promise<unknown>;
  /** After a change: the new id and the one it replaced (read before the change, so it is the old one). */
  onChanged: (id: string, previous: string | null) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}

export function IdChangeForm({ prefix, currentId, uuid, subject, submit, onChanged, onCancel, autoFocus, inputRef }: IdChangeFormProps) {
  const [handle, setHandle] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ message: string; suggestions: string[] } | null>(null);
  const check = useIdCheck(prefix, handle, currentId, subject === "silicon" ? uuid : undefined);
  const reclaim = check.status === "available" && check.reclaimable ? check.id : null;
  const ready = check.status === "available" && !pending;

  const change = (value: string) => {
    setFailure(null);
    setHandle(value);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || check.status !== "available") return;
    const target = check.id;
    // Read before the change: once it lands, the account's id (and so currentId) is the new one.
    const previous = currentId;
    setPending(true);
    setFailure(null);
    try {
      await submit(target);
      onChanged(target, previous);
    } catch (raw) {
      const error = ApiError.from(raw);
      const message = describeError(error);
      setFailure({ message, suggestions: error.suggestions.slice(0, 3) });
    } finally {
      setPending(false);
    }
  };

  // The flow is: what the id is (the dialog's description), the field, then what a change does (Anil, 2026-11-11 audit).
  // What happens to the old id is the field's hint until the live status takes its place; who is told is a note under
  // it. The uuid isn't shown here: it was fine print in the middle of a sentence.
  const reserved = currentId
    ? subject === "self"
      ? <>Changed your mind? You have 10 days to take <strong>{currentId}</strong> back before anyone else can.</>
      : <>Changed your mind? It has 10 days to take <strong>{currentId}</strong> back before anyone else can.</>
    : prefix === "c:" ? "Pick a CarbonID Carbons and Silicons can type." : "Pick an id Carbons and Silicons can type.";
  // Only what a change does for you (Anil, 2026-11-11: copy B); that apps know you by the uuid is for developers.
  const told = subject === "self"
    ? `Every app you've signed into gets your new ${prefix === "c:" ? "CarbonID" : "id"}.`
    : "It is notified through Ting, and every app it has signed into gets its new id.";
  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
      <IdField
        prefix={prefix}
        value={handle}
        onValueChange={change}
        check={check}
        description={reserved}
        error={failure?.message}
        suggestions={failure?.suggestions}
        autoFocus={autoFocus}
        inputRef={inputRef}
        readOnly={pending}
        reclaimText={id => (subject === "self"
          ? `${id} was your CarbonID and is still reserved for you, so you can take it back.`
          : `${id} was this Silicon's id and is still reserved for it, so you can take it back.`)}
      />
      <p className={styles.note}><span className={styles.noteLabel}>Note:</span> {told}</p>
      <div className={styles.formActions}>
        {onCancel ? <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>Cancel</Button> : null}
        <Button type="submit" loading={pending} disabled={!ready && !pending}>{reclaim ? `Take back ${reclaim}` : prefix === "c:" ? "Change CarbonID" : "Change id"}</Button>
      </div>
    </form>
  );
}
