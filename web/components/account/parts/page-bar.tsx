"use client";

/**
 * The bar at the top of an account page (Anil, 2026-11-07, an experiment): a link back to the parent on nested pages (a page in
 * the sidebar has none, so the bar is one line shorter), the page's title on the line under it, and the page's supporting buttons on the title's right, pinned to the top of the panel with a line under it.
 * The current page is the title, so its crumb is hidden: Silicon UI's Breadcrumb always ends on the current page and wouldn't
 * link a lone parent. The title is the page's h1 role, as on every page.
 */
import type { ReactNode } from "react";
import { Breadcrumb } from "@teamofsilicons/silicon-ui/breadcrumb";
import styles from "./page-bar.module.css";

export function PageBar({ parent, title, actions }: { parent?: { label: string; href: string }; title: string; actions?: ReactNode }) {
  return (
    <div className={styles.bar}>
      {parent ? <Breadcrumb items={[parent, { label: title }]} /> : null}
      <div className={styles.row}>
        <h1 className={styles.title}>{title}</h1>
        {actions}
      </div>
    </div>
  );
}
