"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Building2, Link2, UserRound } from "lucide-react";
import {
  Page,
  PageHeader,
  Section,
} from "@/components/foundation/layout/layout";
import { Alert } from "@/components/silicon-ui/alert/alert";
import { Button } from "@/components/silicon-ui/button/button";
import { Input } from "@/components/silicon-ui/input/input";
import { ApiError } from "@/lib/api/errors";
import { useMe, useMeta } from "@/lib/query/session";
import {
  useAccountLinkRequests,
  type AccountLinkRequest,
  useLinkedAccountAction,
  useLinkedAccounts,
  useSwitchLinkedAccount,
} from "@/lib/query/linked-accounts";
import styles from "./linked-accounts.module.css";

export function LinkedAccountsPage({
  completedLink,
}: {
  completedLink?: string;
}) {
  const meta = useMeta();
  const me = useMe();
  const linked = useLinkedAccounts();
  const requests = useAccountLinkRequests();
  const switchAccount = useSwitchLinkedAccount();
  const start = useLinkedAccountAction<
    { link_id: string; authorize_url: string },
    Record<string, never>
  >("linked-accounts/link/start");
  const complete = useLinkedAccountAction<unknown, { link_id: string }>(
    "linked-accounts/link/complete",
  );
  const create = useLinkedAccountAction<{ uuid: string }, { id: string }>(
    "personal-account",
  );
  const [linkId, setLinkId] = useState<string | null>(completedLink ?? null);
  const [handle, setHandle] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const hasPersonal = linked.data?.accounts.some((account) => !account.org);
  const beginLink = async () => {
    // Open synchronously so browsers don't block the authentication window after the network round trip.
    const popup = window.open(
      "about:blank",
      "silicon-account-link",
      "popup,width=600,height=780",
    );
    try {
      setError(null);
      const result = await start.mutateAsync({});
      const url = new URL(result.authorize_url, window.location.origin);
      if (url.origin !== window.location.origin)
        throw new Error(
          "The account linking address must belong to Silicon Accounts.",
        );
      setLinkId(result.link_id);
      try {
        sessionStorage.setItem("silicon-accounts:pending-link", result.link_id);
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
      try {
        sessionStorage.removeItem("silicon-accounts:pending-link");
      } catch {}
      setMessage(
        "Your accounts are linked. Their apps, history and details stay separate.",
      );
      await linked.refetch();
    } catch (failure) {
      setError(ApiError.from(failure));
    }
  };
  const switchTo = async (uuid: string) => {
    try {
      setError(null);
      await switchAccount.mutateAsync({ account_uuid: uuid });
      window.location.assign(
        new URL("/linked-accounts", window.location.origin).toString(),
      );
    } catch (failure) {
      setError(ApiError.from(failure));
    }
  };
  return (
    <Page width="reading">
      <PageHeader
        title="Your accounts"
        description="One sign-in, separate accounts. Your orgs only see the work accounts that belong to them."
        back={{ href: "/", label: "Your identity" }}
      />
      {error || linked.error || requests.error ? (
        <Alert tone="danger" title="This could not be completed">
          {(error ?? linked.error ?? requests.error)?.message}{" "}
          {(error ?? linked.error ?? requests.error)?.hint}
        </Alert>
      ) : null}
      {message ? (
        <Alert tone="success" title="Accounts linked">
          {message}
        </Alert>
      ) : null}
      {!linked.data ? (
        <p role="status">Loading your accounts…</p>
      ) : (
        <div className={styles.accounts}>
          {([false, true] as const).map((work) => (
            <Section key={String(work)} title={work ? "Work" : "Personal"}>
              {linked.data.accounts
                .filter((account) => !!account.org === work)
                .map((account) => (
                  <div
                    key={account.uuid}
                    className={styles.row}
                    data-sq="surface"
                  >
                    {account.org?.logo_url ? (
                      <Image
                        src={account.org.logo_url}
                        width={32}
                        height={32}
                        alt=""
                        unoptimized
                      />
                    ) : account.org ? (
                      <Building2 aria-hidden="true" />
                    ) : (
                      <UserRound aria-hidden="true" />
                    )}
                    <div className={styles.identity}>
                      <strong>{account.display_name}</strong>
                      <span>{account.id}</span>
                      {account.org ? <span>{account.org.name}</span> : null}
                      <small>
                        {account.is_main ? "Main account" : "Linked account"}
                        {account.uuid === me.data?.uuid
                          ? " · Currently using"
                          : ""}
                      </small>
                    </div>
                    {account.uuid !== me.data?.uuid ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={switchAccount.isPending}
                        onClick={() => void switchTo(account.uuid)}
                      >
                        Switch
                      </Button>
                    ) : null}
                  </div>
                ))}
              {!work && !hasPersonal ? (
                <p>You do not have a personal account linked yet.</p>
              ) : null}
              {work && !linked.data.accounts.some((account) => account.org) ? (
                <p>Work accounts appear here when you join an org.</p>
              ) : null}
            </Section>
          ))}
        </div>
      )}
      {requests.data?.items.length ? (
        <Section
          title="Account linking requests"
          description="A Silicon or its custodian must approve before an org work account can be linked."
        >
          {requests.data.items.map((item) => (
            <LinkRequest
              key={item.id}
              request={item}
              onDone={() => {
                void requests.refetch();
                void linked.refetch();
              }}
            />
          ))}
        </Section>
      ) : null}
      <Section
        title="Link another account"
        description="Sign in to the other account to prove it is yours. Linking shares no account details with your orgs."
      >
        {linkId ? (
          <div className={styles.actions}>
            <p>Finish signing in in the other window, then confirm here.</p>
            <Button
              loading={complete.isPending}
              onClick={() => void finishLink()}
            >
              Finish linking
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setLinkId(null);
                try {
                  sessionStorage.removeItem("silicon-accounts:pending-link");
                } catch {}
              }}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            loading={start.isPending}
            onClick={() => void beginLink()}
          >
            <Link2 size={16} /> Link an account
          </Button>
        )}
      </Section>
      {linked.data &&
      !hasPersonal &&
      me.data?.org &&
      me.data.kind === "carbon" ? (
        <Section
          title="Create your personal account"
          description="It becomes your main account. Your work accounts, their apps and history stay as they are."
        >
          <form
            className={styles.create}
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              void create
                .mutateAsync({ id: `c:${handle}` })
                .then((result) =>
                  switchAccount.mutateAsync({ account_uuid: result.uuid }),
                )
                .then(() =>
                  window.location.assign(
                    new URL(
                      "/linked-accounts",
                      window.location.origin,
                    ).toString(),
                  ),
                )
                .catch((failure) => setError(ApiError.from(failure)));
            }}
          >
            <Input
              label="Personal handle"
              value={handle}
              onChange={(event) => setHandle(event.target.value.toLowerCase())}
              pattern="[a-z0-9_-]{3,30}"
              minLength={3}
              maxLength={30}
              required
              description="3–30 letters, numbers, hyphens or underscores. Your personal handle has no org suffix."
            />
            <Button type="submit" loading={create.isPending || switchAccount.isPending}>
              Create personal account
            </Button>
          </form>
        </Section>
      ) : null}
      {linked.data &&
      !hasPersonal &&
      me.data?.org &&
      me.data.kind === "silicon" ? (
        <Section
          title="A personal Silicon account"
          description="A personal Silicon needs its own Carbon custodian. After that account is created, link it here with independent sign-in proof, or ask your org admin to send a link request for the custodian to approve."
        />
      ) : null}
      <Link
        href={
          meta.data?.organizations_url ??
          "https://organizations.teamofsilicons.com"
        }
      >
        Manage your organizations →
      </Link>
    </Page>
  );
}

