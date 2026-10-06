/**
 * A calm stand-in for a page whose area is still being built: the real header plus a note on what will live here.
 * Page builders replace their placeholder file; nothing else imports this.
 */
import type { JSX } from "solid-js";
import { CircleDashed } from "lucide-solid";
import { EmptyState } from "../arc/empty-state/empty-state";
import { Page, PageHeader, Surface } from "./layout/layout";

export interface PagePlaceholderProps {
  title: string;
  description: string;
  /** What this page will hold, one sentence. */
  note: string;
  actions?: JSX.Element;
  back?: { href: string; label: string };
  children?: JSX.Element;
  width?: "narrow" | "reading" | "default";
}

export function PagePlaceholder(props: PagePlaceholderProps) {
  return (
    <Page width={props.width ?? "reading"}>
      <PageHeader title={props.title} description={props.description} actions={props.actions} back={props.back} />
      {props.children}
      <Surface padding="none">
        <EmptyState icon={<CircleDashed width={24} height={24} stroke-width={1.5} />} title="Coming together" description={props.note} />
      </Surface>
    </Page>
  );
}
