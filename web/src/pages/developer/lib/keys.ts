/**
 * Idempotency keys per logical action. A retry of the same request (same signature) reuses its key, so an action
 * whose response got lost never happens twice: the server replays the stored answer instead (failed requests are not
 * stored, so retrying one runs it again). A changed request, or one that succeeded, gets a new key.
 */
import { newIdempotencyKey } from "../../../api";

export interface ActionKey {
  /** The key for a request with this signature: the previous key while the signature is unchanged, else a new one. */
  for: (signature: string) => string;
  /** The action succeeded: the next request is a new action with a new key. */
  done: () => void;
}

export function actionKey(): ActionKey {
  let current: { key: string; signature: string } | null = null;
  return {
    for: signature => {
      if (!current || current.signature !== signature) current = { key: newIdempotencyKey(), signature };
      return current.key;
    },
    done: () => {
      current = null;
    },
  };
}
