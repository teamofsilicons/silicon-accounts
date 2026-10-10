"use client";

/**
 * Flows: which pages a Carbon goes through for the details the app asks, in what order, and which detail is on which
 * page (UNDERSTANDING "Flows"). A visual builder over SigninConfig.flow:
 *  - the journey from the method choice to the app, with the app's own pages in it;
 *  - one card per page: its details as chips (drag a chip onto another page or before another chip; every chip also has
 *    a menu to move it, for keyboards and touch), its id, title, subtitle, continue label and layout;
 *  - pages reorder by their handle (drag, or the arrow keys), up to 8; a removed page hands its details to a neighbour;
 *  - a review page of everything shared, on or off;
 *  - a live preview of the selected page.
 * The server's rules are checked as you go (lib/validate.ts flowProblems) and shown next to what they are about.
 * flow = null is the default: one page with every requested detail, no review.
 */
import { Fragment, useState, type DragEvent, type KeyboardEvent } from "react";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import { Reorder, useDragControls, useReducedMotion } from "motion/react";
import { ArrowRight, GripVertical, History, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { Alert } from "@/components/silicon-ui/alert/alert";
import { Badge } from "@/components/silicon-ui/badge/badge";
import { Button } from "@/components/silicon-ui/button/button";
import menuStyles from "@/components/silicon-ui/dropdown-menu/dropdown-menu.module.css";
import { Input } from "@/components/silicon-ui/input/input";
import SegmentedControl from "@/components/silicon-ui/segmented-control/segmented-control";
import { Select } from "@/components/silicon-ui/select/select";
import { Switch } from "@/components/silicon-ui/switch/switch";
import { motionTokens } from "@/components/silicon-ui/lib/motion-tokens";
import { Section, SettingsGroup, SettingsRow, Surface } from "@/components/foundation/layout/layout";
import { useTheme } from "@/components/foundation/theme/use-theme";
import type { BrandLayout, ContactField, SigninFlow, SigninFlowStep } from "@/lib/api/types";
import { resolveBrandTheme, type PaintTheme } from "@/lib/branding/apply";
import { LIMITS } from "@/lib/branding/defaults";
import { FIELD_LABELS } from "@/lib/format";
import { MAX_FLOW_STEPS, defaultFlowOf, emptyStep, freeStepId, requestedFields } from "../lib/config";
import { hostOfUrl, useDeveloperApp } from "../lib/context";
import { useEditor } from "../lib/editor";
import { under } from "../lib/json";
import { EditorAlerts } from "../parts/editor-alerts";
import { HistoryDrawer } from "../parts/history-drawer";
import { SaveBar } from "../parts/save-bar";
import { HostedPreview, defaultContinueLabel, defaultStepSubtitle, defaultStepTitle, type PreviewDevice } from "./hosted-preview";
import styles from "./flows.module.css";

const FIELD_MIME = "application/x-silicon-field";
const LAYOUT_OPTIONS = [
  { value: "inherit", label: "The branding's layout" },
  { value: "card", label: "Card" },
  { value: "split", label: "Split" },
  { value: "minimal", label: "Minimal" },
];

/**
 * Stable React keys for pages: a page's id can be edited (a key from it would remount the card under the typing hand)
 * and its index changes on reorder, so each page object gets a key, and an edited copy carries its original's.
 */
const pageKeys = new WeakMap<SigninFlowStep, string>();
let nextPageKey = 0;
function keyOf(step: SigninFlowStep): string {
  let key = pageKeys.get(step);
  if (!key) {
    nextPageKey += 1;
    key = `page-${nextPageKey}`;
    pageKeys.set(step, key);
  }
  return key;
}
function carry(from: SigninFlowStep, to: SigninFlowStep): SigninFlowStep {
  pageKeys.set(to, keyOf(from));
  return to;
}

/** A copy of the flow with `field` taken off its page and put on page `to`, before `before` (or at the end). */
function moveField(flow: SigninFlow, field: ContactField, to: number, before?: ContactField): SigninFlow {
  const steps = flow.steps.map(step => carry(step, { ...step, fields: step.fields.filter(item => item !== field) }));
  const target = steps[to];
  if (!target) return flow;
  const at = before ? target.fields.indexOf(before) : -1;
  const fields = [...target.fields];
  if (at >= 0) fields.splice(at, 0, field);
  else fields.push(field);
  steps[to] = carry(target, { ...target, fields });
  return { ...flow, steps };
}

interface MoveItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  separatorBefore?: boolean;
}

