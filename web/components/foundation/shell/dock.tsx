"use client";

/**
 * The account site's navigation: a floating dock at the bottom centre (from 640px) and, on phones, a compact bar that
 * opens the same sections in a bottom sheet. One highlight glides between sections on the morph spring while the
 * active section's label opens and the previous one closes, all on the same spring so they stay in step.
 *
 * Developer is another site (developer.teamofsilicons.com, from GET /v1/meta): a plain link that leaves the account
 * site (after the page's navigation guards), marked with an arrow, and never the active section.
 */
import Link from "next/link";
import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { animate, useReducedMotion, type AnimationPlaybackControls } from "motion/react";
import { ArrowUpRight, ChevronUp, Search, Settings } from "lucide-react";
import { BottomSheet } from "@/components/arc/bottom-sheet/bottom-sheet";
import SegmentedControl from "@/components/arc/segmented-control/segmented-control";
import { ThemeSwitch } from "@/components/arc/theme-switch/theme-switch";
import { Tooltip } from "@/components/arc/tooltip/tooltip";
import { UserMenu, type UserMenuUser } from "@/components/arc/user-menu/user-menu";
import { motionTokens } from "@/components/arc/lib/motion-tokens";
import { useTheme, type ThemePreference } from "@/components/foundation/theme/use-theme";
import { SECTIONS, sectionHref, type SectionKey } from "@/lib/navigation";
import { GUARDED_NAVIGATION } from "@/lib/navigation-guard";
import { useDeveloperUrl } from "@/lib/query/session";
import styles from "./dock.module.css";

export interface DockAccount extends UserMenuUser {
  kind: "carbon" | "silicon";
}

