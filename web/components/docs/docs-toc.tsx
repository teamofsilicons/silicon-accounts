"use client";

/**
 * "On this page": the page's h2 and h3 headings. On wide screens it is a rail beside the article that marks the
 * section being read (the last heading above the top fifth of the window) and keeps that entry in view; below
 * 1280 px the same list is a disclosure at the top of the article.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, ChevronDown } from "lucide-react";
import type { TocItem } from "@/lib/docs/types";
import styles from "./docs-toc.module.css";

function useActiveHeading(items: TocItem[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!items.length) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = Math.min(window.innerHeight * 0.2, 180) + 64;
      let current: string | null = null;
      for (const item of items) {
        const heading = document.getElementById(item.id);
        if (!heading) continue;
        if (heading.getBoundingClientRect().top <= line) current = item.id;
        else break;
      }
      // At the very bottom the last section counts as read, even when it is too short to reach the line.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = items[items.length - 1]!.id;
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("hashchange", schedule);
    };
  }, [items]);
  return active;
}

function TocList({ items, active, onPick }: { items: TocItem[]; active: string | null; onPick?: () => void }) {
  return (
    <ol className={styles.list} role="list">
      {items.map(item => (
        <li key={item.id} data-depth={item.depth}>
          <a href={`#${item.id}`} className={styles.link} aria-current={active === item.id ? "location" : undefined} onClick={onPick}>
            {item.text}
          </a>
        </li>
      ))}
    </ol>
  );
}

/** The rail beside the article (1280 px and wider). */
export function DocsTocRail({ items, children }: { items: TocItem[]; children?: ReactNode }) {
  const active = useActiveHeading(items);
  const scroller = useRef<HTMLDivElement>(null);

  // Keep the marked entry inside the rail's own scroll area on long pages.
  useEffect(() => {
    const box = scroller.current;
    const link = active ? box?.querySelector<HTMLElement>(`a[href="#${CSS.escape(active)}"]`) : null;
    if (!box || !link) return;
    const top = link.offsetTop - box.offsetTop;
    if (top < box.scrollTop + 24 || top > box.scrollTop + box.clientHeight - 48) box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3) });
  }, [active]);

  return (
    <nav className={styles.rail} aria-label="On this page">
      {items.length ? (
        <>
          <p className={styles.title}>On this page</p>
          <div ref={scroller} className={styles.scroller}>
            <TocList items={items} active={active} />
          </div>
        </>
      ) : null}
      <div className={styles.extras}>
        {children}
        <a href="#top" className={styles.extra} onClick={event => {
          event.preventDefault();
          window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
          history.replaceState(null, "", window.location.pathname + window.location.search);
        }}>
          <ArrowUp size={14} strokeWidth={1.75} aria-hidden="true" />
          Back to top
        </a>
      </div>
    </nav>
  );
}

/** The disclosure at the top of the article (narrower than 1280 px). */
export function DocsTocDisclosure({ items }: { items: TocItem[] }) {
  const [open, setOpen] = useState(false);
  const active = useActiveHeading(items);
  if (items.length < 2) return null;
  const current = items.find(item => item.id === active);
  return (
    <nav className={styles.disclosure} data-sq="surface" data-open={open ? "" : undefined} aria-label="On this page">
      <button type="button" className={styles.summary} aria-expanded={open} onClick={() => setOpen(value => !value)}>
        <span className={styles.summaryText}>
          <span>On this page</span>
          {current ? <span className={styles.summaryCurrent}>{current.text}</span> : null}
        </span>
        <ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" className={styles.chevron} />
      </button>
      {open ? (
        <div className={styles.disclosureBody}>
          <TocList items={items} active={active} onPick={() => setOpen(false)} />
        </div>
      ) : null}
    </nav>
  );
}
