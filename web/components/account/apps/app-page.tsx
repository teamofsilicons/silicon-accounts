"use client";

/**
 * /apps/[id], one connected app, as the prototype draws it (Anil, 2026-11-11): the page bar (Connected apps above the
 * app's name, Open beside it), where it lives and since when, who uses it, what it can see about you, where it also acts
 * for you (proof-rows.tsx, each with Stop), and removing its access. Stop and Remove ask first in a dialog (the dialog rules,
 * redesign/decisions.md). Built on parts/rows.tsx, as Security is.
 *
 * Not shown, because the API has no way to do it yet (prototype-differences.md): your Silicons that use the app (the
 * prototype lists them under Who uses it), and switching an optional detail off (the prototype's switches).
 */
import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Cake, Clock, LayoutGrid, Mail, Phone, UserRound } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { ButtonLink } from "@teamofsilicons/silicon-ui/button-link";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { EmptyState } from "@teamofsilicons/silicon-ui/empty-state";
import { Skeleton } from "@teamofsilicons/silicon-ui/skeleton";
import { Page } from "@/components/foundation/layout/layout";
import type { Me, MyApp, MyProof, Scope } from "@/lib/api/types";
import { formatDate, formatPhone, formatRelative, plural } from "@/lib/format";
import { paths } from "@/lib/navigation";
import { useMe } from "@/lib/query/session";
import { timezoneLabel } from "@/lib/timezones";
import { AppMark } from "../parts/app-mark";
import { withAppIcon } from "../parts/app-icons";
import { asCarbon, describeError, useNow } from "../parts/common";
import { PageBar } from "../parts/page-bar";
import { useEveryApp, useEveryProof, useRemoveAccess } from "../parts/queries";
import { Row, Section, Strong, Tile } from "../parts/rows";
import { ActiveProofRow } from "./proof-rows";
import styles from "./apps.module.css";

