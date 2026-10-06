/**
 * /silicons: the Silicons you are custodian of. Requests waiting for you sit on top as a deck (a Silicon asking you to
 * be its custodian, or a Carbon handing one to you). Each Silicon is a tile; open one to change its details or id,
 * rotate its STK, set its webhook, hand it to another Carbon or delete it. Creating a Silicon shows its generated STK
 * exactly once, in a card that stays until you say you stored it.
 */
import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { Cpu, Plus } from "lucide-solid";
import { api, collectPages, type CustodianRequest, type ManagedSilicon, type SiliconCreated } from "../../api";
import { Alert } from "../../arc/alert/alert";
import { Avatar } from "../../arc/avatar/avatar";
import { Badge } from "../../arc/badge/badge";
import { Button } from "../../arc/button/button";
import { EmptyState } from "../../arc/empty-state/empty-state";
import { SkeletonBlock } from "../../arc/skeleton/skeleton";
import { TextMorph } from "../../arc/text-morph/text-morph";
import { useSquircle } from "../../arc/lib/squircle";
import { registerCommands } from "../../app/commands";
import { Page, PageHeader, Section } from "../../app/layout/layout";
import { refreshMe } from "../../app/session";
import { formatRelative, plural } from "../../lib/format";
import { AnimatedRows } from "./parts/AnimatedRows";
import { CreateSilicon } from "./parts/CreateSilicon";
import { RequestDeck, type Decision } from "./parts/RequestDeck";
import { SecretReveal } from "./parts/SecretReveal";
import { SiliconDrawer } from "./parts/SiliconDrawer";
import { addReveal, dismissReveal, dismissRevealsOf, pendingReveals, type Reveal } from "./parts/reveals";
import { handFocus, pageMain } from "./parts/focus";
import { stkSecret } from "./parts/stk";
import { asCarbon, asSilicon, createLoader, createNow, currentMe, describeError, meError, msUntil, personLabel, spanText } from "./parts/common";
import styles from "./silicons.module.css";
import "./parts/telemetry";

