"use client";

/**
 * A write-only secret in the sign-in setup (a Google client secret, an Apple .p8 key). Silicon Accounts stores it
 * encrypted and only ever says whether one is stored: the field shows that state, lets you replace it, or marks it
 * for removal on save.
 */
import { useRef, useState, type ReactNode } from "react";
import { Check, FileKey, Undo2 } from "lucide-react";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { Textarea } from "@/components/arc/textarea/textarea";
import styles from "./parts.module.css";

export interface SecretFieldProps {
  label: string;
  /** What is stored, in words: "A client secret is stored". */
  storedLabel: string;
  stored: boolean;
  value: string;
  onValueChange: (value: string) => void;
  remove: boolean;
  onRemoveChange: (remove: boolean) => void;
  description?: ReactNode;
  error?: string;
  placeholder?: string;
  /** A multi-line PEM key with a file picker. */
  multiline?: boolean;
  /** For multiline keys: the file types the picker offers. */
  accept?: string;
}

export function SecretField({ label, storedLabel, stored, value, onValueChange, remove, onRemoveChange, description, error, placeholder, multiline, accept = ".p8,.pem,.txt" }: SecretFieldProps) {
  const [replacing, setReplacing] = useState(false);
  const [fileError, setFileError] = useState<string | undefined>();
  const file = useRef<HTMLInputElement>(null);
  const editing = (!stored || replacing || !!value) && !remove;

  const readFile = async (picked: File | undefined) => {
    setFileError(undefined);
    if (!picked) return;
    if (picked.size > 8192) {
      setFileError(`${picked.name} is ${Math.ceil(picked.size / 1024)} KB; an Apple .p8 key is under 1 KB. Pick the AuthKey_….p8 file Apple gave you.`);
      return;
    }
    onValueChange((await picked.text()).trim());
  };

  const keepStored = () => {
    onValueChange("");
    setReplacing(false);
  };

  return (
    <div className={styles.secretField}>
      {!editing ? (
        <div className={styles.secretFieldBlock}>
          <span className={styles.copyLabel}>{label}</span>
          <div data-sq="surface" className={styles.secretStored} data-remove={remove || undefined}>
            <span className={styles.secretStoredText}>
              {remove ? "It will be removed when you save." : <><Check size={16} strokeWidth={2} aria-hidden="true" className={styles.secretStoredIcon} />{storedLabel}</>}
            </span>
            {remove ? (
              <Button size="sm" variant="ghost" onClick={() => onRemoveChange(false)}><Undo2 size={14} strokeWidth={1.75} aria-hidden="true" />Keep it</Button>
            ) : (
              <span className={styles.secretStoredActions}>
                <Button size="sm" variant="secondary" onClick={() => setReplacing(true)}>Replace</Button>
                <Button size="sm" variant="ghost" onClick={() => onRemoveChange(true)}>Remove</Button>
              </span>
            )}
          </div>
          {error ? <p className={styles.fieldError} role="alert">{error}</p> : null}
        </div>
      ) : multiline ? (
        <div className={styles.secretFieldBlock}>
          <Textarea
            label={label}
            className={styles.mono}
            rows={6}
            spellCheck={false}
            autoComplete="off"
            placeholder={placeholder}
            value={value}
            onChange={event => onValueChange(event.currentTarget.value)}
            description={typeof description === "string" ? description : undefined}
            error={error ?? fileError}
          />
          <div className={styles.secretFileRow}>
            <Button size="sm" variant="secondary" onClick={() => file.current?.click()}><FileKey size={14} strokeWidth={1.75} aria-hidden="true" />Load the .p8 file</Button>
            {stored ? <Button size="sm" variant="ghost" onClick={keepStored}>Keep the stored key</Button> : null}
            <input
              ref={file}
              type="file"
              accept={accept}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={event => {
                void readFile(event.currentTarget.files?.[0]);
                event.currentTarget.value = "";
              }}
            />
          </div>
        </div>
      ) : (
        <div className={styles.secretFieldBlock}>
          <Input
            label={label}
            type="password"
            className={styles.mono}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={value}
            onChange={event => onValueChange(event.currentTarget.value)}
            description={typeof description === "string" ? description : undefined}
            error={error}
          />
          {stored ? <div className={styles.secretFileRow}><Button size="sm" variant="ghost" onClick={keepStored}>Keep the stored secret</Button></div> : null}
        </div>
      )}
      {description && typeof description !== "string" ? <div className={styles.copyDescription}>{description}</div> : null}
    </div>
  );
}
