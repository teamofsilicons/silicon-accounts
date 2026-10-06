import styles from "./parts.module.css";

/**
 * Longest full question shown (characters). A confirm question has at most 16rem beside Cancel and the confirm button
 * (Arc ConfirmMorph), and less on a 481 px screen; a longer one (a long address or app name) would be cut off, so the
 * short one stands in for it everywhere.
 */
const FULL_MAX = 30;

/**
 * A confirm question that shortens on phones, where the full one ("Remove cricketdrop6@gmail.com?") would be cut off
 * beside Cancel and the confirm button. The row it sits in already names the thing, so the short one ("Remove this
 * email?") loses nothing; on the narrowest phones (up to 374 px) `tiny` ("Remove it?") takes over where given. Only the
 * shown one is read out.
 */
export function FitPrompt({ full, short, tiny }: { full: string; short: string; tiny?: string }) {
  return (
    <>
      <span className={styles.promptFull}>{full.length <= FULL_MAX ? full : short}</span>
      <span className={tiny ? styles.promptShortWide : styles.promptShort}>{short}</span>
      {tiny ? <span className={styles.promptTiny}>{tiny}</span> : null}
    </>
  );
}
