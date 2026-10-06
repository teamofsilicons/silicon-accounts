import { Show, createMemo } from "solid-js";
import { MorphText, Reveal } from "./presence";
import styles from "./field-message.module.css";

/**
 * Helper and error copy under a field (Arc FieldMessage): the row opens its height on a spring, then changed words rise
 * in while unchanged words hold still. Assistive tech reads the plain copy.
 */
export function FieldMessage(props: { id?: string; text?: string | null; tone?: "hint" | "error"; alert?: boolean }) {
  const text = createMemo(() => props.text ?? "");
  return (
    <Reveal when={!!props.text} class={styles.slot}>
      <span id={props.id} class={props.tone === "error" ? styles.error : styles.hint} role={props.alert ? "alert" : undefined}>
        <span class="sr-only">{text()}</span>
        <Show when={text()}><MorphText text={text()} by="word" class={styles.words} /></Show>
      </span>
    </Reveal>
  );
}