export interface DockProps {
  activeKey: SectionKey | undefined;
  /**
   * Navigates (inside a page transition, after asking the page's navigation guards; another site's address is a full
   * navigation). Called for unmodified primary clicks only, with the element focus should go back to when the Carbon
   * stays.
   */
  onNavigate: (href: string, returnFocus: HTMLElement | null) => void;
  account: DockAccount | null;
  /**
   * Signs out. A promise keeps the user menu open with the item's progress until it settles; nothing returned closes
   * the menu at once (the shell does that when a page will ask about unsaved work first, so the question is never
   * asked over the menu).
   */
  onSignOut: () => void | Promise<unknown>;
  onOpenSettings: () => void;
  onOpenPalette: () => void;
  isApple: boolean;
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

function FullDock({ activeKey, onNavigate, account, onSignOut, onOpenSettings, onOpenPalette, isApple }: DockProps) {
  const { theme, preference, change } = useTheme();
  const developerUrl = useDeveloperUrl();
  const reduced = useReducedMotion() ?? false;
  const listRef = useRef<HTMLUListElement>(null);
  const highlightRef = useRef<HTMLSpanElement>(null);
  const links = useRef<Array<HTMLAnchorElement | null>>([]);
  const clips = useRef<Array<HTMLSpanElement | null>>([]);
  const widths = useRef<number[]>(SECTIONS.map(() => 0));
  const box = useRef({ x: 0, w: 0, visible: false });
  const controls = useRef<AnimationPlaybackControls | null>(null);
  const lastIndex = useRef<number | null>(null);
  const activeIndex = SECTIONS.findIndex(section => section.key === activeKey);

  useLayoutEffect(() => {
    const natural = () => clips.current.map(clip => Math.ceil((clip?.firstElementChild as HTMLElement | null)?.scrollWidth ?? 0));
    const applyWidths = (next: number[]) => next.forEach((width, index) => {
      const clip = clips.current[index];
      if (clip) clip.style.width = `${Math.max(0, width)}px`;
    });
    const paint = (x: number, w: number, opacity: number) => {
      const highlight = highlightRef.current;
      if (!highlight) return;
      highlight.style.transform = `translateX(${x}px)`;
      highlight.style.width = `${Math.max(0, w)}px`;
      highlight.style.opacity = String(opacity);
    };
    /** Where the active item ends up once the labels have settled (measured synchronously, never painted). */
    const finalBox = (index: number, target: number[]) => {
      applyWidths(target);
      const link = links.current[index];
      const result = link ? { x: link.offsetLeft, w: link.offsetWidth } : { x: 0, w: 0 };
      applyWidths(widths.current);
      return result;
    };
    const go = (index: number, animated: boolean) => {
      const sizes = natural();
      const target = SECTIONS.map((_, i) => (i === index ? sizes[i] ?? 0 : 0));
      controls.current?.stop();
      if (index < 0) {
        applyWidths(target);
        widths.current = target;
        box.current = { ...box.current, visible: false };
        paint(box.current.x, box.current.w, 0);
        return;
      }
      const end = finalBox(index, target);
      if (!animated || !box.current.visible || reduced) {
        applyWidths(target);
        widths.current = target;
        box.current = { x: end.x, w: end.w, visible: true };
        paint(end.x, end.w, 1);
        return;
      }
      const fromWidths = widths.current.slice();
      const from = { ...box.current };
      controls.current = animate(0, 1, {
        ...motionTokens.spring.morph,
        onUpdate: progress => {
          widths.current = fromWidths.map((width, i) => lerp(width, target[i] ?? 0, progress));
          applyWidths(widths.current);
          box.current = { x: lerp(from.x, end.x, progress), w: lerp(from.w, end.w, progress), visible: true };
          paint(box.current.x, box.current.w, 1);
        },
        onComplete: () => {
          widths.current = target;
          applyWidths(target);
          box.current = { x: end.x, w: end.w, visible: true };
          paint(end.x, end.w, 1);
        },
      });
    };

    const animated = lastIndex.current !== null && lastIndex.current !== activeIndex;
    lastIndex.current = activeIndex;
    go(activeIndex, animated);

    // Late web fonts change label widths: settle in place without animating.
    const list = listRef.current;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (!controls.current || controls.current.state === "finished") go(activeIndex, false);
    });
    if (list) observer?.observe(list);
    let live = true;
    void document.fonts?.ready.then(() => {
      if (live && (!controls.current || controls.current.state === "finished")) go(activeIndex, false);
    });
    return () => {
      live = false;
      observer?.disconnect();
    };
  }, [activeIndex, reduced]);

  return (
    <nav data-sq="surface" data-vt="dock" className={styles.dock} aria-label="Account sections">
      <ul ref={listRef} className={styles.list} role="list">
        <span ref={highlightRef} data-sq="surface" className={styles.highlight} aria-hidden="true" />
        {SECTIONS.map((section, index) => {
          const current = section.key === activeKey;
          const Icon = section.icon;
          const href = sectionHref(section, developerUrl);
          const inner = (
            <>
              <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
              <span
                ref={node => {
                  clips.current[index] = node;
                }}
                className={styles.labelClip}
                aria-hidden="true"
              >
                <span className={styles.label}>{section.label}</span>
              </span>
            </>
          );
          const shared = {
            ref: (node: HTMLAnchorElement | null) => {
              links.current[index] = node;
            },
            href,
            "data-sq": "surface",
            className: styles.item,
            "aria-keyshortcuts": section.shortcut,
            [GUARDED_NAVIGATION]: "",
            onClick: (event: MouseEvent<HTMLAnchorElement>) => {
              if (!plainClick(event)) return;
              event.preventDefault();
              onNavigate(href, event.currentTarget);
            },
          };
          const link = section.external ? (
            // Another site: a plain link (a full navigation), named as the site it opens.
            <a {...shared} aria-label={`${section.label} site`} data-external="">{inner}</a>
          ) : (
            <Link {...shared} aria-current={current ? "page" : undefined} aria-label={section.label}>{inner}</Link>
          );
          const tip = section.external ? `${section.label} site ↗  ${section.shortcut}` : `${section.label}  ${section.shortcut}`;
          return <li key={section.key}>{current ? link : <Tooltip content={tip}>{link}</Tooltip>}</li>;
        })}
      </ul>
      <span className={styles.separator} aria-hidden="true" />
      <span className={styles.tool}>
        <ThemeSwitch theme={theme} variant="eclipse" iconOnly onThemeChange={(next, _variant, trigger) => change(next, trigger)} />
      </span>
      {account ? (
        <span className={styles.tool}>
          <UserMenu
            user={account}
            theme={preference}
            onThemeChange={(next: ThemePreference) => change(next, null)}
            onSignOut={onSignOut}
            align="end"
            items={[
              { label: "Settings", icon: <Settings size={16} strokeWidth={1.75} />, onSelect: onOpenSettings },
              { label: "Search and jump", icon: <Search size={16} strokeWidth={1.75} />, keys: isApple ? ["⌘", "K"] : ["Ctrl", "K"], onSelect: onOpenPalette },
            ]}
          />
        </span>
      ) : null}
    </nav>
  );
}

