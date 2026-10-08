"use client";

/**
 * /silicons: the Silicons you are custodian of. Requests waiting for you sit on top as a deck (a Silicon asking you to
 * be its custodian, or a Carbon handing one to you). Each Silicon is a tile; open one to change its details or id,
 * rotate its STK, set its webhook, hand it to another Carbon or delete it. Creating a Silicon shows its generated STK
 * exactly once, in a card that stays until you say you stored it.
 */
import { useState } from "react";
import { Cpu, Plus } from "lucide-react";
import { Alert } from "@/components/arc/alert/alert";
import { Avatar } from "@/components/arc/avatar/avatar";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { TextMorph } from "@/components/arc/text-morph/text-morph";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, PageHeader, Section } from "@/components/foundation/layout/layout";
import type { ManagedSilicon, SiliconCreated } from "@/lib/api/types";
import { useRegisterCommands } from "@/lib/commands";
import { formatRelative, plural } from "@/lib/format";
import { useMe } from "@/lib/query/session";
import { AnimatedRows } from "../parts/animated-rows";
import { asCarbon, asSilicon, describeError, msUntil, personLabel, spanText, stkRotatedAt, useNow } from "../parts/common";
import { handFocus, pageMain } from "../parts/focus";
import { ListCap } from "../parts/list-cap";
import { useEveryCustodianRequest, useEverySilicon, type Decision } from "../parts/queries";
import { addReveal, dismissReveal, dismissRevealsOf, usePendingReveals, type Reveal } from "../parts/reveals";
import { SecretReveal } from "../parts/secret-reveal";
import { stkSecret } from "../parts/stk";
import { CreateSilicon } from "./create-silicon";
import { RequestDeck } from "./request-deck";
import { SiliconDrawer } from "./silicon-drawer";
import styles from "./silicons.module.css";

const host = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** A Silicon's tile, to hand focus to (its button is named "Manage si:…"); never one that is leaving. */
const tileOf = (uuid: string) => pageMain()?.querySelector<HTMLElement>(`[role="listitem"]:not([data-leaving]) [data-silicon="${CSS.escape(uuid)}"]`);
/** The control to fall back on when nothing more specific is left: the first tile, else Create a Silicon. */
const fallbackFocus = () => pageMain()?.querySelector<HTMLElement>('[role="listitem"]:not([data-leaving]) [data-silicon]') ?? pageMain()?.querySelector<HTMLElement>("[data-create-silicon]");
/** The "Your Silicons" section (focusable by script), where focus lands when the request deck has gone. */
const siliconsSection = () => pageMain()?.querySelector<HTMLElement>("[data-your-silicons]");
/** Ids longer than this wrap on the tile instead of morphing on one line (a 30-character handle overflows a phone). */
const LONG_ID = 18;