const host = (url: string | null) => {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

/** One detail an app can see: its icon, what it is, and the value it gets. Data & privacy names them too. */
export function seen(scope: Scope, me: Me | undefined): { icon: ReactNode; label: string; value: string | null } | null {
  const carbon = asCarbon(me);
  switch (scope) {
    case "email":
      return { icon: <Mail size={16} strokeWidth={2} />, label: "Email", value: carbon?.emails.find(item => item.is_primary)?.email ?? null };
    case "phone": {
      const phone = carbon?.phones.find(item => item.is_primary)?.phone;
      return { icon: <Phone size={16} strokeWidth={2} />, label: "Phone number", value: phone ? formatPhone(phone) : null };
    }
    case "dob":
      return { icon: <Cake size={16} strokeWidth={2} />, label: "Date of birth", value: me?.dob ? formatDate(me.dob) : null };
    case "timezone":
      return { icon: <Clock size={16} strokeWidth={2} />, label: "Timezone", value: me ? timezoneLabel(me.timezone) : null };
    default:
      return null;
  }
}

export function AppPage({ appId }: { appId: string }) {
  const apps = useEveryApp();
  const proofs = useEveryProof();
  const me = useMe();
  const now = useNow(30_000);
  const item = apps.data?.items.find(entry => entry.app.app_id === appId);
  const title = item?.app.name ?? "App";
  const home = item?.app.homepage_url ?? null;

  return (
    <div>
      <PageBar
        parent={{ label: "Connected apps", href: paths.apps }}
        title={title}
        actions={item && home && item.status !== "access_removed" ? (
          <ButtonLink href={home} variant="secondary" size="sm" target="_blank" rel="noopener">
            Open<ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
          </ButtonLink>
        ) : undefined}
      />
      <Page>
        {apps.error && !apps.data ? (
          <Alert tone="danger" title="This app did not load">
            {describeError(apps.error)}
            <span className={styles.alertAction}><Button variant="secondary" size="sm" onClick={() => void apps.refetch()}>Try Again</Button></span>
          </Alert>
        ) : !apps.data ? (
          <div className={styles.skeleton} aria-busy="true" aria-label="Loading the app"><Skeleton label="Loading" lines={6} avatar /></div>
        ) : !item ? (
          <EmptyState
            icon={<LayoutGrid width={24} height={24} strokeWidth={1.5} />}
            title="This app isn’t connected"
            description="You haven’t signed in to it, or it was removed."
            action={<ButtonLink href={paths.apps} variant="secondary" size="sm">Connected Apps</ButtonLink>}
          />
        ) : (
          <AppDetails item={item} me={me.data} now={now} proofs={(proofs.data?.items ?? []).filter(proof => proof.status === "active" && proof.issuing_app.app_id === appId)} />
        )}
      </Page>
    </div>
  );
}

function AppDetails({ item, me, now, proofs }: { item: MyApp; me: Me | undefined; now: number; proofs: MyProof[] }) {
  const app = item.app;
  const removed = item.status === "access_removed";
  const imported = item.status === "imported";
  const since = item.first_signed_in_at ? `Since ${formatDate(item.first_signed_in_at)}` : null;
  const place = host(app.homepage_url) ?? app.app_id;
  const details = item.granted_scopes.map(scope => seen(scope, me)).filter((row): row is NonNullable<ReturnType<typeof seen>> => !!row);

  return (
    <>
      <div className={styles.intro}>
        <AppMark app={withAppIcon(app)} size={40} className={styles.mark} decorative />
        <span className={styles.introText}>
          <span className={styles.introTitle}>{place}</span>
          {since ? <span className={styles.introLine}>{since}</span> : null}
        </span>
      </div>

      <Section id="app-who" title="Who uses it">
        <Row
          lead={<Avatar name={me?.display_name ?? "You"} src={me?.pfp_url ?? undefined} size="sm" />}
          title="You"
          detail={removed ? <>Access removed{item.access_removed_at ? <> <Strong>{formatDate(item.access_removed_at)}</Strong></> : null}</>
            : imported ? `${app.name} imported you. You haven’t signed in yet.`
              : item.last_signed_in_at
                ? <>Signed in <Strong>{formatRelative(item.last_signed_in_at, now)}</Strong>{item.active_sessions ? <> · {plural(item.active_sessions, "active session")}</> : null}</>
                : "You haven’t signed in yet"}
        />
      </Section>

      {removed ? (
        <Section id="app-sees" title="What it can see about you">
          <Row lead={<Tile><UserRound size={16} strokeWidth={2} /></Tile>} title="Nothing" detail="Sign in to it again to give it access." />
        </Section>
      ) : (
        <Section id="app-sees" title="What it can see about you">
          <Row
            lead={<Tile><UserRound size={16} strokeWidth={2} /></Tile>}
            title="Name, photo and CarbonID"
            detail={me ? <>{me.display_name}{me.id ? <> · {me.id}</> : null}</> : "Every app sees these"}
          >
            <Badge size="sm" tone="neutral">Always</Badge>
          </Row>
          {details.map(detail => (
            <Row key={detail.label} lead={<Tile>{detail.icon}</Tile>} title={detail.label} detail={detail.value ?? "Not added yet"} />
          ))}
        </Section>
      )}

      {!removed && proofs.length ? (
        <Section id="app-acts" title="Also acts for you">
          {proofs.map(proof => <ActiveProofRow key={proof.proof_id} proof={proof} own />)}
        </Section>
      ) : null}

      {!removed ? <RemoveRow item={item} proofs={proofs.length} /> : null}
    </>
  );
}

/** Removing the app's access for you, asked first; your Silicons keep their own access to it. */
function RemoveRow({ item, proofs }: { item: MyApp; proofs: number }) {
  const remove = useRemoveAccess();
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = item.app.name;
  const confirm = async () => {
    setError(null);
    try {
      await remove.mutateAsync(item.app.app_id);
      setAsking(false);
      router.push(paths.apps);
    } catch (raw) {
      setError(describeError(raw));
    }
  };
  return (
    <Section id="app-remove" label={`Remove ${name}`}>
      <Row lead={null} title={`Remove ${name} for you`} detail="Your Silicons keep their own access">
        <Button variant="danger" size="sm" onClick={() => setAsking(true)}>Remove</Button>
        <Dialog open={asking} onOpenChange={open => { if (!open && !remove.isPending) setAsking(false); }}>
          <DialogContent
            title={`Remove ${name}’s access?`}
            description={<>You&rsquo;ll be signed out of <strong>{name}</strong> everywhere, and it can no longer see your details.{proofs ? <> {plural(proofs, "permission")} to act for you {proofs === 1 ? "ends" : "end"} too.</> : null}</>}
          >
            <p className={styles.note}><span className={styles.noteLabel}>Note:</span> Your Silicons keep their own access to {name}.</p>
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <div className={styles.actions}>
              <Button variant="ghost" onClick={() => setAsking(false)} disabled={remove.isPending}>Cancel</Button>
              <Button variant="danger" loading={remove.isPending} onClick={() => void confirm()}>Remove Access</Button>
            </div>
          </DialogContent>
        </Dialog>
      </Row>
    </Section>
  );
}
