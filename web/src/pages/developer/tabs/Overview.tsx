/**
 * Overview: the user base in three numbers, every part of the app's setup with its current state (and what still needs
 * attention), and the facts that identify the app.
 */
import { A } from "@solidjs/router";
import { ArrowRight, ArrowUpRight, CircleAlert, Code, KeyRound, Palette, ShieldCheck, Upload, Users, Webhook } from "lucide-solid";
import { For, Show, type JSX } from "solid-js";
import { Badge } from "../../../arc/badge/badge";
import { LinkButton } from "../../../arc/button/button";
import { CopyButton } from "../../../arc/copy-button/copy-button";
import { MetricCard } from "../../../arc/metric-card/metric-card";
import { useSquircle } from "../../../arc/lib/squircle";
import { pressable } from "../../../arc/lib/motion";
import { DescriptionItem, DescriptionList, Section, Surface } from "../../../app/layout/layout";
import { paths, type DeveloperTab } from "../../../app/navigation";
import { formatCount, formatDate, plural } from "../../../lib/format";
import { useDeveloperApp } from "../lib/context";
import { METHOD_LABEL, SOURCE_NOTE, APP_STATUS } from "../lib/labels";
import { siliconAppsUrl } from "../lib/meta";
import styles from "./overview.module.css";

interface Card {
  tab: DeveloperTab;
  title: string;
  icon: () => JSX.Element;
  summary: string;
  detail?: string;
  attention?: string;
  extra?: () => JSX.Element;
}