export function Silicons() {
  const me = useMe();
  const silicons = useEverySilicon();
  const requests = useEveryCustodianRequest();
  const reveals = usePendingReveals();
  const now = useNow(30_000);
  const [creating, setCreating] = useState(false);
  const [openUuid, setOpenUuid] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const carbon = asCarbon(me.data);
  const silicon = asSilicon(me.data);

  useRegisterCommands(() => (carbon ? [
    { id: "silicons.create", label: "Create a Silicon", description: "You become its custodian; its STK is shown once", group: "Silicons", icon: <Plus size={16} strokeWidth={1.75} />, keywords: ["new", "silicon", "agent", "stk"], run: () => setCreating(true) },
  ] : []), [!!carbon]);

  const list = silicons.data?.items ?? [];
  const selected = list.find(item => item.uuid === openUuid);
  const open = (uuid: string) => {
    setOpenUuid(uuid);
    setDrawerOpen(true);
  };
  const deleted = (uuid: string) => {
    dismissRevealsOf(uuid);
    // The drawer gave focus back to this Silicon's tile, which has just gone.
    handFocus(pageMain(), fallbackFocus);
  };
  /** "I've stored it" on the page: the next secret waiting, else the Silicon it was for, else the first tile. */
  const stored = (reveal: Reveal) => {
    dismissReveal(reveal.id);
    handFocus(pageMain(), () => pageMain()?.querySelector<HTMLElement>("[data-page-reveals] [data-reveal] h2") ?? tileOf(reveal.silicon) ?? fallbackFocus());
  };
  // Secrets of the Silicon open in the drawer show there; every other one shows on the page.
  const pageReveals = reveals.filter(item => !(drawerOpen && item.silicon === openUuid));

  /**
   * The last request was answered and the deck has gone with the focus it had: an accepted Silicon's tile takes it (once
   * the list has it), else the start of "Your Silicons".
   */
  const deckEmptied = (siliconUuid: string, decision: Decision) => {
    handFocus(pageMain(), () => (decision === "accept" ? tileOf(siliconUuid) : null) ?? siliconsSection() ?? fallbackFocus());
  };

  const onCreated = (created: SiliconCreated) => {
    const item = created.silicon;
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

  const waiting = requests.data?.items ?? [];
  return (
    <Page>
      <PageHeader
        title="Silicons in your care"
        description="Every Silicon has exactly one custodian, a Carbon who manages its account: its details, its id, its STK and who looks after it next."
        actions={carbon ? (
          <Button data-create-silicon="" onClick={() => setCreating(true)}>
            <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
            Create a Silicon
          </Button>
        ) : null}
      />
      {me.error && !me.data ? (
        <Alert tone="danger" title="Your account did not load">
          {describeError(me.error)}
          <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void me.refetch()}>Try again</Button></span>
        </Alert>
      ) : silicon ? (
        <EmptyState
          icon={<Cpu width={24} height={24} strokeWidth={1.5} />}
          title="Only Carbons can be custodians"
          description={`${silicon.id ?? "This Silicon"} is looked after by ${silicon.custodian?.id ?? "its custodian"}. Silicons do not look after other Silicons.`}
        />
      ) : !carbon ? (
        <TilesSkeleton />
      ) : (
        <>
          {pageReveals.length ? (
            <div className={styles.reveals} data-page-reveals="">
              {pageReveals.map(reveal => <SecretReveal key={reveal.id} revealId={reveal.id} title={reveal.title} description={reveal.description} secrets={reveal.secrets} onDone={() => stored(reveal)} focusOnMount />)}
            </div>
          ) : null}

          {requests.error && !requests.data ? (
            <Section title="Waiting for you">
              <Alert tone="danger" title="Requests waiting for you did not load">
                {describeError(requests.error)} A Silicon asking you to be its custodian, or a Carbon handing one to you, has 14 days before the request expires.
                <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void requests.refetch()}>Try again</Button></span>
              </Alert>
            </Section>
          ) : waiting.length ? (
            <Section title="Waiting for you" description="Each request lasts 14 days. A declined Silicon's account is released; a declined transfer changes nothing.">
              <RequestDeck requests={waiting} now={now} onEmptied={deckEmptied} />
            </Section>
          ) : null}

          <Section title="Your Silicons" description={silicons.data && list.length ? `${plural(list.length, "Silicon")}. Open one to manage it.` : undefined} data-your-silicons="" tabIndex={-1} className={styles.section}>
            {silicons.error && !silicons.data ? (
              <Alert tone="danger" title="Your Silicons did not load">
                {describeError(silicons.error)}
                <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void silicons.refetch()}>Try again</Button></span>
              </Alert>
            ) : !silicons.data ? (
              <TilesSkeleton />
            ) : list.length === 0 ? (
              <div data-sq="surface" className={styles.empty}>
                <EmptyState
                  icon={<Cpu width={24} height={24} strokeWidth={1.5} />}
                  title="No Silicons yet"
                  description="Create one and you become its custodian. A Silicon can also create its own account and name you; its request then waits for you here."
                  action={<Button variant="secondary" onClick={() => setCreating(true)}><Plus size={16} strokeWidth={1.75} aria-hidden="true" />Create a Silicon</Button>}
                />
              </div>
            ) : (
              <AnimatedRows items={list} keyOf={item => item.uuid} layout="grid" className={styles.grid} label="Your Silicons">
                {item => <Tile silicon={item} now={now} fresh={fresh === item.uuid} onOpen={() => open(item.uuid)} />}
              </AnimatedRows>
            )}
            <ListCap page={silicons.data} noun="Silicons" command="silicon-accounts silicon list" />
          </Section>

          <SiliconDrawer
            silicon={selected}
            open={drawerOpen && !!selected}
            onOpenChange={setDrawerOpen}
            me={carbon}
            now={now}
            reveals={reveals}
            onReveal={addReveal}
            onRevealDone={dismissReveal}
            onDeleted={deleted}
            focusOnClose={uuid => tileOf(uuid) ?? fallbackFocus()}
          />
          <CreateSilicon open={creating} onOpenChange={setCreating} me={carbon} onCreated={onCreated} />
        </>
      )}
    </Page>
  );
}

