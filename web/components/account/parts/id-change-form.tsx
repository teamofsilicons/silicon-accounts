"use client";

/**
 * Changing a c:id or si:id: the live-checked field, what happens to the old id (reserved 10 days, and it can be taken
 * back), and the submit. Used for your own id (the identity card) and for a Silicon's (its drawer). For a Silicon the
 * check runs with `for=<its uuid>`, so an id still reserved for that Silicon comes back as one it can take back.
 */
import { useState, type FormEvent, type Ref } from "react";
import { Button } from "@/components/arc/button/button";
import { ApiError } from "@/lib/api/errors";
import { describeError } from "./common";
import { IdField, useIdCheck, type IdPrefix } from "./id-field";
import styles from "./parts.module.css";

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

  const keeps = subject === "self" ? "you" : "this Silicon";
  return (
    <form className={styles.idForm} onSubmit={onSubmit} noValidate>
      <p className={styles.formNote}>
        {currentId
          ? <>When it changes, <span className="mono">{currentId}</span> stays reserved for {keeps} for 10 days: nobody else can take it, and {subject === "self" ? "you can take it back" : "you can take it back for it"}. </>
          : <>Pick an id people can type. </>}
        {subject === "self"
          ? <>Every app you have signed into is told. Apps know you by your uuid <span className="mono">{uuid}</span>, which never changes.</>
          : <>Its webhook and every app it has signed into are told. Apps know it by its uuid <span className="mono">{uuid}</span>, which never changes.</>}
      </p>
      <IdField
        prefix={prefix}
        value={handle}
        onValueChange={change}
        check={check}
        error={failure?.message}
        suggestions={failure?.suggestions}
        autoFocus={autoFocus}
        inputRef={inputRef}
        readOnly={pending}
        reclaimText={id => (subject === "self"
          ? `${id} was your id and is still reserved for you, so you can take it back.`
          : `${id} was this Silicon's id and is still reserved for it, so you can take it back.`)}
      />
      <div className={styles.formActions}>
        {onCancel ? <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>Cancel</Button> : null}
        <Button type="submit" loading={pending} disabled={!ready && !pending}>{reclaim ? `Take back ${reclaim}` : "Change id"}</Button>
      </div>
    </form>
  );
}