function LinkRequest({
  request,
  onDone,
}: {
  request: AccountLinkRequest;
  onDone: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const accept = useLinkedAccountAction<unknown, Record<string, never>>(
    `linked-accounts/requests/${encodeURIComponent(request.id)}/accept`,
  );
  const decline = useLinkedAccountAction<unknown, Record<string, never>>(
    `linked-accounts/requests/${encodeURIComponent(request.id)}/decline`,
  );
  return (
    <div className={`${styles.row} ${styles.request}`} data-sq="surface">
      <div className={styles.identity}>
        <strong>
          {request.source.id} → {request.target.id}
        </strong>
        <span>
          {request.source.org?.name ?? "Work account"} is asking to link this
          Silicon’s work account.
        </span>
        {confirm ? (
          <span>
            Approve only if both accounts are run by the same Silicon. Their
            apps and history stay separate.
          </span>
        ) : null}
        {accept.error || decline.error ? (
          <Alert tone="danger" title="Linking could not be completed">
            {(accept.error ?? decline.error)?.message}
          </Alert>
        ) : null}
      </div>
      <div className={styles.actions}>
        <Button
          size="sm"
          loading={accept.isPending}
          onClick={() => {
            if (!confirm) {
              setConfirm(true);
              return;
            }
            void accept
              .mutateAsync({})
              .then(onDone)
              .catch(() => {});
          }}
        >
          {confirm ? "Confirm and link" : "Review link"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={decline.isPending}
          onClick={() =>
            void decline
              .mutateAsync({})
              .then(onDone)
              .catch(() => {})
          }
        >
          Decline
        </Button>
      </div>
    </div>
  );
}
