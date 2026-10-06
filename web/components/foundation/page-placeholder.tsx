/**
 * A calm stand-in for a page whose area is still being built: the real header plus a note on what will live here.
 * Page builders replace their placeholder; nothing else imports this.
 */
import type { ReactNode } from "react";
import { CircleDashed } from "lucide-react";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { Page, PageHeader, Surface } from "@/components/foundation/layout/layout";

export interface PagePlaceholderProps {
  title: string;
  description: string;
  /** What this page will hold, one sentence. */
  note: string;
  actions?: ReactNode;
  back?: { href: string; label: string };
  children?: ReactNode;
  width?: "narrow" | "reading" | "default";
}

export function PagePlaceholder({ title, description, note, actions, back, children, width = "reading" }: PagePlaceholderProps) {
  return (
    <Page width={width}>
      <PageHeader title={title} description={description} actions={actions} back={back} />
      {children}
      <Surface padding="none">
        <EmptyState icon={<CircleDashed width={24} height={24} strokeWidth={1.5} />} title="Coming together" description={note} />
      </Surface>
    </Page>
  );
}
