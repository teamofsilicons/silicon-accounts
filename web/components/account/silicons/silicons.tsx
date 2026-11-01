"use client";

/**
 * /silicons, redesigned from scratch (Anil, 2026-11-01, layout B: cards, then a page per Silicon). The Silicons the
 * Carbon is custodian of, in Home's family:
 *
 * - the page heading, "Silicons", with Add a Silicon once there are some (create one here, at /silicons/new, start from
 *   a Starter, or copy your c:id for a Silicon to name you); a new Silicon's STK is shown once on its page, and stays
 *   here too until the Carbon says it is stored;
 * - Waiting for you: custodian requests and handovers, the same rows as Home's Needs you (home-needs.tsx);
 * - Your Silicons: one card per Silicon in its own colour pair (its mark's), with its name, si:id and when its key
 *   last changed, opening its page (/silicons/[uuid], silicon-page.tsx); then a New Silicon card. With none, the first
 *   visit (silicons-intro.tsx): what a Silicon is, what it gets, and the three ways to add one.
 */
import { useEffect, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, AtSign, Cpu, Plus, Sparkle } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { DropdownMenu } from "@teamofsilicons/silicon-ui/dropdown-menu";
import { EmptyState } from "@teamofsilicons/silicon-ui/empty-state";
import { SkeletonBlock } from "@/components/foundation/feedback/skeleton-block";
import { Page, PageHeader } from "@/components/foundation/layout/layout";
import type { ManagedSilicon } from "@/lib/api/types";
import { useRegisterCommands } from "@/lib/commands";
import { formatRelative } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { notify } from "@/lib/notify";
import { useMe } from "@/lib/query/session";
import { SiliconRequests } from "../home-needs";
import { NEW_SILICON_PARAM } from "../parts/anchors";
import { asCarbon, asSilicon, describeError, personLabel, stkRotatedAt, useNow } from "../parts/common";
import { handFocus, pageMain } from "../parts/focus";
import { ListCap } from "../parts/list-cap";
import { useEverySilicon } from "../parts/queries";
import { dismissReveal, usePendingReveals, type Reveal } from "../parts/reveals";
import { SecretReveal } from "../parts/secret-reveal";
import { pairOf } from "../parts/silicon-mark";
import { STARTER_URL, SiliconsIntro } from "./silicons-intro";
import styles from "./silicons.module.css";

/** Creating a Silicon: its own page (Anil, 2026-11-01: a page, not a side panel). */
export const NEW_SILICON_HREF = `${paths.silicons}/new`;

/** A Silicon's own page, by uuid (by its si:id in the one case its uuid would read as /silicons/new). */
export const siliconHref = (silicon: Pick<ManagedSilicon, "uuid" | "id">) =>
  `${paths.silicons}/${encodeURIComponent(silicon.uuid === "new" && silicon.id ? silicon.id : silicon.uuid)}`;

/** Where focus goes when nothing more specific is left: the first card, else New Silicon. */
const fallbackFocus = () => pageMain()?.querySelector<HTMLElement>("[data-silicon-card]") ?? pageMain()?.querySelector<HTMLElement>("[data-create-silicon]");

export function Silicons() {
  const me = useMe();
  const silicons = useEverySilicon();
  const reveals = usePendingReveals();
  const now = useNow(30_000);
  const params = useSearchParams();
  const router = useRouter();
  const create = () => router.push(NEW_SILICON_HREF);
  const carbon = asCarbon(me.data);
  const silicon = asSilicon(me.data);

  useRegisterCommands(() => (carbon ? [
    { id: "silicons.create", label: "Create a Silicon", description: "You become its custodian; its STK is shown once", group: "Silicons", icon: <Plus size={16} strokeWidth={1.75} />, keywords: ["new", "silicon", "agent", "stk"], run: create },
  ] : []), [!!carbon]);

  // Older links come with ?new (the create panel this page used to open): they go to the create page now.
  const wantsNew = params.has(NEW_SILICON_PARAM);
  useEffect(() => {
    if (wantsNew) router.replace(NEW_SILICON_HREF);
  }, [wantsNew, router]);

  /** "I've stored it": the next secret waiting, else the first card. */
  const stored = (reveal: Reveal) => {
    dismissReveal(reveal.id);
    handFocus(pageMain(), () => pageMain()?.querySelector<HTMLElement>("[data-page-reveals] [data-reveal] h2") ?? fallbackFocus());
  };

  const list = silicons.data?.items ?? [];
  return (
    <Page
      header={(
        <PageHeader
          title="Silicons"
          actions={carbon && list.length ? <AddSilicon carbonId={carbon.id} onCreate={create} /> : null}
        />
      )}
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
        <CardsSkeleton />
      ) : (
        <>
          {reveals.length ? (
            <div className={styles.reveals} data-page-reveals="">
              {reveals.map(reveal => <SecretReveal key={reveal.id} revealId={reveal.id} title={reveal.title} description={reveal.description} secrets={reveal.secrets} onDone={() => stored(reveal)} focusOnMount />)}
            </div>
          ) : null}

          <SiliconRequests />

          {silicons.data && list.length === 0 ? (
            <SiliconsIntro carbonId={carbon.id} onCreate={create} />
          ) : (
          <section className={styles.section} aria-labelledby="your-silicons">
            <h2 id="your-silicons" className={styles.sectionTitle}>Your Silicons</h2>
            {silicons.error && !silicons.data ? (
              <Alert tone="danger" title="Your Silicons did not load">
                {describeError(silicons.error)}
                <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void silicons.refetch()}>Try again</Button></span>
              </Alert>
            ) : !silicons.data ? (
              <CardsSkeleton />
            ) : (
              <ul className={styles.cards}>
                {list.map(item => <li key={item.uuid}><SiliconCard silicon={item} now={now} /></li>)}
                <li>
                  <Link href={NEW_SILICON_HREF} data-sq="surface" className={styles.newCard}>
                    <span data-sq="surface" className={styles.newPlus} aria-hidden="true"><Plus size={20} strokeWidth={1.75} /></span>
                    <span className={styles.newLabel}>New Silicon</span>
                  </Link>
                </li>
              </ul>
            )}
            <ListCap page={silicons.data} noun="Silicons" command="silicon-accounts silicon list" />
          </section>
          )}
        </>
      )}
    </Page>
  );
}

