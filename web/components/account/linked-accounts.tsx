"use client";

/**
 * Your Accounts (/linked-accounts, from main's work accounts, 2026-11-03; on the account pages' design 2026-11-13): the
 * personal and work accounts one sign-in reaches, and switching between them. Reached from Personal Info's "Your
 * Accounts" row. The page bar (parts/page-bar.tsx), a lead line, then sections of the account pages' rows
 * (parts/rows.tsx):
 *
 * - Personal and Work: each account with its avatar (a work account's org logo), its id and org, Main or Linked, and
 *   Switch (or "Currently Using" on the one in use).
 * - Account linking requests, when an org asks to link a Silicon's work account: Review Link, then Confirm and Link.
 * - Link another account: sign in to it in a window, then Finish Linking here.
 * - Create your personal account (a Carbon whose only accounts are work ones), or how a Silicon gets one.
 * - Your organizations, in Silicon Organizations.
 *
 * The words and behaviour are main's; only the look moved onto the redesign.
 */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import Image from "next/image";
import { Building2, Cpu, Link2, UserRound } from "lucide-react";
import { Alert } from "@teamofsilicons/silicon-ui/alert";
import { Avatar } from "@teamofsilicons/silicon-ui/avatar";
import { Badge } from "@teamofsilicons/silicon-ui/badge";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Input } from "@teamofsilicons/silicon-ui/input";
import { Skeleton } from "@teamofsilicons/silicon-ui/skeleton";
import { Page } from "@/components/foundation/layout/layout";
import { ApiError } from "@/lib/api/errors";
import type { LinkedAccount } from "@/lib/api/types";
import { paths } from "@/lib/navigation";
import { useMe, useMeta } from "@/lib/query/session";
import {
  useAccountLinkRequests,
  type AccountLinkRequest,
  useLinkedAccountAction,
  useLinkedAccounts,
  useSwitchLinkedAccount,
} from "@/lib/query/linked-accounts";
import { PageBar } from "./parts/page-bar";
import { LinkRow, Row, Section, Tile } from "./parts/rows";
import styles from "./linked-accounts.module.css";

const pendingLinkKey = "silicon-accounts:pending-link";
function savedPendingLink(): string | null {
  try {
    return sessionStorage.getItem(pendingLinkKey);
  } catch {
    return null;
  }
}
function subscribePendingLink(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener("pageshow", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("pageshow", listener);
  };
}
function clearPendingLink() {
  try {
    sessionStorage.removeItem(pendingLinkKey);
  } catch {}
  const url = new URL(window.location.href);
  if (url.searchParams.has("linked")) {
    url.searchParams.delete("linked");
    window.history.replaceState(null, "", url);
  }
}

const icon = (node: ReactNode) => <Tile>{node}</Tile>;

