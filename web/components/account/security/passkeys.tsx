"use client";

/**
 * Passkeys in Security → Your sign-in (Anil, 2026-11-23): a row for each passkey (its name, when it was added and last
 * used; Rename and Remove), then "Add a passkey". Adding needs a sign-in from the last 30 minutes: when it is older,
 * Add sends the Carbon through the sign-in again and back here (`?add=passkey`), where the row asks them to press Add
 * once more (the browser only opens its passkey sheet on a press).
 *
 * Remove asks in a dialog that names the ways in you keep, like Unlink, and won't remove the only one.
 */
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { KeyRound } from "lucide-react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { Input } from "@teamofsilicons/silicon-ui/input";
import { ApiError } from "@/lib/api/errors";
import type { CarbonMe, PasskeyView } from "@/lib/api/types";
import { formatDate, formatRelative } from "@/lib/format";
import { passkeyNameHere, usePasskeySupport } from "@/lib/passkey";
import { firstPartySignInUrl } from "@/lib/query/session";
import { describeError, useNow } from "../parts/common";
import { useAddPasskey, useRemovePasskey, useRenamePasskey } from "../parts/queries";
import { Row, Strong, Tile } from "../parts/rows";
import styles from "./security.module.css";

const listJoin = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`);

/** The ways in you keep once this passkey is gone, as Unlink names them. */
function waysWithout(carbon: CarbonMe, passkey: PasskeyView): string[] {
  const ways: string[] = [];
  if (carbon.identities.some(item => item.provider === "google")) ways.push("Google");
  if (carbon.identities.some(item => item.provider === "apple")) ways.push("Apple");
  if (carbon.emails.length) ways.push("an email code");
  if (carbon.phones.length) ways.push("a text code");
  if ((carbon.passkeys ?? []).some(item => item.id !== passkey.id)) ways.push("another passkey");
  return ways;
}

export function PasskeyRows({ carbon, returnTo }: { carbon: CarbonMe; returnTo: string }) {
  // An API without passkeys (one deployed before them) leaves `passkeys` out of GET /v1/me: nothing to show or add.
  if (carbon.passkeys === undefined) return null;
  const passkeys = carbon.passkeys;
  return (
    <>
      {passkeys.map(passkey => <PasskeyRow key={passkey.id} passkey={passkey} carbon={carbon} />)}
      <AddPasskeyRow count={passkeys.length} returnTo={returnTo} />
    </>
  );
}

function PasskeyRow({ passkey, carbon }: { passkey: PasskeyView; carbon: CarbonMe }) {
  const now = useNow(60_000);
  const remove = useRemovePasskey();
  const rename = useRenamePasskey();
  const [asking, setAsking] = useState<"remove" | "rename" | null>(null);
  const [name, setName] = useState(passkey.name);
  const [error, setError] = useState<string | null>(null);
  const ways = waysWithout(carbon, passkey);
  const used = passkey.last_used_at ? <>Last used <Strong>{formatRelative(passkey.last_used_at, now)}</Strong></> : "Not used yet";

  const open = (what: "remove" | "rename") => {
    setError(null);
    setName(passkey.name);
    setAsking(what);
  };
  const confirmRemove = async () => {
    setError(null);
    try {
      await remove.mutateAsync(passkey.id);
      setAsking(null);
    } catch (raw) {
      setError(describeError(raw));
    }
  };
  const confirmRename = async () => {
    setError(null);
    try {
      await rename.mutateAsync({ id: passkey.id, name });
      setAsking(null);
    } catch (raw) {
      setError(describeError(raw));
    }
  };
  const pending = remove.isPending || rename.isPending;

  return (
    <Row lead={<Tile><KeyRound size={16} strokeWidth={2} /></Tile>} title={passkey.name} detail={<>Added {formatDate(passkey.created_at)} · {used}</>}>
      <Button variant="ghost" size="sm" aria-label={`Rename ${passkey.name}`} onClick={() => open("rename")}>Rename</Button>
      <Button variant="secondary" size="sm" aria-label={`Remove ${passkey.name}`} onClick={() => open("remove")}>Remove</Button>
      <Dialog open={asking !== null} onOpenChange={next => { if (!next && !pending) setAsking(null); }}>
        {asking === "remove" ? (
          <DialogContent
            title="Remove this passkey?"
            description={ways.length
              ? <>You won&rsquo;t be able to sign in with <strong>{passkey.name}</strong>. You can still sign in with <strong>{listJoin(ways)}</strong>.</>
              : <>This passkey is your only way to sign in. Add an email or phone first.</>}
          >
            {error ? <p className={styles.rowError} role="alert">{error}</p> : null}
            <div className={styles.dialogActions}>
              <Button variant="ghost" onClick={() => setAsking(null)} disabled={pending}>Cancel</Button>
              <Button variant="danger" onClick={() => void confirmRemove()} loading={remove.isPending} disabled={!ways.length}>Remove Passkey</Button>
            </div>
          </DialogContent>
        ) : asking === "rename" ? (
          <DialogContent title="Rename passkey" description="Name it after the device or password manager that keeps it.">
            <form className={styles.dialogForm} onSubmit={event => { event.preventDefault(); void confirmRename(); }}>
              <Input label="Name" value={name} maxLength={64} autoFocus onChange={event => { setName(event.currentTarget.value); setError(null); }} error={error ?? undefined} />
              <div className={styles.dialogActions}>
                <Button type="button" variant="ghost" onClick={() => setAsking(null)} disabled={pending}>Cancel</Button>
                <Button type="submit" loading={rename.isPending} disabled={!name.trim() || name.trim() === passkey.name}>Save Name</Button>
              </div>
            </form>
          </DialogContent>
        ) : null}
      </Dialog>
    </Row>
  );
}

function AddPasskeyRow({ count, returnTo }: { count: number; returnTo: string }) {
  const supported = usePasskeySupport();
  const add = useAddPasskey();
  const search = useSearchParams();
  const backFromSignIn = search.get("add") === "passkey";
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  const start = async () => {
    setError(null);
    setAdded(false);
    try {
      const passkey = await add.mutateAsync({ name: passkeyNameHere() });
      if (passkey) setAdded(true);
    } catch (raw) {
      const failure = raw instanceof ApiError ? raw : null;
      if (failure?.code === "reauthentication_required") {
        // Sign in again, then come back here to press Add.
        const back = `${returnTo}${returnTo.includes("?") ? "&" : "?"}add=passkey`;
        window.location.assign(firstPartySignInUrl(back, { prompt: "login" }));
        return;
      }
      setError(raw instanceof ApiError ? describeError(raw) : raw instanceof Error ? raw.message : describeError(raw));
    }
  };

  const detail = !supported
    ? "This browser can't make passkeys"
    : added
      ? "Added. Sign in with it next time."
      : backFromSignIn
        ? "You're signed in again: press Add to make the passkey."
        : count
          ? "Add one for another device or password manager"
          : "Sign in with Face ID, Touch ID or your device's screen lock";

  return (
    <Row lead={<Tile><KeyRound size={16} strokeWidth={2} /></Tile>} title={count ? "Add another passkey" : "Passkey"} detail={detail} error={error}>
      {supported ? <Button variant="secondary" size="sm" aria-label={count ? "Add another passkey" : "Add a passkey"} onClick={() => void start()} loading={add.isPending}>Add</Button> : null}
    </Row>
  );
}