/**
 * Add a Silicon, once there are some (Anil, 2026-11-01): the first visit's three ways in a menu. Create one here (the
 * create panel), start from a Starter (Silicon Starter, in a new tab), or let a Silicon ask you (copies your c:id to
 * share).
 */
function AddSilicon({ carbonId, onCreate }: { carbonId: string | null; onCreate: () => void }) {
  const copyId = async () => {
    if (!carbonId) return;
    try {
      await navigator.clipboard.writeText(carbonId);
      notify.success(`Copied ${carbonId}`, "Share it with a Silicon; its request will show here.");
    } catch {
      notify.error(new Error("Your browser did not allow copying."), "Couldn't copy your id");
    }
  };
  return (
    <DropdownMenu
      label="Add a Silicon"
      icon={<Plus size={16} strokeWidth={1.75} />}
      items={[
        { label: "Create one here", icon: <Plus size={16} strokeWidth={1.75} />, onSelect: onCreate },
        { label: "Start from a Starter", icon: <ArrowUpRight size={16} strokeWidth={1.75} />, onSelect: () => window.open(STARTER_URL, "_blank", "noopener") },
        ...(carbonId ? [{ label: "Copy your id for a Silicon", icon: <AtSign size={16} strokeWidth={1.75} />, onSelect: () => void copyId() }] : []),
      ]}
    />
  );
}

/**
 * One Silicon as a card in its own colour pair (its mark's, picked from its uuid), deepened at the top left so its
 * words read in white: its name, its si:id, and when its key last changed; a status when it is not simply active. The
 * Silicon spark stands at the lower right. The whole card opens its page.
 */
function SiliconCard({ silicon, now }: { silicon: ManagedSilicon; now: number }) {
  const pair = pairOf(silicon.uuid);
  const style = { "--card-from": `var(--silicon-mark-${pair}-from)`, "--card-to": `var(--silicon-mark-${pair}-to)` } as CSSProperties;
  const rotated = stkRotatedAt(silicon);
  const status = silicon.status === "pending_custodian" ? "Waiting for a custodian"
    : silicon.pending_transfer ? `Handing over to ${personLabel(silicon.pending_transfer.to)}`
      : null;
  return (
    <Link href={siliconHref(silicon)} data-sq="clip" data-silicon-card="" className={styles.card} style={style}>
      <Sparkle className={styles.cardSpark} fill="currentColor" strokeWidth={1} aria-hidden="true" />
      <span className={styles.cardName}>{silicon.display_name || silicon.id || "A Silicon"}</span>
      {silicon.id ? <span className={styles.cardId}>{silicon.id}</span> : null}
      <span className={styles.cardFoot}>
        {status ? <span className={styles.cardStatus}>{status}</span> : null}
        <span className={styles.cardFact}>{rotated ? `Key changed ${formatRelative(rotated, now)}` : "Key never changed"}</span>
      </span>
    </Link>
  );
}

function CardsSkeleton() {
  return (
    <div className={styles.cards} aria-busy="true" aria-label="Loading your Silicons">
      {[0, 1, 2].map(index => <SkeletonBlock key={index} width="100%" height="168px" radius="var(--radius-container)" index={index} />)}
    </div>
  );
}
