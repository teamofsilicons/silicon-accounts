"use client";

/**
 * Details: what the app asks Carbons to share, besides the name, id and profile photo every app gets. Ticking a detail
 * asks for it as REQUIRED (UNDERSTANDING: "When an app picks a detail it's required by default"); the developer can
 * switch it to optional. On the hosted pages a required detail is always shared (and a missing email or phone is added,
 * with a code, before continuing); an optional one is a checkbox the Carbon ticks or leaves unticked.
 *
 * The details and the flow are one save group (lib/config.ts): ticking a detail adds it to the flow's last page,
 * unticking takes it off its page, so the Flows tab always holds exactly what is asked.
 */
import { useState } from "react";
import { ArrowRight, History, Lock } from "lucide-react";
import { Badge } from "@/components/silicon-ui/badge/badge";
import { Button } from "@/components/silicon-ui/button/button";
import { Checkbox } from "@/components/silicon-ui/checkbox/checkbox";
import SegmentedControl from "@/components/silicon-ui/segmented-control/segmented-control";
import { Section } from "@/components/foundation/layout/layout";
import { useTheme } from "@/components/foundation/theme/use-theme";
import type { ContactField } from "@/lib/api/types";
import { resolveBrandTheme } from "@/lib/branding/apply";
import { FIELD_LABELS } from "@/lib/format";
import { CONTACT_FIELDS, requestedFields } from "../lib/config";
import { hostOfUrl, useDeveloperApp } from "../lib/context";
import { messageFor, useEditor } from "../lib/editor";
import { EditorAlerts } from "../parts/editor-alerts";
import { HistoryDrawer } from "../parts/history-drawer";
import { SaveBar } from "../parts/save-bar";
import { HostedPreview, effectiveSteps } from "./hosted-preview";
import styles from "./details.module.css";

const DESCRIPTIONS: Record<ContactField, { what: string; required: string; optional: string }> = {
  email: {
    what: "The Carbon's primary email address, verified.",
    required: "A Carbon without one adds one, with a 6 digit code, before continuing.",
    optional: "Shared only if the Carbon ticks it.",
  },
  phone: {
    what: "The Carbon's primary phone number, verified.",
    required: "A Carbon without one adds one, with a code by SMS, before continuing.",
    optional: "Shared only if the Carbon ticks it.",
  },
  dob: {
    what: "Their date of birth (every account has one).",
    required: "Always shared.",
    optional: "Shared only if the Carbon ticks it.",
  },
  timezone: {
    what: "Their IANA time zone, like Europe/London.",
    required: "Always shared.",
    optional: "Shared only if the Carbon ticks it.",
  },
};