const host = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export default function Silicons() {
  const silicons = createLoader(() => collectPages<ManagedSilicon>(query => api.me.silicons.list(query), 10));
  const requests = createLoader(() => collectPages<CustodianRequest>(query => api.me.custodianRequests.list(query), 5));
  const now = createNow(30_000);
  const [creating, setCreating] = createSignal(false);
  const [openUuid, setOpenUuid] = createSignal<string | null>(null);
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [fresh, setFresh] = createSignal<string | null>(null);
  // This page's focus scope is the shell's main region; the drawers render outside it, in a portal.
  const main = pageMain;
  /** A Silicon's tile, to hand focus to (its button is named "Manage si:…"); never one that is leaving. */
  const tileOf = (uuid: string) => main()?.querySelector<HTMLElement>(`[role="listitem"]:not([data-leaving]) [data-silicon="${CSS.escape(uuid)}"]`);
  /** The control to fall back on when nothing more specific is left: the first tile, else Create a Silicon. */
  const fallbackFocus = () => main()?.querySelector<HTMLElement>(`[role="listitem"]:not([data-leaving]) [data-silicon]`) ?? main()?.querySelector<HTMLElement>("[data-create-silicon]");

  registerCommands(() => (asCarbon(currentMe()) ? [
    { id: "silicons.create", label: "Create a Silicon", description: "You become its custodian; its STK is shown once", group: "Silicons", keywords: ["new", "silicon", "agent", "stk"], run: () => setCreating(true) },
  ] : []));

  const selected = createMemo(() => silicons.data()?.find(item => item.uuid === openUuid()));
  const open = (uuid: string) => {
    setOpenUuid(uuid);
    setDrawerOpen(true);
  };
  const update = (next: ManagedSilicon) => silicons.set(list => (list ?? []).map(item => (item.uuid === next.uuid ? next : item)));
  const removed = (uuid: string) => {
    silicons.set(list => (list ?? []).filter(item => item.uuid !== uuid));
    dismissRevealsOf(uuid);
    refreshMe();
    // The drawer gave focus back to this Silicon's tile, which has just gone.
    handFocus(main(), fallbackFocus);
  };
  /** "I've stored it" on the page: the next secret waiting, else the Silicon it was for, else the first tile. */
  const stored = (reveal: Reveal) => {
    dismissReveal(reveal.id);
    handFocus(main(), () => main()?.querySelector<HTMLElement>("[data-page-reveals] h2") ?? tileOf(reveal.silicon) ?? fallbackFocus());
  };
  // Secrets of the Silicon open in the drawer show there; every other one shows on the page.
  const pageReveals = () => pendingReveals().filter(item => !(drawerOpen() && item.silicon === openUuid()));

  const onCreated = (created: SiliconCreated) => {
    const item: ManagedSilicon = { ...created.silicon, pending_transfer: (created.silicon as Partial<ManagedSilicon>).pending_transfer ?? null };
    // The service lists Silicons in the order they were created; a new one goes last, where a reload puts it too.
    silicons.set(list => [...(list ?? []).filter(existing => existing.uuid !== item.uuid), item]);
    refreshMe();
    setFresh(item.uuid);
    window.setTimeout(() => setFresh(current => (current === item.uuid ? null : current)), 4000);
    const id = item.id ?? item.uuid;
    const secrets = [
      ...(created.stk ? [stkSecret(id, created.stk)] : []),
      ...(created.webhook_secret ? [{ label: "Webhook signing secret", value: created.webhook_secret, note: `Verifies the events sent to ${item.webhook_url ?? "its webhook"}.` }] : []),
    ];
    if (secrets.length) {
      addReveal({
        silicon: item.uuid,
        origin: "created",
        title: created.stk ? `${id} is ready. Store its STK now` : `${id} is ready. Store its webhook secret now`,
        description: created.stk
          ? `This is the password ${id} signs in with. Silicon Accounts keeps only its hash, so it can never be shown again; if it is lost, rotate it.`
          : "Silicon Accounts cannot show it again. Setting the webhook URL again makes a new one.",
        secrets,
      });
    }
  };

  const decide = (request: CustodianRequest, decision: Decision) =>
    decision === "accept" ? api.me.custodianRequests.accept(request.id) : api.me.custodianRequests.decline(request.id);
  const onDecided = (request: CustodianRequest, decision: Decision) => {
    requests.set(list => (list ?? []).filter(item => item.id !== request.id));
    if (decision === "accept") {
      void silicons.reload();
      refreshMe();
    }
  };

  return (
    <Page>
      <PageHeader
        title="Silicons in your care"
        description="Every Silicon has exactly one custodian, a Carbon who manages its account: its details, its id, its STK and who looks after it next."
        actions={<Show when={asCarbon(currentMe())}><Button data-create-silicon onClick={() => setCreating(true)}><Plus size={16} stroke-width={1.75} aria-hidden="true" />Create a Silicon</Button></Show>}
      />
      <Switch fallback={<TilesSkeleton />}>
        <Match when={meError()}>
          {error => <Alert tone="danger" title="Your account did not load" action={<Button variant="secondary" onClick={() => refreshMe()}>Try again</Button>}>{describeError(error())}</Alert>}
        </Match>
        <Match when={asSilicon(currentMe())}>
          {silicon => (
            <EmptyState
              icon={<Cpu width={24} height={24} stroke-width={1.5} />}
              title="Only Carbons can be custodians"
              description={`${silicon().id ?? "This Silicon"} is looked after by ${silicon().custodian?.id ?? "its custodian"}. Silicons do not look after other Silicons.`}
            />
          )}
        </Match>
        <Match when={asCarbon(currentMe())}>
          {carbon => (
            <>
              <Show when={pageReveals().length}>
                <div class={styles.reveals} data-page-reveals>
                  <For each={pageReveals()}>
                    {reveal => <SecretReveal title={reveal.title} description={reveal.description} secrets={reveal.secrets} onDone={() => stored(reveal)} focusOnMount />}
                  </For>
                </div>
              </Show>

              <Switch>
                <Match when={requests.error() && !requests.data()}>
                  <Section title="Waiting for you">
                    <Alert tone="danger" title="Requests waiting for you did not load" action={<Button variant="secondary" onClick={() => void requests.reload()}>Try again</Button>}>
                      {describeError(requests.error())} A Silicon asking you to be its custodian, or a Carbon handing one to you, has 14 days before the request expires.
                    </Alert>
                  </Section>
                </Match>
                <Match when={requests.data()?.length}>
                  <Section title="Waiting for you" description="Each request lasts 14 days. A declined Silicon's account is released; a declined transfer changes nothing.">
                    <RequestDeck requests={requests.data() ?? []} now={now()} decide={decide} onDecided={onDecided} />
                  </Section>
                </Match>
              </Switch>

              <Section
                title="Your Silicons"
                description={silicons.data() ? (silicons.data()!.length ? `${plural(silicons.data()!.length, "Silicon")}. Open one to manage it.` : undefined) : undefined}
              >
                <Switch>
                  <Match when={silicons.error() && !silicons.data()}>
                    <Alert tone="danger" title="Your Silicons did not load" action={<Button variant="secondary" onClick={() => void silicons.reload()}>Try again</Button>}>{describeError(silicons.error())}</Alert>
                  </Match>
                  <Match when={silicons.loading()}>
                    <TilesSkeleton />
                  </Match>
                  <Match when={silicons.data()?.length === 0}>
                    <div ref={el => useSquircle(el)} class={styles.empty}>
                      <EmptyState
                        icon={<Cpu width={24} height={24} stroke-width={1.5} />}
                        title="No Silicons yet"
                        description="Create one and you become its custodian. A Silicon can also create its own account and name you; its request then waits for you here."
                        action={<Button variant="secondary" onClick={() => setCreating(true)}><Plus size={16} stroke-width={1.75} aria-hidden="true" />Create a Silicon</Button>}
                      />
                    </div>
                  </Match>
                  <Match when={silicons.data()}>
                    {list => (
                      <AnimatedRows items={list()} keyOf={item => item.uuid} layout="grid" class={styles.grid} label="Your Silicons">
                        {item => <Tile silicon={item()} now={now()} fresh={fresh() === item().uuid} onOpen={() => open(item().uuid)} />}
                      </AnimatedRows>
                    )}
                  </Match>
                </Switch>
              </Section>

              <SiliconDrawer
                silicon={selected()}
                open={drawerOpen() && !!selected()}
                onOpenChange={setDrawerOpen}
                me={carbon()}
                now={now()}
                onUpdated={update}
                onDeleted={removed}
                reveals={pendingReveals()}
                onReveal={addReveal}
                onRevealDone={dismissReveal}
              />
              <CreateSilicon open={creating()} onOpenChange={setCreating} me={carbon()} onCreated={onCreated} />
            </>
          )}
        </Match>
      </Switch>
    </Page>
  );
}

