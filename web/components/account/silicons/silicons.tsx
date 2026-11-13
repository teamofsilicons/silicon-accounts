"use client";

/**
 * /silicons, redesigned from scratch (Anil, 2026-11-01, layout B: cards, then a page per Silicon).
 * The Silicons the Carbon is custodian of:
 *
 * - the page bar (page-bar.tsx), "Silicons", with Add a Silicon on its right once there are some (create one here, at /silicons/new, or start
 *   from a Starter); a new Silicon's STK is shown once on its page, and stays
 *   here too until the Carbon says it is stored;
 * - Waiting for you: custodian requests and handovers, the same rows as Home's Needs you (home-needs.tsx);
 * - Your Silicons: a Silicon UI Card per Silicon with its mark, name, si:id and when its key last changed, opening its page
 *   (/silicons/[uuid], silicon-page.tsx); then a New Silicon card. With none, the first
 *   visit (silicons-intro.tsx): what a Silicon is, what it gets, and the three ways to add one.
 */
import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, Cpu, Plus } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuRoot, DropdownMenuTrigger } from "@teamofsilicons/silicon-ui/dropdown-menu";
import { EmptyState } from "@teamofsilicons/silicon-ui/empty-state";
import { Skeleton } from "@teamofsilicons/silicon-ui/skeleton";
import { Page } from "@/components/foundation/layout/layout";
import type { ManagedSilicon } from "@/lib/api/types";
import { useRegisterCommands } from "@/lib/commands";
import { paths } from "@/lib/navigation";
import { useMe } from "@/lib/query/session";
import { SiliconRequests } from "../home-needs";
import { NEW_SILICON_PARAM } from "../parts/anchors";
import { asCarbon, asSilicon, describeError, personLabel } from "../parts/common";
import { handFocus, pageMain } from "../parts/focus";
import { ListCap } from "../parts/list-cap";
import { useEverySilicon } from "../parts/queries";
import { dismissReveal, usePendingReveals, type Reveal } from "../parts/reveals";
import { SecretReveal } from "../parts/secret-reveal";
import { SiliconCard } from "../parts/silicon-card";
import { PageBar } from "../parts/page-bar";
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
    <div>
      <PageBar
        title="Silicons"
        actions={carbon && list.length ? <AddSilicon onCreate={create} /> : null}
      />
      <Page>
        {me.error && !me.data ? (
          <Alert tone="danger" title="Your account did not load">
            {describeError(me.error)}
            <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void me.refetch()}>Try Again</Button></span>
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
                  <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void silicons.refetch()}>Try Again</Button></span>
                </Alert>
              ) : !silicons.data ? (
                <CardsSkeleton />
              ) : (
                <ul className={styles.cards}>
                  {list.map(item => <li key={item.uuid}><SiliconTile silicon={item} /></li>)}
                </ul>
              )}
              <ListCap page={silicons.data} noun="Silicons" command="silicon-accounts silicon list" />
            </section>
            )}
          </>
        )}
      </Page>
    </div>
  );
}

/**
 * Add a Silicon, once there are some (Anil, 2026-11-01): two ways in a menu. Create one here (the create page), or start
 * from a Starter (Silicon Starter, in a new tab).
 */
function AddSilicon({ onCreate }: { onCreate: () => void }) {
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger className={styles.tight}>
        <Plus className={styles.triggerIcon} size={15} strokeWidth={2} aria-hidden="true" />
        Add a Silicon
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem className={styles.tight} icon={<Plus size={15} strokeWidth={2} />} onSelect={onCreate}>Create one here</DropdownMenuItem>
        <DropdownMenuItem className={styles.tight} icon={<ArrowUpRight size={15} strokeWidth={2} />} onSelect={() => window.open(STARTER_URL, "_blank", "noopener")}>Start from a Starter</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenuRoot>
  );
}

/**
 * One Silicon as a tile, as the prototype draws it and as Home does (Anil, 2026-11-12): its mark, its name and si:id,
 * then its status and when its key last changed (or who it is being handed to). The whole tile opens its page.
 */
/** A Silicon as Home draws it (parts/silicon-card.tsx), with a badge for a state worth noticing and who it is handed to. */
function SiliconTile({ silicon }: { silicon: ManagedSilicon }) {
  const status = silicon.status === "pending_custodian" ? { tone: "warning" as const, text: "Waiting for a custodian" }
    : silicon.pending_transfer ? { tone: "info" as const, text: "Handing over" }
      : { tone: "success" as const, text: "Active" };
  // Only a handover gets a line ("to c:shubham"). The key's age was a stand-in for the prototype's last sign-in, which
  // the API doesn't give yet (api-gaps.md #5); it stays on the Silicon's own page (Anil, 2026-11-13).
  const line = silicon.pending_transfer ? `to ${personLabel(silicon.pending_transfer.to)}` : null;
  return <SiliconCard uuid={silicon.uuid} photo={silicon.pfp_url} name={silicon.display_name || silicon.id || "A Silicon"} id={silicon.id} href={siliconHref(silicon)} blend="wash" status={status} detail={line} />;
}

function CardsSkeleton() {
  return (
    <div className={styles.cards} aria-busy="true" aria-label="Loading your Silicons">
      {[0, 1, 2].map(index => <Skeleton key={index} label="Loading" lines={4} />)}
    </div>
  );
}
