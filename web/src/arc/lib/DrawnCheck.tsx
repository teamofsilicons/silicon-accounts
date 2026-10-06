import styles from "./drawn-check.module.css";

/** The success tick draws itself from its short stroke, the way a hand would write it (Arc). */
export function DrawnCheck(props: { size?: number; strokeWidth?: number; class?: string; slow?: boolean }) {
  return (
    <svg
      class={[styles.check, props.slow ? styles.slow : "", props.class ?? ""].join(" ")}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={props.strokeWidth ?? 1.75}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      data-icon="drawn-check"
    >
      <path d="M4 12l5 5L20 6" pathLength="1" />
    </svg>
  );
}