function Tile({ silicon, now, fresh, onOpen }: { silicon: ManagedSilicon; now: number; fresh: boolean; onOpen: () => void }) {
  const id = silicon.id ?? silicon.uuid;
  const status = silicon.status === "pending_custodian" ? { tone: "warning" as const, text: "Waiting for a custodian" }
    : silicon.pending_transfer ? { tone: "info" as const, text: "Transfer pending" }
      : { tone: "success" as const, text: "Active" };
  const transferLeft = msUntil(silicon.pending_transfer?.expires_at, now);
  const rotated = stkRotatedAt(silicon);
  // The tile is one target, but its button holds only the words that name it: the id and the display name, read as
  // "Manage si:scout, Scout" (shown name first, id below, by CSS). Every word the button shows is part of its name
  // (WCAG 2.5.3); the status and the facts are the tile's own text, outside the button, and its ::before stretches over
  // the whole tile so a click anywhere on it opens the Silicon.
  return (
    <div data-sq="surface" className={styles.tile} data-fresh={fresh || undefined}>
      <span className={styles.tileTop}>
        <Avatar name={silicon.display_name} src={silicon.pfp_url} size="lg" />
        <Badge size="sm" tone={status.tone}>{status.text}</Badge>
      </span>
      <button type="button" className={styles.tileOpen} data-silicon={silicon.uuid} onClick={onOpen} aria-label={`Manage ${id}, ${silicon.display_name}`}>
        {/* A short id morphs when it changes; a long one wraps rather than being cut off at the tile's edge. The space
            keeps the id and the name two words apart for anything that reads the button's text (it never renders). */}
        {id.length > LONG_ID ? <span className={styles.tileIdWrap}>{id}</span> : <TextMorph className={styles.tileId}>{id}</TextMorph>}
        {" "}
        <span className={styles.tileName} title={silicon.display_name}>{silicon.display_name}</span>
      </button>
      <span className={styles.tileFacts}>
        <span className={styles.tileFact}>
          <span className={styles.tileLabel}>STK</span>
          <span className={styles.tileValue}>{rotated ? `rotated ${formatRelative(rotated, now)}` : "never rotated"}</span>
        </span>
        <span className={styles.tileFact}>
          <span className={styles.tileLabel}>Webhook</span>
          <span className={styles.tileValue}>{host(silicon.webhook_url) ?? "not set"}</span>
        </span>
      </span>
      {silicon.pending_transfer ? (
        <span className={styles.tileNote}>
          Waiting for {personLabel(silicon.pending_transfer.to)} to accept{transferLeft > 0 ? `, ${spanText(transferLeft)} left` : ""}
        </span>
      ) : null}
    </div>
  );
}

function TilesSkeleton() {
  return (
    <div className={styles.grid} aria-busy="true" aria-label="Loading your Silicons">
      {[0, 1, 2].map(index => <SkeletonBlock key={index} width="100%" height="212px" radius="var(--radius-surface)" index={index} />)}
    </div>
  );
}