function Tile(props: { silicon: ManagedSilicon; now: number; fresh: boolean; onOpen: () => void }) {
  const id = () => props.silicon.id ?? props.silicon.uuid;
  const status = () => {
    if (props.silicon.status === "pending_custodian") return { tone: "warning" as const, text: "Waiting for a custodian" };
    if (props.silicon.pending_transfer) return { tone: "info" as const, text: "Transfer pending" };
    return { tone: "success" as const, text: "Active" };
  };
  const transferLeft = () => msUntil(props.silicon.pending_transfer?.expires_at, props.now);
  return (
    <button ref={el => useSquircle(el)} type="button" class={styles.tile} data-silicon={props.silicon.uuid} data-fresh={props.fresh || undefined} onClick={() => props.onOpen()} aria-label={`Manage ${id()}, ${props.silicon.display_name}`}>
      <span class={styles.tileTop}>
        <Avatar name={props.silicon.display_name} src={props.silicon.pfp_url} size="lg" kind="silicon" />
        <Badge size="sm" tone={status().tone} dot={status().tone === "success"}>{status().text}</Badge>
      </span>
      <span class={styles.tileText}>
        <span class={styles.tileName}>{props.silicon.display_name}</span>
        <TextMorph class={styles.tileId}>{id()}</TextMorph>
      </span>
      <span class={styles.tileFacts}>
        <span class={styles.tileFact}>
          <span class={styles.tileLabel}>STK</span>
          <span class={styles.tileValue}>{props.silicon.stk_rotated_at ? `rotated ${formatRelative(props.silicon.stk_rotated_at, props.now)}` : "never rotated"}</span>
        </span>
        <span class={styles.tileFact}>
          <span class={styles.tileLabel}>Webhook</span>
          <span class={styles.tileValue}>{host(props.silicon.webhook_url) ?? "not set"}</span>
        </span>
      </span>
      <Show when={props.silicon.pending_transfer}>
        {transfer => (
          <span class={styles.tileNote}>
            Waiting for {personLabel(transfer().to)} to accept{transferLeft() > 0 ? `, ${spanText(transferLeft())} left` : ""}
          </span>
        )}
      </Show>
    </button>
  );
}

function TilesSkeleton() {
  return (
    <div class={styles.grid} aria-busy="true" aria-label="Loading your Silicons">
      <For each={[0, 1, 2]}>{index => <SkeletonBlock width="100%" height="212px" radius="var(--radius-surface)" index={index} />}</For>
    </div>
  );
}
