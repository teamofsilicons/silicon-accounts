import { createContext, splitProps, useContext, type Accessor, type JSX, type ParentProps } from "solid-js";
import { Popover as K } from "@kobalte/core/popover";
import { cx } from "../lib/cx";
import { useSquircle } from "../lib/squircle";
import styles from "./popover.module.css";

type Placement = "top" | "bottom" | "left" | "right" | "top-start" | "top-end" | "bottom-start" | "bottom-end" | "left-start" | "left-end" | "right-start" | "right-end";

export interface PopoverProps extends ParentProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: Placement;
  gutter?: number;
  modal?: boolean;
}

const SideContext = createContext<Accessor<string>>(() => "bottom");

/** Arc Popover root (Kobalte): small anchored controls that do not dim the page. */
export function Popover(props: PopoverProps) {
  // Kobalte's popover does not report its final side, so the side is derived from the requested placement.
  const side = () => (props.placement ?? "bottom-start").split("-")[0] ?? "bottom";
  return (
    <SideContext.Provider value={side}>
    <K
      open={props.open}
      defaultOpen={props.defaultOpen}
      onOpenChange={props.onOpenChange}
      placement={props.placement ?? "bottom-start"}
      gutter={props.gutter ?? 6}
      overflowPadding={10}
      modal={props.modal}
    >
      {props.children}
    </K>
    </SideContext.Provider>
  );
}

/** The trigger anchors the panel, so it opts out of press-scale: a scaled rect would shift the panel. */
export const PopoverTrigger = K.Trigger;
export const PopoverClose = K.CloseButton;
export const PopoverTitle = K.Title;
export const PopoverDescription = K.Description;

export interface PopoverContentProps {
  class?: string;
  children?: JSX.Element;
  style?: JSX.CSSProperties;
}

/** The panel starts a few pixels toward its trigger and settles on a spring; it leaves faster than it arrives (Arc). */
export function PopoverContent(props: PopoverContentProps) {
  const [local] = splitProps(props, ["class", "children", "style"]);
  const placementSide = useContext(SideContext);
  return (
    <K.Portal>
      <K.Content ref={(el: HTMLDivElement) => useSquircle(el)} class={cx(styles.content, local.class)} data-side={placementSide()} style={local.style}>
        {local.children}
      </K.Content>
    </K.Portal>
  );
}

export default Popover;
