"use client";

/**
 * The public pages' one behaviour island. The pages are server-rendered HTML that works without script; this adds the
 * small things that need it, by delegation over the markup, so no part of the page has to hydrate:
 *
 * - copy buttons ([data-copy]): copy the block's code (or data-copy-value) and confirm for a moment;
 * - "Show all N lines" ([data-code-expand]): open a long code block in place;
 * - "On this page" ([data-toc]): mark the section being read (the last heading above the top fifth of the window);
 * - the docs sidebar ([data-docs-sidebar]): keep the current page in view inside its own scroll area;
 * - the menu (#site-menu): close it when one of its links only moves within this page.
 *
 * It renders one visually hidden status line, so a copy is announced to screen readers.
 */
import { useEffect, useState } from "react";

const COPIED_MS = 1600;

function copyText(button: HTMLElement): string {
  const value = button.getAttribute("data-copy-value");
  if (value !== null) return value;
  return button.closest("[data-docs-code]")?.querySelector("pre")?.textContent ?? "";
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function useScrollSpy() {
  useEffect(() => {
    const navs = [...document.querySelectorAll<HTMLElement>("[data-toc]")];
    const links = navs.flatMap(nav => [...nav.querySelectorAll<HTMLAnchorElement>("a[href^='#']")]).filter(link => link.getAttribute("href") !== "#top");
    const ids = [...new Set(links.map(link => decodeURIComponent(link.getAttribute("href")!.slice(1))))];
    if (!ids.length) return;
    let frame = 0;
    let last: string | null = null;
    const measure = () => {
      frame = 0;
      const line = Math.min(window.innerHeight * 0.2, 180) + 64;
      let current: string | null = null;
      for (const id of ids) {
        const heading = document.getElementById(id);
        if (!heading) continue;
        if (heading.getBoundingClientRect().top <= line) current = id;
        else break;
      }
      // At the very bottom the last section counts as read, even when it is too short to reach the line.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = ids[ids.length - 1]!;
      if (current === last) return;
      last = current;
      for (const link of links) {
        if (current && link.getAttribute("href") === `#${current}`) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      }
      // Keep the marked entry inside the rail's own scroll area on long pages.
      const box = document.querySelector<HTMLElement>("[data-toc-scroller]");
      const marked = box?.querySelector<HTMLElement>("[aria-current='location']");
      if (box && marked) {
        const top = marked.offsetTop - box.offsetTop;
        if (top < box.scrollTop + 24 || top > box.scrollTop + box.clientHeight - 48) box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3) });
      }
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
  }, []);
}

export function Enhancer() {
  const [status, setStatus] = useState("");
  useScrollSpy();

  // Keep the current page in view inside the scrolling sidebar (long Reference lists), never moving the page.
  useEffect(() => {
    const sidebar = document.querySelector<HTMLElement>("[data-docs-sidebar]");
    const active = sidebar?.querySelector<HTMLElement>("[aria-current='page']");
    if (!sidebar || !active) return;
    const top = active.getBoundingClientRect().top - sidebar.getBoundingClientRect().top + sidebar.scrollTop;
    if (top < sidebar.scrollTop + 48 || top > sidebar.scrollTop + sidebar.clientHeight - 96) sidebar.scrollTop = Math.max(0, top - sidebar.clientHeight / 3);
  }, []);

  useEffect(() => {
    const timers = new Map<HTMLElement, number>();
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const copy = target.closest<HTMLElement>("[data-copy]");
      if (copy) {
        const label = copy.getAttribute("data-label") ?? "Copy";
        writeClipboard(copyText(copy)).then(
          () => {
            copy.setAttribute("data-state", "copied");
            copy.setAttribute("aria-label", "Copied");
            setStatus("Copied to the clipboard");
          },
          () => setStatus("Could not copy: the browser refused access to the clipboard"),
        );
        window.clearTimeout(timers.get(copy));
        timers.set(copy, window.setTimeout(() => {
          copy.setAttribute("data-state", "idle");
          copy.setAttribute("aria-label", label);
          setStatus("");
        }, COPIED_MS));
        return;
      }

      const expand = target.closest<HTMLElement>("[data-code-expand]");
      if (expand) {
        const block = expand.closest<HTMLElement>("[data-docs-code]");
        const open = expand.getAttribute("aria-expanded") !== "true";
        expand.setAttribute("aria-expanded", String(open));
        const text = expand.querySelector("[data-expand-label]");
        if (text) text.textContent = open ? expand.getAttribute("data-less") : expand.getAttribute("data-more");
        if (block) {
          if (open) block.setAttribute("data-open", "");
          else {
            block.removeAttribute("data-open");
            // Collapsing a block taller than the screen keeps its header in view.
            if (block.getBoundingClientRect().top < 0) block.scrollIntoView({ block: "start" });
          }
        }
        return;
      }

      // A menu link that only moves within this page leaves the page under the open menu: close it.
      const link = target.closest<HTMLAnchorElement>("#site-menu a[href]");
      if (link && link.pathname === window.location.pathname && link.hash) {
        const menu = document.getElementById("site-menu") as (HTMLElement & { hidePopover?: () => void }) | null;
        menu?.hidePopover?.();
      }
    };
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, []);

  return <span className="sr-only" role="status" aria-live="polite">{status}</span>;
}