/**
 * A detail chip's menu: move it on its page or to another page. Its own small trigger, so pressing anywhere else on the
 * chip starts a drag instead of opening the menu (Arc's menu styles, Radix's keyboard handling).
 */
function FieldMenu({ label, items }: { label: string; items: MoveItem[] }) {
  return (
    <DropdownPrimitive.Root>
      <DropdownPrimitive.Trigger type="button" data-sq="surface" className={styles.chipMenu} aria-label={`Move ${label}`}>
        <MoreHorizontal size={14} strokeWidth={1.75} aria-hidden="true" />
      </DropdownPrimitive.Trigger>
      <DropdownPrimitive.Portal>
        <DropdownPrimitive.Content data-sq="surface" className={menuStyles.menu} sideOffset={6} align="start" collisionPadding={12} loop>
          {items.map(item => (
            <Fragment key={item.label}>
              {item.separatorBefore ? <DropdownPrimitive.Separator className={menuStyles.separator} /> : null}
              <DropdownPrimitive.Item className={`${menuStyles.item} ${styles.menuItem}`} disabled={item.disabled} onSelect={item.onSelect}>{item.label}</DropdownPrimitive.Item>
            </Fragment>
          ))}
        </DropdownPrimitive.Content>
      </DropdownPrimitive.Portal>
    </DropdownPrimitive.Root>
  );
}

interface StepCardProps {
  step: SigninFlowStep;
  index: number;
  count: number;
  selected: boolean;
  required: readonly ContactField[];
  stepLabels: string[];
  errors: Record<string, string>;
  reduced: boolean;
  dragField: ContactField | null;
  onDragField: (field: ContactField | null) => void;
  onSelect: () => void;
  onChange: (next: SigninFlowStep) => void;
  onMove: (field: ContactField, to: number, before?: ContactField) => void;
  onRemove: () => void;
  onKeyMove: (index: number, event: KeyboardEvent<HTMLButtonElement>) => void;
  defaultLabel: string;
  appName: string;
}

