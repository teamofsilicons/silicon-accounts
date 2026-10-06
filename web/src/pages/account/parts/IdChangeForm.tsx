/**
 * Changing a c:id or si:id: the live-checked field, what happens to the old id (reserved 10 days, and can be taken
 * back), and the submit. Used for your own id (Identity) and for a Silicon's (its drawer).
 *
 * Taking back a Silicon's previous id: the availability check runs with the custodian's session, so the service
 * reports the Silicon's own reservation as "reserved" (it belongs to the Silicon, not to the custodian). The form
 * therefore offers to take back any reserved id for a Silicon: it says so with certainty for ids this tab changed
 * away from, and otherwise lets the service decide (409 id_reserved when the reservation is another account's).
 */
import { Show, createSignal, onMount } from "solid-js";
import { ApiError } from "../../../api";
import { Button } from "../../../arc/button/button";
import { formatDate } from "../../../lib/format";
import { createIdCheck, IdField, type IdPrefix } from "./IdField";
import { readableTimes, reportFailure } from "./common";
import { wasIdOf } from "./recent-ids";
import styles from "./parts.module.css";

export interface IdChangeFormProps {
  prefix: IdPrefix;
  currentId: string | null;
  uuid: string;
  /** Whose id this is: the signed-in account's own, or a Silicon's (custodian view). */
  subject: "self" | "silicon";
  /** Performs the change. Reject with the API error; the form explains it. */
  submit: (id: string) => Promise<unknown>;
  /** After a change: the new id and the one it replaced (read before the change, so it is the old one). */
  onChanged: (id: string, previous: string | null) => void;
  onCancel?: () => void;
  autofocus?: boolean;
  inputRef?: (el: HTMLInputElement) => void;
}

export function IdChangeForm(props: IdChangeFormProps) {
  const [handle, setHandle] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [failure, setFailure] = createSignal<{ message: string; suggestions: string[] } | null>(null);
  // Reserved ids the service refused to give back to this Silicon: the reservation is another account's.
  const [refused, setRefused] = createSignal<string[]>([]);
  const check = createIdCheck(() => props.prefix, handle, () => props.currentId, {
    forUuid: () => (props.subject === "silicon" ? props.uuid : undefined),
  });
  let field: HTMLInputElement | undefined;
  // The attribute alone only works on page load; a form that opens later moves focus itself.
  onMount(() => { if (props.autofocus) queueMicrotask(() => field?.focus({ preventScroll: true })); });

  /** A reserved id the custodian may be taking back for the Silicon (the service decides whose reservation it is). */
  const reserved = () => {
    const current = check();
    if (props.subject !== "silicon" || current.status !== "unavailable" || current.reason !== "reserved") return null;
    return refused().includes(current.id) ? null : current;
  };
  /** The id to take back, when there is one: reclaimable for this account, or reserved and maybe the Silicon's. */
  const reclaim = () => {
    const current = check();
    if (current.status === "available" && current.reclaimable) return current.id;
    return reserved()?.id ?? null;
  };
  const ready = () => (check().status === "available" || reserved() !== null) && !pending();
  const change = (value: string) => {
    setFailure(null);
    setHandle(value);
  };

  /** What the status line says about a reserved id the Silicon may own. */
  const reservedNotice = () => {
    const found = reserved();
    if (!found) return null;
    const until = found.until ? ` until ${formatDate(found.until)}` : "";
    if (wasIdOf(props.uuid, found.id)) {
      return { tone: "success" as const, text: `${found.id} was this Silicon's id and is reserved for it${until}, so you can take it back.` };
    }
    return { tone: "neutral" as const, text: `${found.id} is reserved${until} for the account that had it last. If that was this Silicon, you can take it back; if not, pick another id.` };
  };

  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!ready()) return;
    const current = check();
    const target = current.status === "available" || current.status === "unavailable" ? current.id : null;
    if (!target) return;
    // Read before the change: once it lands, the account's id (and so currentId) is the new one.
    const previous = props.currentId;
    setPending(true);
    setFailure(null);
    try {
      await props.submit(target);
      props.onChanged(target, previous);
    } catch (raw) {
      const error = ApiError.from(raw);
      if (error.code === "id_reserved" && props.subject === "silicon") {
        // The reservation is another account's: say so plainly and stop offering to take it back.
        setRefused(list => [...list, target]);
        const until = typeof error.details.reserved_until === "string" ? ` until ${formatDate(error.details.reserved_until)}` : "";
        const message = `${target} is reserved${until} for another account, not for this Silicon, so it cannot be taken back. Pick another id.`;
        reportFailure(error, "The id did not change");
        setFailure({ message, suggestions: current.status === "unavailable" ? current.suggestions : [] });
      } else {
        const message = readableTimes(reportFailure(error, "The id did not change"));
        setFailure({ message, suggestions: error.suggestions.slice(0, 3) });
      }
    } finally {
      setPending(false);
    }
  };

  const keeps = () => (props.subject === "self" ? "you" : "this Silicon");
  return (
    <form class={styles.idForm} onSubmit={onSubmit} novalidate>
      <p class={styles.formNote}>
        <Show when={props.currentId} fallback={<>Pick an id people can type. </>}>
          {id => <>When it changes, <span class="mono">{id()}</span> stays reserved for {keeps()} for 10 days: nobody else can take it, and {props.subject === "self" ? "you can take it back" : "you can take it back for it"}. </>}
        </Show>
        {props.subject === "self"
          ? <>Every app you have signed into is told. Apps know you by your uuid <span class="mono">{props.uuid}</span>, which never changes.</>
          : <>Its webhook and every app it has signed into are told. Apps know it by its uuid <span class="mono">{props.uuid}</span>, which never changes.</>}
      </p>
      <IdField
        prefix={props.prefix}
        value={handle()}
        onValueChange={change}
        check={check()}
        error={failure()?.message}
        suggestions={failure()?.suggestions}
        notice={reservedNotice()}
        autofocus={props.autofocus}
        inputRef={el => { field = el; props.inputRef?.(el); }}
        disabled={pending()}
        reclaimText={id => (props.subject === "self"
          ? `${id} was your id and is still reserved for you, so you can take it back.`
          : `${id} was this Silicon's id and is still reserved for it, so you can take it back.`)}
      />
      <div class={styles.formActions}>
        <Show when={props.onCancel}>
          <Button type="button" variant="ghost" onClick={() => props.onCancel?.()} disabled={pending()}>Cancel</Button>
        </Show>
        <Button type="submit" loading={pending()} disabled={!ready() && !pending()}>
          {reclaim() ? `Take back ${reclaim()}` : "Change id"}
        </Button>
      </div>
    </form>
  );
}
