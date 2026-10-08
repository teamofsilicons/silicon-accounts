"use client";

/**
 * Overview: the user base in three numbers, every part of the app's setup with its current state (and what still needs
 * attention), and the facts that identify the app. Reads the stored setup, never the unsaved draft.
 */
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { ArrowRight, CircleAlert, Code, KeyRound, ListChecks, Palette, ShieldCheck, Upload, Users, Webhook, Workflow } from "lucide-react";
import { Badge } from "@/components/arc/badge/badge";
import { CopyButton } from "@/components/arc/copy-button/copy-button";
import { MetricCard } from "@/components/arc/metric-card/metric-card";
import { ButtonLink } from "@/components/foundation/button-link";
import { DescriptionItem, DescriptionList, Section, Surface } from "@/components/foundation/layout/layout";
import { FIELD_LABELS, formatCount, formatDate, plural } from "@/lib/format";
import { paths, type DeveloperTab } from "@/lib/navigation";
import { useDeveloperApp } from "../lib/context";
import { useEditor } from "../lib/editor";
import { requestedFields } from "../lib/config";
import { METHOD_LABEL, SOURCE_NOTE, appStatus, hostOf } from "../lib/labels";
import styles from "./overview.module.css";

interface Card {
  tab: DeveloperTab;
  title: string;
  icon: ReactNode;
  summary: string;
  detail?: string;
  attention?: string;
  extra?: ReactNode;
}

