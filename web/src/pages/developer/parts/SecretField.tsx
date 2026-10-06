/**
 * A write-only secret in a config form (a Google client secret, an Apple .p8 key). Silicon Accounts stores it
 * encrypted and only ever says whether one is stored: the field shows that state, lets you replace it, or marks it
 * for removal on save.
 */
import { Show, createSignal, type JSX } from "solid-js";
import { Check, FileKey, Undo2 } from "lucide-solid";
import { Button } from "../../../arc/button/button";
import { Input } from "../../../arc/input/input";
import { Textarea } from "../../../arc/textarea/textarea";
import { FieldMessage } from "../../../arc/lib/FieldMessage";
import { useSquircle } from "../../../arc/lib/squircle";
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
  description?: JSX.Element;
  error?: string | null;
  placeholder?: string;
  /** A multi-line PEM key with a file picker. */
  multiline?: boolean;
  /** For multiline keys: the file types the picker offers, e.g. ".p8". */
  accept?: string;
}

export function SecretField(props: SecretFieldProps) {
  const [replacing, setReplacing] = createSignal(false);
  const [fileError, setFileError] = createSignal<string | null>(null);
  let file: HTMLInputElement | undefined;
  const editing = () => !props.stored || replacing() || !!props.value;

  const readFile = async (picked: File | undefined) => {
    setFileError(null);
    if (!picked) return;
    if (picked.size > 8192) {
      setFileError(`${picked.name} is ${Math.ceil(picked.size / 1024)} KB; an Apple .p8 key is under 1 KB. Pick the AuthKey_….p8 file Apple gave you.`);
      return;
    }
    props.onValueChange((await picked.text()).trim());
  };

  return (
    <div class={styles.secretField}>
      <Show
        when={editing() && !props.remove}
        fallback={
          <div class={styles.secretFieldBlock}>
            <span class={styles.copyLabel}>{props.label}</span>
            <div ref={el => useSquircle(el)} class={styles.secretStored} data-remove={props.remove || undefined}>
              <span class={styles.secretStoredText}>
                <Show when={!props.remove} fallback={<>It will be removed when you save.</>}>
                  <Check size={16} stroke-width={2} aria-hidden="true" class={styles.secretStoredIcon} />{props.storedLabel}
                </Show>
              </span>
              <Show
                when={!props.remove}
                fallback={<Button size="sm" variant="ghost" onClick={() => props.onRemoveChange(false)}><Undo2 size={14} stroke-width={1.75} aria-hidden="true" />Keep it</Button>}
              >
                <span class={styles.secretStoredActions}>
                  <Button size="sm" variant="secondary" onClick={() => setReplacing(true)}>Replace</Button>
                  <Button size="sm" variant="ghost" onClick={() => props.onRemoveChange(true)}>Remove</Button>
                </span>
              </Show>
            </div>
            <FieldMessage id={undefined} text={props.error} tone="error" alert />
          </div>
        }
      >
        <Show
          when={props.multiline}
          fallback={
            <Input
              label={props.label}
              type="password"
              mono
              autocomplete="off"
              spellcheck={false}
              placeholder={props.placeholder}
              value={props.value}
              onInput={event => props.onValueChange(event.currentTarget.value)}
              description={typeof props.description === "string" ? props.description : undefined}
              error={props.error}
              suffix={props.stored ? <button type="button" class={styles.inlineAction} onClick={() => { props.onValueChange(""); setReplacing(false); }}>Keep stored</button> : undefined}
            />
          }
        >
          <div class={styles.secretFieldBlock}>
            <Textarea
              label={props.label}
              mono
              rows={6}
              spellcheck={false}
              autocomplete="off"
              placeholder={props.placeholder}
              value={props.value}
              onInput={event => props.onValueChange(event.currentTarget.value)}
              description={typeof props.description === "string" ? props.description : undefined}
              error={props.error ?? fileError()}
            />
            <div class={styles.secretFileRow}>
              <Button size="sm" variant="secondary" onClick={() => file?.click()}><FileKey size={14} stroke-width={1.75} aria-hidden="true" />Load the .p8 file</Button>
              <Show when={props.stored}><Button size="sm" variant="ghost" onClick={() => { props.onValueChange(""); setReplacing(false); }}>Keep the stored key</Button></Show>
              <input ref={file} type="file" accept={props.accept ?? ".p8,.pem,.txt"} class="sr-only" tabIndex={-1} aria-hidden="true" onChange={event => { void readFile(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
            </div>
          </div>
        </Show>
      </Show>
      <Show when={typeof props.description !== "string" && props.description}><div class={styles.copyDescription}>{props.description}</div></Show>
    </div>
  );
}