const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Device" },
];

function CompactDock({ activeKey, onNavigate, account, onSignOut, onOpenSettings, onOpenPalette }: DockProps) {
  const { preference, change } = useTheme();
  const developerUrl = useDeveloperUrl();
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const active = SECTIONS.find(section => section.key === activeKey);
  const ActiveIcon = active?.icon ?? Search;
  return (
    <div data-sq="surface" data-vt="dock" className={styles.compact}>
      <BottomSheet
        open={open}
        onOpenChange={setOpen}
        title="Go to"
        detents={[0.62, 0.92]}
        trigger={
          <button ref={menuButton} data-sq="surface" type="button" className={styles.menuButton} aria-haspopup="dialog" aria-expanded={open}>
            <ActiveIcon size={18} strokeWidth={1.75} aria-hidden="true" />
            <span className={styles.menuLabel}>{active?.label ?? "Menu"}</span>
            <ChevronUp className={styles.menuChevron} size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        }
      >
        <ul className={styles.sheetList} role="list">
          {SECTIONS.map(section => {
            const Icon = section.icon;
            const href = sectionHref(section, developerUrl);
            const shared = {
              href,
              "data-sq": "surface",
              className: styles.sheetItem,
              [GUARDED_NAVIGATION]: "",
              onClick: (event: MouseEvent<HTMLAnchorElement>) => {
                if (!plainClick(event)) return;
                event.preventDefault();
                // The sheet closes first, so a question about unsaved work is never asked over it; staying puts
                // focus back on the button that opened it.
                setOpen(false);
                onNavigate(href, menuButton.current);
              },
            };
            const inner = (
              <>
                <span className={styles.sheetIcon} aria-hidden="true"><Icon size={20} strokeWidth={1.75} /></span>
                <span className={styles.sheetText}>
                  <span className={styles.sheetLabel}>
                    {section.external ? `${section.label} site` : section.label}
                    {section.external ? <ArrowUpRight className={styles.externalMark} size={14} strokeWidth={1.75} aria-hidden="true" /> : null}
                  </span>
                  <span className={styles.sheetDescription}>{section.description}</span>
                </span>
              </>
            );
            return (
              <li key={section.key}>
                {section.external ? (
                  <a {...shared} data-external="">{inner}</a>
                ) : (
                  <Link {...shared} aria-current={section.key === activeKey ? "page" : undefined}>{inner}</Link>
                )}
              </li>
            );
          })}
        </ul>
        <div className={styles.sheetFooter}>
          <SegmentedControl label="Theme" options={themeOptions} value={preference} onValueChange={value => change(value as ThemePreference, null)} />
          <button data-sq="surface" type="button" className={styles.iconButton} aria-label="Settings" onClick={() => { setOpen(false); onOpenSettings(); }}>
            <Settings size={20} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </BottomSheet>
      <button data-sq="surface" type="button" className={styles.iconButton} aria-label="Search and jump" onClick={onOpenPalette}>
        <Search size={20} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {account ? (
        <UserMenu
          user={account}
          theme={preference}
          onThemeChange={(next: ThemePreference) => change(next, null)}
          onSignOut={onSignOut}
          items={[{ label: "Settings", icon: <Settings size={16} strokeWidth={1.75} />, onSelect: onOpenSettings }]}
        />
      ) : null}
    </div>
  );
}