export function LinkedAccountsPage({ completedLink }: { completedLink?: string }) {
  const meta = useMeta();
  const me = useMe();
  const linked = useLinkedAccounts();
  const requests = useAccountLinkRequests();
  const switchAccount = useSwitchLinkedAccount();
  const start = useLinkedAccountAction<{ link_id: string; authorize_url: string }, Record<string, never>>("linked-accounts/link/start");
  const complete = useLinkedAccountAction<unknown, { link_id: string }>("linked-accounts/link/complete");
  const create = useLinkedAccountAction<{ uuid: string }, { id: string }>("personal-account");
  const storedLink = useSyncExternalStore(subscribePendingLink, savedPendingLink, () => null);
  const [chosenLink, setLinkId] = useState<string | null | undefined>(completedLink);
  const linkId = chosenLink === undefined ? storedLink : chosenLink;
  const [handle, setHandle] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const accounts = linked.data?.accounts ?? [];
  const hasPersonal = accounts.some(account => !account.org);
  const orgsUrl = meta.data?.organizations_url ?? "https://organizations.teamofsilicons.com";

  const beginLink = async () => {
    // Open synchronously so browsers don't block the authentication window after the network round trip.
    const popup = window.open("about:blank", "silicon-account-link", "popup,width=600,height=780");
    try {
      setError(null);
      const result = await start.mutateAsync({});
      const url = new URL(result.authorize_url, window.location.origin);
      if (url.origin !== window.location.origin) throw new Error("The account linking address must belong to Silicon Accounts.");
      setLinkId(result.link_id);
      try {
        sessionStorage.setItem(pendingLinkKey, result.link_id);
      } catch {}
      if (popup) popup.location.href = url.toString();
      else window.location.assign(url.toString());
    } catch (failure) {
      popup?.close();
      setError(ApiError.from(failure));
    }
  };
  const finishLink = async () => {
    if (!linkId) return;
    try {
      setError(null);
      await complete.mutateAsync({ link_id: linkId });
      setLinkId(null);
      clearPendingLink();
      setMessage("Your accounts are linked. Their apps, history and details stay separate.");
      await linked.refetch();
    } catch (failure) {
      setError(ApiError.from(failure));
    }
  };
  const switchTo = async (uuid: string) => {
    try {
      setError(null);
      setSwitching(uuid);
      await switchAccount.mutateAsync({ account_uuid: uuid });
      clearPendingLink();
      window.location.assign(new URL(paths.linkedAccounts, window.location.origin).toString());
    } catch (failure) {
      setSwitching(null);
      setError(ApiError.from(failure));
    }
  };
  const problem = error ?? linked.error ?? requests.error;

  const accountRow = (account: LinkedAccount) => {
    const current = account.uuid === me.data?.uuid;
    return (
      <Row
        key={account.uuid}
        lead={account.org?.logo_url ? (
          <Image src={account.org.logo_url} width={28} height={28} alt="" unoptimized data-sq="surface" className={styles.logo} />
        ) : (
          <Avatar name={account.display_name} src={account.pfp_url || undefined} size="sm" />
        )}
        title={account.display_name}
        detail={<><span className="mono">{account.id ?? account.uuid}</span>{account.org ? ` · ${account.org.name}` : ""} · {account.is_main ? "Main account" : "Linked account"}</>}
      >
        {current ? (
          <Badge size="sm" tone="neutral">Currently Using</Badge>
        ) : (
          <Button variant="secondary" size="sm" loading={switching === account.uuid} disabled={!!switching && switching !== account.uuid} onClick={() => void switchTo(account.uuid)}>Switch</Button>
        )}
      </Row>
    );
  };

  return (
    <div>
      <PageBar parent={{ label: "Personal Info", href: paths.personal }} title="Your Accounts" />
      <Page>
        <p className={styles.lead}>One sign-in, separate accounts. Your orgs only see the work accounts that belong to them.</p>
        {problem ? (
          <div className={styles.alert}>
            <Alert tone="danger" title="This could not be completed">{problem.message} {problem.hint}</Alert>
          </div>
        ) : null}
        {message ? (
          <div className={styles.alert}>
            <Alert tone="success" title="Accounts linked">{message}</Alert>
          </div>
        ) : null}
        {!linked.data ? (
          linked.error ? null : <div className={styles.skeleton} aria-busy="true" aria-label="Loading your accounts"><Skeleton label="Loading" lines={4} avatar /></div>
        ) : (
          <>
            <Section id="accounts-personal" title="Personal">
              {accounts.filter(account => !account.org).map(accountRow)}
              {!hasPersonal ? <Row lead={icon(<UserRound size={16} strokeWidth={2} />)} title="You do not have a personal account linked yet." /> : null}
            </Section>
            <Section id="accounts-work" title="Work">
              {accounts.filter(account => account.org).map(accountRow)}
              {!accounts.some(account => account.org) ? <Row lead={icon(<Building2 size={16} strokeWidth={2} />)} title="Work accounts appear here when you join an org." /> : null}
            </Section>
          </>
        )}
        {requests.data?.items.length ? (
          <Section id="accounts-requests" title="Account linking requests" description="A Silicon or its custodian must approve before an org work account can be linked.">
            {requests.data.items.map(item => (
              <LinkRequest key={item.id} request={item} onDone={() => { void requests.refetch(); void linked.refetch(); }} />
            ))}
          </Section>
        ) : null}
        <Section id="accounts-link" title="Link another account" description="Sign in to the other account to prove it is yours. Linking shares no account details with your orgs.">
          {linkId ? (
            <Row
              lead={icon(<Link2 size={16} strokeWidth={2} />)}
              title={completedLink ? "The other account has been verified" : "Finish signing in in the other window"}
              detail={completedLink ? "Confirm to finish linking." : "Then confirm here."}
              wide
            >
              <Button variant="ghost" size="sm" onClick={() => { setLinkId(null); clearPendingLink(); }}>Cancel</Button>
              <Button size="sm" loading={complete.isPending} onClick={() => void finishLink()}>Finish Linking</Button>
            </Row>
          ) : (
            <Row lead={icon(<Link2 size={16} strokeWidth={2} />)} title="Link an account">
              <Button variant="secondary" size="sm" loading={start.isPending} onClick={() => void beginLink()}>Link</Button>
            </Row>
          )}
        </Section>
        {linked.data && !hasPersonal && me.data?.org && me.data.kind === "carbon" ? (
          <Section id="accounts-create" title="Create your personal account" description="It becomes your main account. Your work accounts, their apps and history stay as they are.">
            <li className={styles.formRow}>
              <form
                className={styles.form}
                onSubmit={event => {
                  event.preventDefault();
                  setError(null);
                  void create
                    .mutateAsync({ id: `c:${handle}` })
                    .then(result => switchAccount.mutateAsync({ account_uuid: result.uuid }))
                    .then(() => window.location.assign(new URL(paths.linkedAccounts, window.location.origin).toString()))
                    .catch(failure => setError(ApiError.from(failure)));
                }}
              >
                <Input
                  label="Personal handle"
                  value={handle}
                  onChange={event => setHandle(event.target.value.toLowerCase())}
                  pattern="[a-z0-9_-]{3,30}"
                  minLength={3}
                  maxLength={30}
                  required
                  description="3–30 letters, numbers, hyphens or underscores. Your personal handle has no org suffix."
                />
                <div className={styles.formActions}>
                  <Button type="submit" size="sm" loading={create.isPending || switchAccount.isPending}>Create Personal Account</Button>
                </div>
              </form>
            </li>
          </Section>
        ) : null}
        {linked.data && !hasPersonal && me.data?.org && me.data.kind === "silicon" ? (
          <Section id="accounts-silicon" title="A personal Silicon account">
            <Row
              lead={icon(<Cpu size={16} strokeWidth={2} />)}
              title="It needs its own Carbon custodian"
              detail="After that account is created, link it here with independent sign-in proof, or ask your org admin to send a link request for the custodian to approve."
            />
          </Section>
        ) : null}
        <div className={styles.orgs}>
          <LinkRow href={orgsUrl} lead={icon(<Building2 size={16} strokeWidth={2} />)} title="Manage your organizations" />
        </div>
      </Page>
    </div>
  );
}

