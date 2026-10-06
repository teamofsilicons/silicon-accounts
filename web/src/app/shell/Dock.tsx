/**
 * The account site's navigation: a floating dock at the bottom centre (from 640px) and, on phones, a compact bar that
 * opens the same sections in a bottom sheet. One highlight glides between sections on the morph spring while the
 * active section's label opens and the previous one closes, all on the same spring so they stay in step.
 */
import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { ChevronUp, Search, Settings } from "lucide-solid";
import { BottomSheet } from "../../arc/bottom-sheet/bottom-sheet";
import { SegmentedControl } from "../../arc/segmented-control/segmented-control";
import { ThemeSwitch } from "../../arc/theme-switch/theme-switch";
import { Tooltip } from "../../arc/tooltip/tooltip";
import { UserMenu, type ThemePreference, type UserMenuAccount } from "../../arc/user-menu/user-menu";
import { animate, prefersReducedMotion, spring, type AnimationControls } from "../../arc/lib/motion";
import { isApplePlatform } from "../../arc/lib/dom";
import { useSquircle } from "../../arc/lib/squircle";
import { theme } from "../../theme/theme";
import { SECTIONS, type Section } from "../navigation";
import styles from "./dock.module.css";

export interface DockProps {
  activeKey: Section["key"] | undefined;
  /** Navigates (inside a page transition). Called for unmodified primary clicks only. */
  onNavigate: (href: string) => void;
  account: UserMenuAccount | null;
  themePreference: ThemePreference;
  onThemeChange: (preference: ThemePreference, trigger: HTMLElement | null) => void;
  onSignOut: () => Promise<unknown>;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
}

const lerp = (from: number, to: number, progress: number) => from + (to - from) * progress;
const plainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented;

export function Dock(props: DockProps) {
  return (
    <>
      <FullDock {...props} />
      <CompactDock {...props} />
    </>
  );
}

function FullDock(props: DockProps) {
  let list: HTMLUListElement | undefined;
  let highlight: HTMLSpanElement | undefined;
  const links: HTMLAnchorElement[] = [];
  const clips: HTMLSpanElement[] = [];
  const natural: number[] = [];
  let widths: number[] = SECTIONS.map(() => 0);
  let box = { x: 0, w: 0, visible: false };
  let controls: AnimationControls | undefined;
  const activeIndex = () => SECTIONS.findIndex(section => section.key === props.activeKey);

  const measureNatural = () => {
    clips.forEach((clip, index) => {
      const label = clip.firstElementChild as HTMLElement | null;
      natural[index] = label ? Math.ceil(label.scrollWidth) : 0;
    });
  };
  const applyWidths = (next: number[]) => {
    next.forEach((width, index) => {
      const clip = clips[index];
      if (clip) clip.style.width = `${Math.max(0, width)}px`;
    });
  };
  const paintHighlight = (x: number, w: number, opacity: number) => {
    if (!highlight) return;
    highlight.style.transform = `translateX(${x}px)`;
    highlight.style.width = `${Math.max(0, w)}px`;
    highlight.style.opacity = String(opacity);
  };
  /** Where the active item ends up once the labels have settled (measured synchronously, never painted). */
  const finalBox = (index: number, target: number[]) => {
    applyWidths(target);
    const link = links[index];
    const result = link ? { x: link.offsetLeft, w: link.offsetWidth } : { x: 0, w: 0 };
    applyWidths(widths);
    return result;
  };
  const go = (index: number, animated: boolean) => {
    measureNatural();
    const target = SECTIONS.map((_, i) => (i === index ? natural[i] ?? 0 : 0));
    controls?.stop();
    if (index < 0) {
      applyWidths(target);
      widths = target;
      box = { ...box, visible: false };
      paintHighlight(box.x, box.w, 0);
      return;
    }
    const end = finalBox(index, target);
    if (!animated || !box.visible || prefersReducedMotion()) {
      applyWidths(target);
      widths = target;
      box = { x: end.x, w: end.w, visible: true };
      paintHighlight(end.x, end.w, 1);
      return;
    }
    const fromWidths = widths.slice();
    const from = { ...box };
    controls = animate(0, 1, {
      ...spring.morph,
      onUpdate: progress => {
        widths = fromWidths.map((width, i) => lerp(width, target[i] ?? 0, progress));
        applyWidths(widths);
        box = { x: lerp(from.x, end.x, progress), w: lerp(from.w, end.w, progress), visible: true };
        paintHighlight(box.x, box.w, 1);
      },
      onComplete: () => {
        widths = target;
        applyWidths(target);
        box = { x: end.x, w: end.w, visible: true };
        paintHighlight(end.x, end.w, 1);
      },
    });
  };

  createEffect(on(activeIndex, (index, previous) => go(index, previous !== undefined)));
  onMount(() => {
    if (!list) return;
    // Late web fonts change label widths: settle in place without animating.
    const observer = new ResizeObserver(() => { if (!controls || controls.state === "finished") go(activeIndex(), false); });
    observer.observe(list);
    void document.fonts?.ready.then(() => go(activeIndex(), false));
    onCleanup(() => { observer.disconnect(); controls?.stop(); });
  });

  return (
    <nav ref={el => useSquircle(el)} class={styles.dock} aria-label="Account sections" data-vt="dock">
      <ul ref={list} class={styles.list} role="list">
        <span ref={el => { highlight = el; useSquircle(el); }} class={styles.highlight} aria-hidden="true" />
        <For each={SECTIONS}>
          {(section, index) => (
            <li>
              <Tooltip content={`${section.label}  ${section.shortcut}`} placement="top" disabled={section.key === props.activeKey}>
                {triggerProps => (
                  <a
                    {...triggerProps}
                    ref={el => {
                      (triggerProps as { ref?: (el: HTMLElement) => void }).ref?.(el);
                      links[index()] = el;
                    }}
                    href={section.href}
                    class={styles.item}
                    aria-current={section.key === props.activeKey ? "page" : undefined}
                    aria-label={section.label}
                    aria-keyshortcuts={section.shortcut}
                    onClick={event => {
                      if (!plainClick(event)) return;
                      event.preventDefault();
                      props.onNavigate(section.href);
                    }}
                  >
                    <section.icon size={20} stroke-width={1.75} aria-hidden="true" />
                    <span ref={el => (clips[index()] = el)} class={styles.labelClip} aria-hidden="true"><span class={styles.label}>{section.label}</span></span>
                  </a>
                )}
              </Tooltip>
            </li>
          )}
        </For>
      </ul>
      <span class={styles.separator} aria-hidden="true" />
      <span class={styles.tool}>
        <ThemeSwitch theme={theme()} iconOnly class={styles.themeButton} onThemeChange={(next, trigger) => props.onThemeChange(next, trigger)} />
      </span>
      <Show when={props.account}>
        {account => (
          <span class={styles.tool}>
            <UserMenu
              account={account()}
              theme={props.themePreference}
              onThemeChange={(next, trigger) => props.onThemeChange(next, trigger)}
              onSignOut={props.onSignOut}
              side="top"
              align="end"
              items={[
                { label: "Settings", icon: <Settings size={16} stroke-width={1.75} />, onSelect: props.onOpenSettings },
                { label: "Search and jump", icon: <Search size={16} stroke-width={1.75} />, keys: isApplePlatform() ? ["⌘", "K"] : ["Ctrl ", "K"], onSelect: props.onOpenPalette },
              ]}
            />
          </span>
        )}
      </Show>
    </nav>
  );
}

