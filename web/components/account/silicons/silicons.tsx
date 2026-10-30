"use client";

/**
 * /silicons: the Silicons you are custodian of. Requests waiting for you sit on top as a deck (a Silicon asking you to
 * be its custodian, or a Carbon handing one to you). Each Silicon is a tile; open one to change its details or id,
 * rotate its STK, set its webhook, hand it to another Carbon or delete it. Creating a Silicon shows its generated STK
 * exactly once, in a card that stays until you say you stored it.
 */
import { useEffect, useState } from "react";
import { Cpu, Plus } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { EmptyState } from "@teamofsilicons/silicon-ui/empty-state";
import { TextMorph } from "@teamofsilicons/silicon-ui/text-morph";
import { ButtonLink } from "@/components/foundation/button-link";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, PageHeader, Section } from "@/components/foundation/layout/layout";
import type { ManagedSilicon, SiliconCreated } from "@/lib/api/types";
import { useRegisterCommands } from "@/lib/commands";
import { paths } from "@/lib/navigation";
import { formatRelative, plural } from "@/lib/format";
import { useMe } from "@/lib/query/session";
import { NEEDS_YOU_ID, NEW_SILICON_PARAM } from "../parts/anchors";
import { AnimatedRows } from "../parts/animated-rows";
import { asCarbon, asSilicon, describeError, msUntil, personLabel, spanText, stkRotatedAt, useNow } from "../parts/common";
import { handFocus, pageMain } from "../parts/focus";
import { ListCap } from "../parts/list-cap";
import { useEveryCustodianRequest, useEverySilicon } from "../parts/queries";
import { addReveal, dismissReveal, dismissRevealsOf, usePendingReveals, type Reveal } from "../parts/reveals";
import { SecretReveal } from "../parts/secret-reveal";
import { stkSecret } from "../parts/stk";
import { CreateSilicon } from "./create-silicon";
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
  /** What the side column shows: kept while it closes, so the content fades out with it. */
  const [panel, setPanel] = useState<"silicon" | "create">("silicon");
  const [fresh, setFresh] = useState<string | null>(null);
  const carbon = asCarbon(me.data);
  const silicon = asSilicon(me.data);

  const startCreating = () => {
    setPanel("create");
    setDrawerOpen(false);
    setCreating(true);
  };

  useRegisterCommands(() => (carbon ? [
    { id: "silicons.create", label: "Create a Silicon", description: "You become its custodian; its STK is shown once", group: "Silicons", icon: <Plus size={16} strokeWidth={1.75} />, keywords: ["new", "silicon", "agent", "stk"], run: startCreating },
  ] : []), [!!carbon]);

  // Home's "New Silicon" tile links here with ?new: open the create drawer once, and drop the flag from the address.
  useEffect(() => {
    if (!carbon) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has(NEW_SILICON_PARAM)) return;
    url.searchParams.delete(NEW_SILICON_PARAM);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    // Next frame, after the page has painted; not cancelled, since the flag is already gone from the address.
    requestAnimationFrame(() => {
      setPanel("create");
      setCreating(true);
    });
  }, [carbon]);

  const list = silicons.data?.items ?? [];
  const selected = list.find(item => item.uuid === openUuid);
  const open = (uuid: string) => {
    setPanel("silicon");
    setCreating(false);
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
    <Page
      className={styles.page}
      header={(
        <PageHeader
          title="Silicons in your care"
          description="Every Silicon has exactly one custodian, a Carbon who manages its account: its details, its id, its STK and who looks after it next."
          actions={carbon ? (
            <Button data-create-silicon="" onClick={startCreating}>
              <Plus size={16} strokeWidth={1.75} aria-hidden="true" />
              Create a Silicon
            </Button>
          ) : null}
        />
      )}
      panel={carbon ? (panel === "create" ? (
        <CreateSilicon open={creating} onOpenChange={setCreating} me={carbon} onCreated={onCreated} />
      ) : (
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
      )) : undefined}
      panelOpen={panel === "create" ? creating : drawerOpen && !!selected}
    >
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

          {/* Requests are answered in one place, the needs-you block on Home; this page only points there. */}
          {waiting.length ? (
            <Alert tone="info" title={`${plural(waiting.length, "custodian request")} waiting for you`}>
              Answer them on Home, where everything that needs your decision is in one place.
              <span className={styles.alertAction}><ButtonLink href={`${paths.home}#${NEEDS_YOU_ID}`} variant="secondary" size="sm">Answer them</ButtonLink></span>
            </Alert>
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
                  action={<Button variant="secondary" onClick={startCreating}><Plus size={16} strokeWidth={1.75} aria-hidden="true" />Create a Silicon</Button>}
                />
              </div>
            ) : (
              <AnimatedRows items={list} keyOf={item => item.uuid} layout="grid" className={styles.grid} label="Your Silicons">
                {item => <Tile silicon={item} now={now} fresh={fresh === item.uuid} onOpen={() => open(item.uuid)} />}
              </AnimatedRows>
            )}
            <ListCap page={silicons.data} noun="Silicons" command="silicon-accounts silicon list" />
          </Section>

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
