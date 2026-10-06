import { For, Show, createEffect, createSignal, on } from "solid-js";
import { Avatar } from "../avatar/avatar";
import { Swap } from "../lib/presence";
import { animate, motionTokens, prefersReducedMotion, tween } from "../lib/motion";
import { useSquircle } from "../lib/squircle";
import styles from "./avatar-group.module.css";

export interface AvatarGroupMember {
  name: string;
  src?: string | null;
  status?: "online" | "offline";
  kind?: "carbon" | "silicon";
}

export interface AvatarGroupProps {
  members: AvatarGroupMember[];
  max?: number;
  size?: "sm" | "md" | "lg";
  /** Accessible name for the group, for example "Silicons in your care". */
  label?: string;
}

/**
 * Arc AvatarGroup: an overlapping stack that loosens on hover; the person under the pointer lifts and names
 * themselves. The overflow count rolls the way it moved.
 */
export function AvatarGroup(props: AvatarGroupProps) {
  const visible = () => props.members.slice(0, Math.max(0, props.max ?? 4));
  const overflow = () => Math.max(0, props.members.length - visible().length);
  const [direction, setDirection] = createSignal(1);
  createEffect(on(overflow, (next, previous) => { if (previous !== undefined) setDirection(next < previous ? -1 : 1); }));
  const label = () => props.label ?? "Accounts";
  return (
    <div class={[styles.group, styles[props.size ?? "md"]].join(" ")} role="group" aria-label={label()} style={{ "--count": String(visible().length + (overflow() > 0 ? 1 : 0)) }}>
      <For each={visible()}>
        {(member, index) => (
          <span class={styles.slot} style={{ "--index": String(index()) }}>
            <span class={styles.lift}>
              <Avatar class={styles.avatar} name={member.name} src={member.src} status={member.status} kind={member.kind} size={props.size ?? "md"} />
              <span class={styles.tip} aria-hidden="true">{member.name}</span>
            </span>
          </span>
        )}
      </For>
      <Show when={overflow() > 0}>
        <span class={styles.slot} style={{ "--index": String(visible().length) }}>
          <span ref={el => useSquircle(el)} class={[styles.lift, styles.overflow, styles[props.size ?? "md"]].join(" ")} role="img" aria-label={`${overflow()} more`}>
            <Swap
              value={overflow()}
              class={styles.count}
              enter={el => prefersReducedMotion()
                ? animate(el, { opacity: [0, 1] }, tween(motionTokens.duration.instant))
                : animate(el, { opacity: [0, 1], y: [`${0.4 * direction()}em`, "0em"], filter: ["blur(2px)", "blur(0px)"] }, tween(motionTokens.duration.standard, motionTokens.ease.enter))}
              exit={el => prefersReducedMotion()
                ? animate(el, { opacity: 0 }, tween(0))
                : animate(el, { opacity: 0, y: `${-0.4 * direction()}em`, filter: "blur(2px)" }, tween(motionTokens.duration.fast))}
            >
              {count => <span aria-hidden="true">+{count}</span>}
            </Swap>
          </span>
        </span>
      </Show>
    </div>
  );
}

export default AvatarGroup;
