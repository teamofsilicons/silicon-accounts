const fast = { type: "spring", visualDuration: 0.05, bounce: 0, exit: { duration: 0.06 } } as const;
const moderate = { type: "spring", visualDuration: 0.09, bounce: 0, exit: { duration: 0.12 } } as const;
const slow = { type: "spring", visualDuration: 0.15, bounce: 0.12, exit: { duration: 0.16 } } as const;

export const motionTokens = {
  /** Tween durations in seconds, for opacity, colour and blur, and for CSS (the same steps as `--duration-*`). */
  duration: {
    instant: 0.06, fast: 0.08, exit: 0.12, standard: 0.16, considered: 0.24,
    /** Motion that tells a story over time rather than answering a click: a chart drawing in, a counter rolling, text
     *  revealing, a success ring drawing, a slow image zoom. Never for a hover, press, menu or panel. */
    expressive: 0.48,
  },
  ease: {
    enter: [0.16, 1, 0.3, 1],
    exit: [0.7, 0, 0.84, 0],
    standard: [0.22, 1, 0.36, 1],
    /** For elements that move while already on screen. */
    inOut: [0.65, 0, 0.35, 1],
  },
  spring: {
    /** Hover highlights, presses, toggles, thumbs and small indicators. */
    fast,
    /** Menus, popovers, tabs, drawers, height changes: short travel that must land exactly. */
    moderate,
    /** Dialogs, sheets, shape morphs and large shared-layout moves. A little bounce. */
    slow,
    /** Earlier names, kept so existing code keeps working. Prefer the tier names. */
    snappy: fast,
    smooth: moderate,
    morph: slow,
    responsive: moderate,
    gentle: moderate,
    /** The spring for expressive motion (see duration.expressive): a bar growing, a value settling into place. */
    expressive: { type: "spring", visualDuration: 0.42, bounce: 0.16 },
  },
  /** Stagger steps in seconds. Keep total stagger under roughly 0.4s. */
  stagger: { char: 0.016, word: 0.04, line: 0.08, item: 0.035 },
  /** Blur radii in px for text and content crossfades. Keep blur small and brief. */
  blur: { subtle: 2, soft: 4, text: 8 },
} as const;

/**
 * How long (ms) a deferred-unmount timer waits for a tier's exit before forcing it: the exit plus a safety margin, for
 * a throttled background tab that never finishes the animation.
 */
export const exitFallbackMs = (tier: { exit: { duration: number } }) => Math.round(tier.exit.duration * 1000) + 100;