export default function Overview() {
  const ctx = useDeveloperApp();
  const app = ctx.app;
  const config = () => ctx.editor.base();
  const stats = () => app().stats ?? { users: 0, active_last_30d: 0, imported_unclaimed: 0 };

  const enabledMethods = () => config().method_order.filter(method => config().methods[method]);
  const unavailable = () => enabledMethods().filter(method => (method === "google" || method === "apple") && config()[method].mode === "managed" && ctx.meta() && !ctx.meta()?.providers[method]);

  const cards = (): Card[] => {
    const methods = enabledMethods();
    const branding = config().branding;
    const webhook = app().webhook;
    const cardsList: Card[] = [
      {
        tab: "sign-in",
        title: "Sign-in",
        icon: () => <KeyRound size={18} stroke-width={1.75} />,
        summary: methods.length ? methods.map(method => METHOD_LABEL[method]).join(", ") : "No method is on",
        detail: `${plural(config().redirect_uris.length, "redirect URI")} · ${config().allow_signup ? "sign up allowed" : "existing accounts only"}`,
        attention: !config().redirect_uris.length
          ? "Add the redirect URI your app receives the code on"
          : unavailable().length
            ? `${unavailable().map(method => METHOD_LABEL[method]).join(" and ")} one click is not configured here; bring your own or turn it off`
            : undefined,
      },
      {
        tab: "branding",
        title: "Branding",
        icon: () => <Palette size={18} stroke-width={1.75} />,
        summary: `${branding.layout[0]?.toUpperCase()}${branding.layout.slice(1)} layout · ${branding.font_family} · ${branding.corner_style} corners`,
        detail: branding.theme === "auto" ? "Follows each visitor's light or dark setting" : `Always ${branding.theme}`,
        extra: () => (
          <span class={styles.swatches} aria-hidden="true">
            <i ref={el => useSquircle(el)} style={{ "--sq-fill": branding.light.primary }} />
            <i ref={el => useSquircle(el)} style={{ "--sq-fill": branding.light.background }} />
            <i ref={el => useSquircle(el)} style={{ "--sq-fill": branding.dark.primary }} />
            <i ref={el => useSquircle(el)} style={{ "--sq-fill": branding.dark.background }} />
          </span>
        ),
      },
      {
        tab: "users",
        title: "Users",
        icon: () => <Users size={18} stroke-width={1.75} />,
        summary: plural(stats().users, "Carbon or Silicon", "Carbons and Silicons"),
        detail: `${formatCount(stats().active_last_30d)} signed in during the last 30 days`,
      },
      {
        tab: "import",
        title: "Import",
        icon: () => <Upload size={18} stroke-width={1.75} />,
        summary: stats().imported_unclaimed ? `${formatCount(stats().imported_unclaimed)} imported, not claimed yet` : "Bring your existing users",
        detail: "CSV or JSON; matched by email or phone",
      },
      {
        tab: "webhooks",
        title: "Webhooks",
        icon: () => <Webhook size={18} stroke-width={1.75} />,
        summary: webhook?.url ? hostOf(webhook.url) : "No webhook yet",
        detail: webhook?.url ? (webhook.secret_set ? "Signed with a whsec_ secret" : "No signing secret stored") : "Hear about id changes, updates, sign-outs and deletions",
        attention: webhook?.url ? undefined : "Recommended: ids change and accounts get deleted",
      },
      {
        tab: "proofs",
        title: "Proofs",
        icon: () => <ShieldCheck size={18} stroke-width={1.75} />,
        summary: "App-to-app and on-behalf-of proofs",
        detail: "Issue ATA proofs, revoke any proof this app issued",
      },
      {
        tab: "embed",
        title: "Embed",
        icon: () => <Code size={18} stroke-width={1.75} />,
        summary: "Hosted link, iframe or SDK",
        detail: config().allowed_origins.length ? `${plural(config().allowed_origins.length, "allowed origin")} for the iframe` : "The hosted link and the SDK work now",
        attention: config().allowed_origins.length ? undefined : "The iframe needs an allowed origin",
      },
    ];
    return cardsList;
  };

  return (
    <div class={styles.overview}>
      <div class={styles.metrics}>
        <MetricCard label="Users" value={stats().users} context="Carbons and Silicons with access, including imported" />
        <MetricCard label="Active in 30 days" value={stats().active_last_30d} context="Signed in at least once in the last 30 days" />
        <MetricCard label="Imported, not claimed" value={stats().imported_unclaimed} context="They finish setting up the first time they sign in" />
      </div>

      <Section title="Setup" description="Every part of how this app signs people in. Open one to change it.">
        <div class={styles.cards}>
          <For each={cards()}>
            {card => (
              <A href={paths.developerApp(ctx.appId, card.tab)} ref={el => { useSquircle(el); pressable(el); }} class={styles.card} data-attention={card.attention ? "" : undefined}>
                <span class={styles.cardHead}>
                  <span class={styles.cardIcon} aria-hidden="true">{card.icon()}</span>
                  <span class={styles.cardTitle}>{card.title}</span>
                  <ArrowRight class={styles.cardArrow} size={16} stroke-width={1.75} aria-hidden="true" />
                </span>
                <span class={styles.cardSummary}>{card.summary}</span>
                <Show when={card.detail}><span class={styles.cardDetail}>{card.detail}</span></Show>
                <Show when={card.extra}>{extra => extra()()}</Show>
                <Show when={card.attention}>
                  {attention => <span class={styles.cardAttention}><CircleAlert size={14} stroke-width={1.75} aria-hidden="true" />{attention()}</span>}
                </Show>
              </A>
            )}
          </For>
        </div>
      </Section>

      <Section
        title="About this app"
        description="Its name, logo and description come from Silicon Apps; its sign-in setup lives here."
        actions={<LinkButton href={siliconAppsUrl(ctx.meta())} target="_blank" rel="noopener" variant="ghost" size="sm">Silicon Apps<ArrowUpRight size={14} stroke-width={1.75} aria-hidden="true" /></LinkButton>}
      >
        <Surface>
          <DescriptionList>
            <DescriptionItem label="App id"><span class={styles.inline}><code class="mono">{app().app_id}</code><CopyButton value={app().app_id} label="Copy app id" iconOnly size="xs" variant="plain" /></span></DescriptionItem>
            <DescriptionItem label="Status"><Badge size="sm" tone={APP_STATUS[app().status]?.tone ?? "neutral"}>{APP_STATUS[app().status]?.label ?? app().status}</Badge></DescriptionItem>
            <DescriptionItem label="Source">{SOURCE_NOTE[app().source] ?? app().source}</DescriptionItem>
            <DescriptionItem label="Owner">
              <Show when={app().owner} fallback="No owner recorded">
                {owner => <span><code class="mono">{owner().id ?? owner().uuid}</code> <span class="secondary">{owner().display_name}</span></span>}
              </Show>
            </DescriptionItem>
            <DescriptionItem label="Created">{formatDate(app().created_at)}</DescriptionItem>
            <Show when={app().homepage_url}>{href => <DescriptionItem label="Homepage"><a href={href()} target="_blank" rel="noopener">{href()}</a></DescriptionItem>}</Show>
            <Show when={app().description}>{text => <DescriptionItem label="Description">{text()}</DescriptionItem>}</Show>
            <DescriptionItem label="Sign-in setup">Version {ctx.editor.version()}</DescriptionItem>
            <DescriptionItem label="Credentials">The app authenticates with its app id and the secret Silicon Apps gave it. Silicon Accounts never shows that secret.</DescriptionItem>
          </DescriptionList>
        </Surface>
      </Section>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}
