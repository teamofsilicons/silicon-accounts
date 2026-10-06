/**
 * Layout primitives for account and developer pages:
 *   <Page>            the one page container (gutters, max width, room for the dock)
 *   <PageHeader>      the page's h1 in the display serif, a line of context, actions
 *   <Section>         a titled region (h2) with an optional description and actions
 *   <Stack>/<Cluster>/<Grid>   spacing on the 4px grid
 *   <Surface>         a bordered squircle region (never nest them)
 *   <SettingsGroup>/<SettingsRow>   one bordered group of divided rows (label + description, control on the right)
 *   <DescriptionList>/<DescriptionItem>   label and value pairs
 */
import { A } from "@solidjs/router";
import { ArrowLeft } from "lucide-solid";
import { Show, createUniqueId, splitProps, type JSX } from "solid-js";
import { cx } from "../../arc/lib/cx";
import { useSquircle } from "../../arc/lib/squircle";
import styles from "./layout.module.css";

type Gap = 1 | 2 | 3 | 4 | 5 | 6 | 8 | 10 | 12;
const gap = (value: Gap | undefined, fallback: Gap) => `var(--space-${value ?? fallback})`;

export interface PageProps {
  /** "narrow" (forms, settings), "reading" (lists), "default" (dashboards and grids). */
  width?: "narrow" | "reading" | "default";
  class?: string;
  children: JSX.Element;
  /** Accessible label when the page has no PageHeader. */
  label?: string;
}

/** The page container. One per page; the shell provides the landmark (<main>). */
export function Page(props: PageProps) {
  return (
    <div class={cx(styles.page, props.class)} data-width={props.width ?? "default"} aria-label={props.label}>
      {props.children}
    </div>
  );
}

export interface PageHeaderProps {
  title: JSX.Element;
  /** One line of context. Skip it when the content explains itself. */
  description?: JSX.Element;
  /** Actions at the end (one primary at most). */
  actions?: JSX.Element;
  /** A back link above the title (for nested pages such as an app's detail). */
  back?: { href: string; label: string };
  class?: string;
  children?: JSX.Element;
}

export function PageHeader(props: PageHeaderProps) {
  return (
    <header class={cx(styles.header, props.class)}>
      <div class={styles.headerText}>
        <Show when={props.back}>
          {back => <A href={back().href} class={styles.back}><ArrowLeft size={16} stroke-width={1.75} aria-hidden="true" />{back().label}</A>}
        </Show>
        <h1 class={styles.title}>{props.title}</h1>
        <Show when={props.description}><p class={styles.description}>{props.description}</p></Show>
        {props.children}
      </div>
      <Show when={props.actions}><div class={styles.actions}>{props.actions}</div></Show>
    </header>
  );
}

export interface SectionProps extends Omit<JSX.HTMLAttributes<HTMLElement>, "title"> {
  title: JSX.Element;
  description?: JSX.Element;
  actions?: JSX.Element;
  /** Hide the heading visually (it still names the region). */
  hideTitle?: boolean;
  /** Heading level, h2 by default. */
  level?: 2 | 3;
}

export function Section(props: SectionProps) {
  const [local, rest] = splitProps(props, ["title", "description", "actions", "hideTitle", "level", "class", "children"]);
  const id = `section-${createUniqueId()}`;
  return (
    <section {...rest} class={cx(styles.section, local.class)} aria-labelledby={id}>
      <div class={cx(styles.sectionHeader, local.hideTitle && "sr-only")}>
        <div class={styles.sectionText}>
          <Show when={(local.level ?? 2) === 3} fallback={<h2 id={id} class={styles.sectionTitle}>{local.title}</h2>}>
            <h3 id={id} class={styles.sectionTitle}>{local.title}</h3>
          </Show>
          <Show when={local.description}><p class={styles.sectionDescription}>{local.description}</p></Show>
        </div>
        <Show when={local.actions}><div class={styles.actions}>{local.actions}</div></Show>
      </div>
      {local.children}
    </section>
  );
}

export function Stack(props: { gap?: Gap; class?: string; children: JSX.Element; as?: "div" | "ul" | "ol" }) {
  return <div class={cx(styles.stack, props.class)} style={{ gap: gap(props.gap, 4) }}>{props.children}</div>;
}

export function Cluster(props: { gap?: Gap; class?: string; children: JSX.Element; justify?: "start" | "end" | "between" | "center" }) {
  const justify = { start: "flex-start", end: "flex-end", between: "space-between", center: "center" }[props.justify ?? "start"];
  return <div class={cx(styles.cluster, props.class)} style={{ gap: gap(props.gap, 3), "justify-content": justify }}>{props.children}</div>;
}

/** A responsive grid: as many columns as fit at `min` px each. */
export function Grid(props: { gap?: Gap; min?: number; class?: string; children: JSX.Element }) {
  return <div class={cx(styles.grid, props.class)} style={{ gap: gap(props.gap, 4), "--grid-min": `${props.min ?? 260}px` }}>{props.children}</div>;
}

export interface SurfaceProps extends JSX.HTMLAttributes<HTMLDivElement> {
  padding?: "none" | "sm" | "md";
}

/** A bordered squircle region. Cards rest on a border, never a shadow (Arc). */
export function Surface(props: SurfaceProps) {
  const [local, rest] = splitProps(props, ["padding", "class", "children"]);
  return <div {...rest} ref={el => useSquircle(el)} class={cx(styles.surface, local.class)} data-padding={local.padding ?? "md"}>{local.children}</div>;
}

export function SettingsGroup(props: { class?: string; children: JSX.Element; label?: string }) {
  return <div ref={el => useSquircle(el)} class={cx(styles.group, props.class)} role={props.label ? "group" : undefined} aria-label={props.label}>{props.children}</div>;
}

export interface SettingsRowProps {
  label: JSX.Element;
  description?: JSX.Element;
  /** The control (switch, button, select). Give it aria-labelledby={labelId} via the render function. */
  children?: JSX.Element | ((ids: { labelId: string; descriptionId: string }) => JSX.Element);
  class?: string;
}

/** One row of a settings group. The render-function child receives ids to wire aria-labelledby/-describedby. */
export function SettingsRow(props: SettingsRowProps) {
  const uid = createUniqueId();
  const ids = { labelId: `row-${uid}-label`, descriptionId: `row-${uid}-description` };
  const control = () => (typeof props.children === "function" ? props.children(ids) : props.children);
  return (
    <div class={cx(styles.row, props.class)}>
      <div class={styles.rowText}>
        <span id={ids.labelId} class={styles.rowLabel}>{props.label}</span>
        <Show when={props.description}><span id={ids.descriptionId} class={styles.rowDescription}>{props.description}</span></Show>
      </div>
      <Show when={props.children}><div class={styles.rowControl}>{control()}</div></Show>
    </div>
  );
}

export function DescriptionList(props: { class?: string; children: JSX.Element }) {
  return <dl class={cx(styles.list, props.class)}>{props.children}</dl>;
}

export function DescriptionItem(props: { label: JSX.Element; children: JSX.Element }) {
  return (
    <div class={styles.item}>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}