function StepCard(props: StepCardProps) {
  const { step, index, count, selected, required, stepLabels, errors, reduced, dragField, onDragField, onSelect, onChange, onMove, onRemove, onKeyMove, defaultLabel, appName } = props;
  const controls = useDragControls();
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  const at = `flow.steps[${index}]`;
  const accepts = (event: DragEvent) => event.dataTransfer.types.includes(FIELD_MIME);
  const dropField = (event: DragEvent, before?: ContactField) => {
    if (!accepts(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setOver(false);
    const field = event.dataTransfer.getData(FIELD_MIME) as ContactField;
    if (field && field !== before) onMove(field, index, before);
    onDragField(null);
  };
  // The server names the field itself (flow.steps[0].fields[1]); the browser's own check names the page's list.
  const fieldsProblem = Object.entries(errors).find(([path]) => under(path, `${at}.fields`))?.[1];
  return (
    <Reorder.Item
      as="li"
      value={step}
      data-sq="surface"
      className={styles.card}
      data-selected={selected || undefined}
      data-dragging={dragging || undefined}
      data-problem={Object.keys(errors).some(path => path.startsWith(at)) || undefined}
      dragListener={false}
      dragControls={controls}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => setDragging(false)}
      transition={reduced ? { duration: 0 } : motionTokens.spring.smooth}
      onFocusCapture={onSelect}
      onPointerDownCapture={onSelect}
    >
      <div className={styles.cardHead}>
        <button
          type="button"
          data-sq="surface"
          className={styles.handle}
          aria-label={`Move page ${index + 1} of ${count}. Use the up and down arrow keys.`}
          aria-roledescription="sortable handle"
          onPointerDown={event => {
            event.preventDefault();
            controls.start(event);
          }}
          onKeyDown={event => onKeyMove(index, event)}
        >
          <GripVertical size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <span className={styles.pageBadge}>{`Page ${index + 1}`}</span>
        <span className={styles.cardTitle}>{step.title?.trim() || defaultStepTitle(appName, step.fields, count)}</span>
        {count > 1 ? (
          <Button variant="ghost" size="sm" className={styles.remove} onClick={onRemove} aria-label={`Remove page ${index + 1}; its details move to page ${index === 0 ? 2 : index}`}>
            <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />Remove
          </Button>
        ) : null}
      </div>

      <div
        data-sq="surface"
        className={styles.drop}
        data-over={over || undefined}
        data-empty={!step.fields.length || undefined}
        onDragOver={event => {
          if (!accepts(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setOver(true);
        }}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
        }}
        onDrop={event => dropField(event)}
        aria-label={`Details asked on page ${index + 1}`}
        role="group"
      >
        {step.fields.map((field, position) => {
          const items: MoveItem[] = [
            ...(position > 0 ? [{ label: "Move earlier on this page", onSelect: () => onMove(field, index, step.fields[position - 1]) }] : []),
            ...(position < step.fields.length - 1 ? [{ label: "Move later on this page", onSelect: () => onMove(field, index, step.fields[position + 2]) }] : []),
            ...stepLabels.map((label, to) => ({ label: `Move to ${label}`, onSelect: () => onMove(field, to), disabled: to === index, separatorBefore: to === 0 && step.fields.length > 1 })),
          ];
          return (
            <div
              key={field}
              data-sq="surface"
              className={styles.chip}
              data-dragging={dragField === field || undefined}
              draggable
              onDragStart={event => {
                event.dataTransfer.setData(FIELD_MIME, field);
                event.dataTransfer.effectAllowed = "move";
                onDragField(field);
              }}
              onDragEnd={() => onDragField(null)}
              onDragOver={event => {
                if (!accepts(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
              onDrop={event => dropField(event, field)}
            >
              <GripVertical className={styles.chipGrip} size={14} strokeWidth={1.75} aria-hidden="true" />
              <span className={styles.chipLabel}>{FIELD_LABELS[field]}</span>
              <Badge size="sm" tone={required.includes(field) ? "info" : "neutral"}>{required.includes(field) ? "Required" : "Optional"}</Badge>
              <FieldMenu label={FIELD_LABELS[field]} items={items} />
            </div>
          );
        })}
        {!step.fields.length ? <span className={styles.dropHint}>Drag a detail here, or use a detail&apos;s menu to move it onto this page.</span> : null}
      </div>
      {fieldsProblem ? <p className={styles.fieldError} role="alert">{fieldsProblem}</p> : null}

      <div className={styles.cardFields}>
        <Input label="Title" placeholder={defaultStepTitle(appName, step.fields, count)} value={step.title ?? ""} onChange={event => onChange({ ...step, title: event.currentTarget.value || null })} error={errors[`${at}.title`]} description={`${[...(step.title ?? "")].length} of ${LIMITS.titleMax}`} />
        <Input label="Subtitle" placeholder={defaultStepSubtitle(appName)} value={step.subtitle ?? ""} onChange={event => onChange({ ...step, subtitle: event.currentTarget.value || null })} error={errors[`${at}.subtitle`]} description={`${[...(step.subtitle ?? "")].length} of ${LIMITS.subtitleMax}`} />
        <Input label="Continue button" placeholder={defaultLabel} value={step.continue_label ?? ""} onChange={event => onChange({ ...step, continue_label: event.currentTarget.value || null })} error={errors[`${at}.continue_label`]} description={`${[...(step.continue_label ?? "")].length} of ${LIMITS.continueLabelMax}`} />
        <Select label="Layout" value={step.layout ?? "inherit"} onValueChange={value => onChange({ ...step, layout: value === "inherit" ? null : (value as BrandLayout) })} options={LAYOUT_OPTIONS} />
        <Input label="Page id" className={styles.mono} value={step.id} onChange={event => onChange({ ...step, id: event.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) })} error={errors[`${at}.id`]} description="Lowercase letters, digits and dashes; unique in the flow." spellCheck={false} autoComplete="off" />
      </div>
    </Reorder.Item>
  );
}

export function FlowsTab() {
  const ctx = useDeveloperApp();
  const editor = ctx.editor;
  const view = useEditor(editor);
  const draft = view.draft;
  const flow = draft.flow;
  const errors = view.fieldErrors.flow;
  const reduced = !!useReducedMotion();
  const { theme: siteTheme } = useTheme();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [device, setDevice] = useState<PreviewDevice>("phone");
  const [visitorTheme, setVisitorTheme] = useState<PaintTheme>(siteTheme);
  const [dragField, setDragField] = useState<ContactField | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const requested = requestedFields(draft);
  const steps = flow?.steps ?? (requested.length ? defaultFlowOf(draft).steps : []);
  const shown = Math.min(selected, Math.max(0, steps.length - 1));
  const paint = resolveBrandTheme(draft.branding.theme, visitorTheme);
  const stepLabels = steps.map((step, index) => `page ${index + 1}${step.title ? ` (${step.title})` : ""}`);

  const setFlow = (next: SigninFlow | null) => editor.edit("flow", next);
  const update = (change: (current: SigninFlow) => SigninFlow) => {
    if (flow) setFlow(change(flow));
  };
  const customize = () => {
    setFlow(defaultFlowOf(draft));
    setSelected(0);
  };
  const addPage = () => update(current => {
    if (current.steps.length >= MAX_FLOW_STEPS) return current;
    setSelected(current.steps.length);
    return { ...current, steps: [...current.steps, emptyStep(freeStepId(current.steps))] };
  });
  const removePage = (index: number) => update(current => {
    const removed = current.steps[index];
    if (!removed || current.steps.length < 2) return current;
    const heir = index === 0 ? 1 : index - 1;
    const steps = current.steps.map((step, position) => (position === heir ? carry(step, { ...step, fields: [...step.fields, ...removed.fields] }) : step)).filter((_, position) => position !== index);
    setSelected(Math.max(0, heir > index ? heir - 1 : heir));
    setAnnouncement(`Page ${index + 1} removed; its details moved to page ${heir > index ? heir : heir + 1}.`);
    return { ...current, steps };
  });
  const onKeyMove = (index: number, event: KeyboardEvent<HTMLButtonElement>) => {
    const to = event.key === "ArrowUp" ? index - 1 : event.key === "ArrowDown" ? index + 1 : event.key === "Home" ? 0 : event.key === "End" ? steps.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    if (to < 0 || to >= steps.length || to === index) return;
    update(current => {
      const next = [...current.steps];
      const [moved] = next.splice(index, 1);
      if (moved) next.splice(to, 0, moved);
      return { ...current, steps: next };
    });
    setSelected(to);
    setAnnouncement(`Page ${index + 1} moved to position ${to + 1} of ${steps.length}.`);
    const handle = event.currentTarget;
    requestAnimationFrame(() => handle.focus());
  };
  const stepsProblem = errors["flow.steps"] ?? errors.flow;

  return (
    <div className={styles.layout} data-room={view.dirty.flow || undefined}>
      <div className={styles.main}>
        <EditorAlerts section="flow" editor={editor} />

        <Section
          title="The journey"
          description="Every Carbon goes from your button to your app through these pages. The pages in your flow ask for the details on the Details tab; returning Carbons who already shared everything skip straight to your app."
          actions={<Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}><History size={14} strokeWidth={1.75} aria-hidden="true" />{`Version ${view.version}`}</Button>}
        >
          <ol className={styles.journey} aria-label="The sign-in, in order">
            <li><span data-sq="surface" className={styles.node}>Choose a method</span></li>
            <li><span data-sq="surface" className={styles.node}>Code, Google or Apple</span></li>
            <li><span data-sq="surface" className={styles.node} data-optional="">Set up account <em>first time</em></span></li>
            {steps.length ? steps.map((step, index) => (
              <li key={`${step.id}-${index}`}>
                <button type="button" data-sq="surface" className={styles.node} data-own="" aria-pressed={index === shown} onClick={() => setSelected(index)}>
                  {step.title?.trim() || (steps.length > 1 ? `Page ${index + 1}` : "What's shared")}
                </button>
              </li>
            )) : <li><span data-sq="surface" className={styles.node} data-own="">What&apos;s shared <em>profile</em></span></li>}
            {flow?.review ? <li><span data-sq="surface" className={styles.node} data-own="">Review</span></li> : null}
            <li><span data-sq="surface" className={styles.node}>Back to {ctx.app.name}</span></li>
          </ol>
        </Section>

        {!requested.length ? (
          <Surface className={styles.empty}>
            <p>{ctx.app.name} asks for no details beyond the name, id and profile photo, so its only page is the what&apos;s-shared page, shown on a Carbon&apos;s first sign-in. Pick details first, then arrange them into pages here.</p>
            <Button variant="secondary" size="sm" onClick={() => ctx.openTab("details")}>Pick details<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></Button>
          </Surface>
        ) : !flow ? (
          <Surface className={styles.empty}>
            <p>Right now every detail is asked on one page, the what&apos;s-shared page, with the pages&apos; own words. Build your own flow to split the details over up to {MAX_FLOW_STEPS} pages, give each page its own title, button and layout, and add a review page.</p>
            <Button size="sm" onClick={customize}>Build your own flow</Button>
          </Surface>
        ) : (
          <Section
            title="Your pages"
            description={`Drag a detail onto another page (or use its menu). Drag a page by its handle to reorder. Up to ${MAX_FLOW_STEPS} pages.`}
            actions={<Button variant="ghost" size="sm" onClick={() => setFlow(null)}>Use one page</Button>}
          >
            {stepsProblem ? <Alert tone="warning" title="The flow is not complete">{stepsProblem}</Alert> : null}
            <Reorder.Group as="ol" axis="y" values={flow.steps} onReorder={next => update(current => ({ ...current, steps: next as SigninFlowStep[] }))} className={styles.cards} aria-label="Pages of the flow, in order">
              {flow.steps.map((step, index) => (
                <StepCard
                  key={keyOf(step)}
                  step={step}
                  index={index}
                  count={flow.steps.length}
                  selected={index === shown}
                  required={draft.required_fields}
                  stepLabels={stepLabels}
                  errors={errors}
                  reduced={reduced}
                  dragField={dragField}
                  onDragField={setDragField}
                  onSelect={() => setSelected(index)}
                  onChange={next => update(current => ({ ...current, steps: current.steps.map((item, position) => (position === index ? carry(item, next) : item)) }))}
                  onMove={(field, to, before) => {
                    update(current => moveField(current, field, to, before));
                    setAnnouncement(`${FIELD_LABELS[field]} moved to page ${to + 1}.`);
                  }}
                  onRemove={() => removePage(index)}
                  onKeyMove={onKeyMove}
                  defaultLabel={defaultContinueLabel(index, flow.steps.length, flow.review)}
                  appName={ctx.app.name}
                />
              ))}
            </Reorder.Group>
            <div className={styles.addRow}>
              <Button variant="secondary" size="sm" onClick={addPage} disabled={flow.steps.length >= MAX_FLOW_STEPS}><Plus size={14} strokeWidth={1.75} aria-hidden="true" />Add a page</Button>
              <span className={styles.muted}>{flow.steps.length >= MAX_FLOW_STEPS ? `A flow has at most ${MAX_FLOW_STEPS} pages.` : `${flow.steps.length} of ${MAX_FLOW_STEPS} pages`}</span>
            </div>
            <SettingsGroup label="Review">
              <SettingsRow label="Review page" description="After the last page, show everything that will be shared, with Back to change it, before going to the app.">
                {ids => <Switch aria-labelledby={ids.labelId} aria-describedby={ids.descriptionId} checked={flow.review} onCheckedChange={on => update(current => ({ ...current, review: on }))} />}
              </SettingsRow>
            </SettingsGroup>
          </Section>
        )}
        <p className="sr-only" role="status">{announcement}</p>
      </div>

      <aside className={styles.preview} aria-label="Preview">
        <div className={styles.previewTools}>
          <SegmentedControl label="Preview theme" value={paint} onValueChange={value => setVisitorTheme(value as PaintTheme)} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
          <SegmentedControl label="Preview size" value={device} onValueChange={value => setDevice(value as PreviewDevice)} options={[{ value: "phone", label: "Phone" }, { value: "desktop", label: "Desktop" }]} />
        </div>
        <HostedPreview
          app={{ name: ctx.app.name, logo_url: ctx.app.logo_url, logo_dark_url: ctx.app.logo_dark_url }}
          config={draft}
          theme={paint}
          page={{ kind: "details", index: shown }}
          device={device}
          host={hostOfUrl(ctx.publicUrl)}
          maxHeight={640}
        />
        <p className={styles.previewNote}>{steps.length > 1 ? `Page ${shown + 1} of ${steps.length}, live with your unsaved changes.` : "Live, with your unsaved changes."}</p>
      </aside>

      <SaveBar section="flow" editor={editor} />
      <HistoryDrawer open={historyOpen} onOpenChange={setHistoryOpen} appId={ctx.appId} editor={editor} section="flow" />
    </div>
  );
}