const capitalize = (value: string) => `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
const swatch = (colour: string) => ({ "--sq-fill": colour }) as CSSProperties;

export function OverviewTab() {
  const ctx = useDeveloperApp();
  const view = useEditor(ctx.editor);
  const app = ctx.app;
  const config = view.base;
  const stats = app.stats ?? { users: 0, active_last_30d: 0, imported_unclaimed: 0 };
  const enabled = config.method_order.filter(method => config.methods[method]);
  const unavailable = enabled.filter(method => (method === "google" || method === "apple") && config[method].mode === "managed" && ctx.meta && !ctx.meta.providers[method]);
  const branding = config.branding;
  const webhook = app.webhook ?? { url: null, secret_set: false };
  const status = appStatus(app.status);
  const requested = requestedFields(config);
  const flowPages = config.flow?.steps.length ?? (requested.length ? 1 : 0);

  const cards: Card[] = [
    {
      tab: "sign-in",
      title: "Sign-in",
      icon: <KeyRound size={18} strokeWidth={1.75} />,
      summary: enabled.length ? enabled.map(method => METHOD_LABEL[method]).join(", ") : "No method is on",
      detail: `${plural(config.redirect_uris.length, "redirect URI")} · ${config.allow_signup ? "sign up allowed" : "existing accounts only"}`,
      attention: !config.redirect_uris.length
        ? "Add the redirect URI your app receives the code on"
        : unavailable.length
          ? `${unavailable.map(method => METHOD_LABEL[method]).join(" and ")} one click is not configured here; bring your own or turn it off`
          : undefined,
    },
    {
      tab: "details",
      title: "Details",
      icon: <ListChecks size={18} strokeWidth={1.75} />,
      summary: requested.length ? requested.map(field => `${FIELD_LABELS[field]}${config.optional_fields.includes(field) ? " (optional)" : ""}`).join(", ") : "Name, id and photo only",
      detail: "Required details are always shared; optional ones are a checkbox each Carbon decides",
    },
    {
      tab: "flows",
      title: "Flows",
      icon: <Workflow size={18} strokeWidth={1.75} />,
      summary: config.flow ? `Your own flow: ${plural(flowPages, "page")}${config.flow.review ? " and a review" : ""}` : requested.length ? "One page with every detail" : "The what's-shared page only",
      detail: "Which details are asked on which page, in what order",
    },
    {
      tab: "pages",
      title: "Pages",
      icon: <Palette size={18} strokeWidth={1.75} />,
      summary: `${capitalize(branding.layout)} layout · ${branding.font_family} · ${branding.corner_style} corners`,
      detail: branding.theme === "auto" ? "Follows each visitor's light or dark setting" : `Always ${branding.theme}`,
      extra: (
        <span className={styles.swatches} aria-hidden="true">
          <i data-sq="surface" style={swatch(branding.light.primary)} />
          <i data-sq="surface" style={swatch(branding.light.background)} />
          <i data-sq="surface" style={swatch(branding.dark.primary)} />
          <i data-sq="surface" style={swatch(branding.dark.background)} />
        </span>
      ),
    },
    {
      tab: "users",
      title: "Users",
      icon: <Users size={18} strokeWidth={1.75} />,
      summary: plural(stats.users, "Carbon or Silicon", "Carbons and Silicons"),
      detail: `${formatCount(stats.active_last_30d)} signed in during the last 30 days`,
    },
    {
      tab: "import",
      title: "Import",
      icon: <Upload size={18} strokeWidth={1.75} />,
      summary: stats.imported_unclaimed ? `${formatCount(stats.imported_unclaimed)} imported, not claimed yet` : "Bring your existing users",
      detail: "CSV or JSON; matched by email or phone",
    },
    {
      tab: "webhooks",
      title: "Webhooks",
      icon: <Webhook size={18} strokeWidth={1.75} />,
      summary: webhook.url ? hostOf(webhook.url) : "No webhook yet",
      detail: webhook.url ? (webhook.secret_set ? "Signed with a whsec_ secret" : "No signing secret stored") : "Hear about id changes, updates, sign-outs and deletions",
      attention: webhook.url ? undefined : "Recommended: ids change and accounts get deleted",
    },
    {
      tab: "ata",
      title: "App verification",
      icon: <ShieldCheck size={18} strokeWidth={1.75} />,
      summary: "Verify your app to one other app",
      detail: "Create, review and revoke verification tokens",
    },
    {
      tab: "embed",
      title: "Embed",
      icon: <Code size={18} strokeWidth={1.75} />,
      summary: "Hosted link, iframe or SDK",
      detail: config.allowed_origins.length ? `${plural(config.allowed_origins.length, "allowed origin")} for the iframe` : "The hosted link and the SDK's buttons work on any site",
      attention: config.allowed_origins.length ? undefined : "The iframe needs an allowed origin",
    },
  ];

  return (
    <div className={styles.overview}>
      <div className={styles.metrics}>
        <MetricCard label="Users" value={stats.users} context="Carbons and Silicons with access, including imported" />
        <MetricCard label="Active in 30 days" value={stats.active_last_30d} context="Signed in at least once in the last 30 days" />
        <MetricCard label="Imported, not claimed" value={stats.imported_unclaimed} context="They finish setting up the first time they sign in" />
      </div>

      <Section title="Setup" description="Every part of how this app signs people in. Open one to change it.">
        <ul className={styles.cards} role="list">
          {cards.map(card => (
            <li key={card.tab}>
              <Link
                href={paths.developerApp(ctx.appId, card.tab)}
                data-sq="surface"
                className={styles.card}
                data-attention={card.attention ? "" : undefined}
                onClick={event => {
                  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault();
                  ctx.openTab(card.tab);
                }}
              >
                <span className={styles.cardHead}>
                  <span className={styles.cardIcon} aria-hidden="true">{card.icon}</span>
                  <span className={styles.cardTitle}>{card.title}</span>
                  <ArrowRight className={styles.cardArrow} size={16} strokeWidth={1.75} aria-hidden="true" />
                </span>
                <span className={styles.cardSummary}>{card.summary}</span>
                {card.detail ? <span className={styles.cardDetail}>{card.detail}</span> : null}
                {card.extra}
                {card.attention ? <span className={styles.cardAttention}><CircleAlert size={14} strokeWidth={1.75} aria-hidden="true" />{card.attention}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="About this app"
        description="Manage its name, logo, description and releases in Publishing. Configure its sign-in with the Accounts tabs."
        actions={<ButtonLink href={paths.developerApp(app.app_id, "publishing")} variant="ghost" size="sm">Manage publishing<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" /></ButtonLink>}
      >
        <Surface>
          <DescriptionList>
            <DescriptionItem label="App id"><span className={styles.inline}><code className="mono">{app.app_id}</code><CopyButton value={app.app_id} label="Copy app id" iconOnly variant="plain" /></span></DescriptionItem>
            <DescriptionItem label="Status"><Badge size="sm" tone={status.tone}>{status.label}</Badge></DescriptionItem>
            <DescriptionItem label="Source">{SOURCE_NOTE[app.source] ?? app.source}</DescriptionItem>
            <DescriptionItem label="Owner">
              {app.owner ? <span><code className="mono">{app.owner.id ?? app.owner.uuid}</code> <span className="secondary">{app.owner.display_name}</span></span> : "No owner recorded"}
            </DescriptionItem>
            <DescriptionItem label="Created">{formatDate(app.created_at)}</DescriptionItem>
            {app.homepage_url ? <DescriptionItem label="Homepage"><a href={app.homepage_url} target="_blank" rel="noopener">{app.homepage_url}</a></DescriptionItem> : null}
            {app.description ? <DescriptionItem label="Description">{app.description}</DescriptionItem> : null}
            <DescriptionItem label="Sign-in setup">{`Version ${view.version}`}</DescriptionItem>
            <DescriptionItem label="Credentials">The app authenticates with its app id and the secret Silicon Apps gave it. Silicon Accounts never shows that secret.</DescriptionItem>
          </DescriptionList>
        </Surface>
      </Section>
    </div>
  );
}
