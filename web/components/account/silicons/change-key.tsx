"use client";

/**
 * Change a Silicon's secret key (the prototype's askRotate): "Change {id}'s key?", the old key stops working at once and
 * the Silicon is signed out of every app. A new key is made (or the Carbon types their own); the new one goes to the
 * reveals store (parts/reveals.ts), which the Silicon's page and Security both show until "I've stored it".
 * Used on the Silicon's page (Access) and on Security's Silicon keys.
 */
import { useState, type FormEvent } from "react";
import { Button } from "@teamofsilicons/silicon-ui/button";
import { Checkbox } from "@teamofsilicons/silicon-ui/checkbox";
import { Dialog, DialogContent } from "@teamofsilicons/silicon-ui/dialog";
import { Input } from "@teamofsilicons/silicon-ui/input";
import type { ManagedSilicon } from "@/lib/api/types";
import { describeError } from "../parts/common";
import { useRotateStkOnce } from "../parts/queries";
import { addReveal } from "../parts/reveals";
import { normalizeStk, stkProblem, stkSecret } from "../parts/stk";
import styles from "./change-key.module.css";

export function ChangeKeyDialog({ silicon, open, onClose }: { silicon: ManagedSilicon; open: boolean; onClose: () => void }) {
  const [own, setOwn] = useState(false);
  const [stk, setStk] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rotateStk = useRotateStkOnce();
  const id = silicon.id ?? silicon.uuid;
  const close = () => { setOwn(false); setStk(""); setError(null); onClose(); };
  const rotate = async (event: FormEvent) => {
    event.preventDefault();
    if (own) {
      const problem = stkProblem(stk);
      if (problem) return setError(problem);
    }
    setError(null);
    try {
      // The answer leaves the mutation cache as soon as it is here: the reveal holds the only copy.
      const answer = await rotateStk.run({ uuid: silicon.uuid, stk: own ? normalizeStk(stk) : undefined });
      close();
      if (answer.stk) {
        addReveal({
          silicon: silicon.uuid,
          origin: "stk",
          title: `${id}’s new key`,
          description: `The old key stopped working and ${id} was signed out everywhere. Give it this one; Silicon Accounts keeps only its hash.`,
          secrets: [stkSecret(id, answer.stk)],
        });
      }
    } catch (raw) {
      setError(describeError(raw));
    }
  };
  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !rotateStk.isPending) close(); }}>
      {open ? (
        <DialogContent title={`Change ${id}’s key?`} description={<>The old key stops working at once, and <strong>{id}</strong> is signed out of every app.</>}>
          <form className={styles.form} onSubmit={event => void rotate(event)} noValidate>
            <Checkbox label="Choose the new key yourself" description="Otherwise one is made for you and shown once." checked={own} onCheckedChange={value => { setOwn(value === true); setError(null); }} />
            {own ? <Input label="New key" className="mono" value={stk} onChange={event => { setStk(event.target.value); setError(null); }} placeholder="stk-0123456789ab" autoComplete="off" spellCheck={false} description="stk- and 8 to 32 hex digits. It is never shown again, so keep a copy." /> : null}
            {error ? <p className={styles.error} role="alert">{error}</p> : null}
            <div className={styles.actions}>
              <Button type="button" variant="ghost" onClick={close} disabled={rotateStk.isPending}>Cancel</Button>
              <Button type="submit" variant="danger" loading={rotateStk.isPending}>Change Key</Button>
            </div>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