function LinkRequest({ request, onDone }: { request: AccountLinkRequest; onDone: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const accept = useLinkedAccountAction<unknown, Record<string, never>>(`linked-accounts/requests/${encodeURIComponent(request.id)}/accept`);
  const decline = useLinkedAccountAction<unknown, Record<string, never>>(`linked-accounts/requests/${encodeURIComponent(request.id)}/decline`);
  const failure = accept.error ?? decline.error;
  return (
    <Row
      lead={icon(<Link2 size={16} strokeWidth={2} />)}
      title={<span className="mono">{request.source.id} → {request.target.id}</span>}
      detail={confirm
        ? "Approve only if both accounts are run by the same Silicon. Their apps and history stay separate."
        : `${request.source.org?.name ?? "Work account"} is asking to link this Silicon’s work account.`}
      error={failure ? `Linking could not be completed. ${failure.message}` : null}
      wide
    >
      <Button variant="ghost" size="sm" loading={decline.isPending} onClick={() => void decline.mutateAsync({}).then(onDone).catch(() => {})}>Decline</Button>
      <Button
        size="sm"
        variant={confirm ? "primary" : "secondary"}
        loading={accept.isPending}
        onClick={() => {
          if (!confirm) {
            setConfirm(true);
            return;
          }
          void accept.mutateAsync({}).then(onDone).catch(() => {});
        }}
      >
        {confirm ? "Confirm and Link" : "Review Link"}
      </Button>
    </Row>
  );
}
