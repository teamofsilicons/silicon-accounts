import { Show, splitProps, type JSX, type ParentProps } from "solid-js";
import { Dialog as K, useDialogContext } from "@kobalte/core/dialog";
import { Button, type ButtonProps } from "../button/button";
import { X } from "lucide-solid";
import { cx } from "../lib/cx";
import { SwapText } from "../lib/presence";
import { useSquircle } from "../lib/squircle";
import styles from "./dialog.module.css";

export interface DialogProps extends ParentProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Modal dialogs trap focus and hide the rest of the page from assistive tech. Default true. */
  modal?: boolean;
}

/** Arc Dialog root (Kobalte). Compose with DialogTrigger and DialogContent. */
export function Dialog(props: DialogProps) {
  return <K open={props.open} defaultOpen={props.defaultOpen} onOpenChange={props.onOpenChange} modal={props.modal ?? true} preventScroll>{props.children}</K>;
}

/** The button that opens the dialog. Pass `as={Button}` (with its props) to use an Arc button. */
export const DialogTrigger = K.Trigger;
/**
 * An Arc Button that closes the dialog (for footer actions such as "Keep my account"). Its visible label stays its
 * accessible name; Kobalte's own CloseButton would replace it with "Dismiss".
 */
export function DialogClose(props: ButtonProps) {
  const context = useDialogContext();
  const [local, rest] = splitProps(props, ["onClick", "variant"]);
  return (
    <Button
      {...rest}
      variant={local.variant ?? "ghost"}
      onClick={event => {
        const handler = local.onClick;
        if (typeof handler === "function") handler(event);
        context.close();
      }}
    />
  );
}

export interface DialogContentProps {
  title: string;
  description?: string;
  children?: JSX.Element;
  /** Footer actions, right-aligned (one primary action at most). */
  footer?: JSX.Element;
  class?: string;
  /** "md" is Arc's 440px; "lg" fits forms and previews. */
  size?: "md" | "lg";
  /** Hide the close button (for decisions that must be answered). */
  hideClose?: boolean;
  onOpenAutoFocus?: (event: Event) => void;
  role?: "dialog" | "alertdialog";
}

/**
 * Arc DialogContent: the overlay fades while the dialog rises 8px and scales up on a spring; closing is shorter and
 * quieter. A changed title or description rises in place. Focus is trapped and returns to the trigger.
 */
export function DialogContent(props: DialogContentProps) {
  const [local] = splitProps(props, ["title", "description", "children", "footer", "class", "size", "hideClose", "onOpenAutoFocus", "role"]);
  return (
    <K.Portal>
      <K.Overlay class={styles.overlay} />
      <div class={styles.positioner}>
        <K.Content
          ref={(el: HTMLDivElement) => useSquircle(el)}
          class={cx(styles.content, local.size === "lg" && styles.lg, local.class)}
          onOpenAutoFocus={local.onOpenAutoFocus}
          role={local.role}
        >
          <div class={styles.header}>
            <div class={styles.heading}>
              <K.Title class={styles.title}><SwapText text={local.title} /></K.Title>
              <Show when={local.description}><K.Description class={styles.description}><SwapText text={local.description ?? ""} /></K.Description></Show>
            </div>
            <Show when={!local.hideClose}>
              <K.CloseButton ref={(el: HTMLButtonElement) => useSquircle(el)} class={styles.close} aria-label="Close dialog"><X size={16} stroke-width={1.75} aria-hidden="true" /></K.CloseButton>
            </Show>
          </div>
          <div class={styles.body}>{local.children}</div>
          <Show when={local.footer}><div class={styles.footer}>{local.footer}</div></Show>
        </K.Content>
      </div>
    </K.Portal>
  );
}

export default Dialog;