export function DetailsTab() {
  const ctx = useDeveloperApp();
  const editor = ctx.editor;
  const view = useEditor(editor);
  const draft = view.draft;
  const fields = view.fieldErrors.flow;
  const { theme: siteTheme } = useTheme();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const requested = requestedFields(draft);
  const steps = effectiveSteps(draft);
  const shownIndex = Math.min(previewIndex, steps.length - 1);

  const modeOf = (field: ContactField): "required" | "optional" | null =>
    draft.required_fields.includes(field) ? "required" : draft.optional_fields.includes(field) ? "optional" : null;

  /** Ticking asks for the detail as required; unticking stops asking for it. */
  const toggle = (field: ContactField, on: boolean) => {
    const required = draft.required_fields.filter(item => item !== field);
    const optional = draft.optional_fields.filter(item => item !== field);
    editor.editMany({ required_fields: on ? [...required, field] : required, optional_fields: optional });
  };
  const setMode = (field: ContactField, mode: "required" | "optional") => {
    const required = draft.required_fields.filter(item => item !== field);
    const optional = draft.optional_fields.filter(item => item !== field);
    editor.editMany(mode === "required" ? { required_fields: [...required, field], optional_fields: optional } : { required_fields: required, optional_fields: [...optional, field] });
  };
  const pageOf = (field: ContactField) => steps.findIndex(step => step.fields.includes(field));
  const problem = messageFor(fields, "optional_fields") ?? messageFor(fields, "required_fields");

  return (
    <div className={styles.layout} data-room={view.dirty.flow || undefined}>
      <div className={styles.main}>
        <EditorAlerts section="flow" editor={editor} />
        <Section
          title="What the app asks for"
          description={`Name, id and profile photo are always shared. Tick what else ${ctx.app.name} needs: a ticked detail is required, and you can switch it to optional so each Carbon decides.`}
          actions={<Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}><History size={14} strokeWidth={1.75} aria-hidden="true" />{`Version ${view.version}`}</Button>}
        >
          <ul data-sq="surface" className={styles.list} role="list">
            <li className={styles.row} data-on="">
              <span className={styles.lock} aria-hidden="true"><Lock size={16} strokeWidth={1.75} /></span>
              <span className={styles.text}>
                <span className={styles.name}>Name, id and profile photo</span>
                <span className={styles.description}>The profile every app sees: display name, c:id or si:id, photo, and the uuid that never changes.</span>
              </span>
              <Badge size="sm" tone="neutral">Always shared</Badge>
            </li>
            {CONTACT_FIELDS.map(field => {
              const mode = modeOf(field);
              const page = pageOf(field);
              const text = DESCRIPTIONS[field];
              return (
                <li key={field} className={styles.row} data-on={mode ? "" : undefined}>
                  <Checkbox aria-label={`Ask for ${FIELD_LABELS[field]}`} checked={!!mode} onCheckedChange={next => toggle(field, next === true)} />
                  <span className={styles.text}>
                    <span className={styles.name}>{FIELD_LABELS[field]}</span>
                    <span className={styles.description}>{mode ? `${text.what} ${mode === "required" ? text.required : text.optional}` : text.what}</span>
                    {mode && draft.flow && page >= 0 && steps.length > 1 ? <span className={styles.page}>{`Asked on page ${page + 1} of ${steps.length}`}</span> : null}
                  </span>
                  {mode ? (
                    <SegmentedControl label={`${FIELD_LABELS[field]}: required or optional`} value={mode} onValueChange={value => setMode(field, value as "required" | "optional")} options={[{ value: "required", label: "Required" }, { value: "optional", label: "Optional" }]} />
                  ) : <span className={styles.off}>Not asked</span>}
                </li>
              );
            })}
          </ul>
          {problem ? <p className={styles.fieldError} role="alert">{problem}</p> : null}
        </Section>

        <Section title="What Carbons see" description="The what's-shared page appears the first time a Carbon signs in, and again whenever the app asks for more.">
          <div className={styles.facts}>
            <p><strong>Required</strong> details are shared every time. A Carbon who hasn&apos;t set one up yet (say, a phone number) adds it right there, with a code, before continuing.</p>
            <p><strong>Optional</strong> details come with a checkbox that starts unticked; only what the Carbon ticks is shared. A returning Carbon who already shared one sees it ticked.</p>
            <p><strong>Silicons</strong> never see these pages: they sign in with their STK. They have no email or phone, so those are skipped; their time zone and date of birth are shared when asked.</p>
          </div>
        </Section>

        <Section
          title="Where they are asked"
          description={draft.flow
            ? `Your own flow asks them on ${steps.length === 1 ? "one page" : `${steps.length} pages`}${draft.flow.review ? ", then shows a review page" : ""}.`
            : requested.length ? "On one page, the what's-shared page, with every detail together." : "Nothing beyond the profile: the what's-shared page shows the name, id and photo on the first sign-in."}
          actions={<Button variant="secondary" size="sm" onClick={() => ctx.openTab("flows")}>{draft.flow ? "Edit the flow" : "Build a flow"}<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></Button>}
        >
          <ol className={styles.pages}>
            {steps.map((step, index) => (
              <li key={`${step.id}-${index}`}>
                <span className={styles.pageNumber}>{index + 1}</span>
                <span className={styles.pageText}>
                  <span className={styles.name}>{step.title?.trim() || (steps.length > 1 ? `Page ${index + 1}` : "What's shared")}</span>
                  <span className={styles.description}>{step.fields.length ? step.fields.map(field => `${FIELD_LABELS[field]}${draft.optional_fields.includes(field) ? " (optional)" : ""}`).join(", ") : "Name, id and profile photo"}</span>
                </span>
              </li>
            ))}
          </ol>
        </Section>
      </div>

      <aside className={styles.preview} aria-label="Preview">
        {steps.length > 1 ? (
          <SegmentedControl label="Preview page" value={String(shownIndex)} onValueChange={value => setPreviewIndex(Number(value))} options={steps.map((_, index) => ({ value: String(index), label: `Page ${index + 1}` }))} />
        ) : null}
        <HostedPreview
          app={{ name: ctx.app.name, logo_url: ctx.app.logo_url, logo_dark_url: ctx.app.logo_dark_url }}
          config={draft}
          theme={resolveBrandTheme(draft.branding.theme, siteTheme)}
          page={{ kind: "details", index: shownIndex }}
          device="phone"
          host={hostOfUrl(ctx.publicUrl)}
          maxHeight={640}
        />
        <p className={styles.previewNote}>Live, with your unsaved changes. Every page is on the Pages tab.</p>
      </aside>

      <SaveBar section="flow" editor={editor} />
      <HistoryDrawer open={historyOpen} onOpenChange={setHistoryOpen} appId={ctx.appId} editor={editor} section="flow" />
    </div>
  );
}