const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Device" },
];

function CompactDock(props: DockProps) {
  const [open, setOpen] = createSignal(false);
  const active = () => SECTIONS.find(section => section.key === props.activeKey);
  return (
    <div ref={el => useSquircle(el)} class={styles.compact} data-vt="dock-compact">
      <BottomSheet
        open={open()}
        onOpenChange={setOpen}
        title="Go to"
        hideTitle
        detents={[0.62, 0.92]}
        trigger={
          <button ref={el => useSquircle(el)} type="button" class={styles.menuButton} aria-haspopup="dialog" aria-expanded={open()} onClick={() => setOpen(true)}>
            <Show when={active()} fallback={<Search size={18} stroke-width={1.75} aria-hidden="true" />}>
              {section => {
                const Icon = section().icon;
                return <Icon size={18} stroke-width={1.75} aria-hidden="true" />;
              }}
            </Show>
            <span class={styles.menuLabel}>{active()?.label ?? "Menu"}</span>
            <ChevronUp class={styles.menuChevron} size={16} stroke-width={1.75} aria-hidden="true" />
          </button>
        }
      >
        <ul class={styles.sheetList} role="list">
          <For each={SECTIONS}>
            {section => (
              <li>
                <a
                  href={section.href}
                  class={styles.sheetItem}
                  aria-current={section.key === props.activeKey ? "page" : undefined}
                  onClick={event => {
                    if (!plainClick(event)) return;
                    event.preventDefault();
                    setOpen(false);
                    props.onNavigate(section.href);
                  }}
                >
                  <span class={styles.sheetIcon} aria-hidden="true"><section.icon size={20} stroke-width={1.75} /></span>
                  <span class={styles.sheetText}>
                    <span class={styles.sheetLabel}>{section.label}</span>
                    <span class={styles.sheetDescription}>{section.description}</span>
                  </span>
                </a>
              </li>
            )}
          </For>
        </ul>
        <div class={styles.sheetFooter}>
          <SegmentedControl label="Theme" options={themeOptions} value={props.themePreference} onValueChange={value => props.onThemeChange(value, null)} size="sm" />
          <button type="button" class={styles.iconButton} aria-label="Settings" onClick={() => { setOpen(false); props.onOpenSettings(); }}>
            <Settings size={20} stroke-width={1.75} aria-hidden="true" />
          </button>
        </div>
      </BottomSheet>
      <button ref={el => useSquircle(el)} type="button" class={styles.iconButton} aria-label="Search and jump" onClick={props.onOpenPalette}>
        <Search size={20} stroke-width={1.75} aria-hidden="true" />
      </button>
      <Show when={props.account}>
        {account => (
          <UserMenu
            account={account()}
            theme={props.themePreference}
            onThemeChange={(next, trigger) => props.onThemeChange(next, trigger)}
            onSignOut={props.onSignOut}
            items={[{ label: "Settings", icon: <Settings size={16} stroke-width={1.75} />, onSelect: props.onOpenSettings }]}
          />
        )}
      </Show>
    </div>
  );
}
