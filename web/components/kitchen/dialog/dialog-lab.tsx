"use client";

/**
 * /__dialog: the Text code dialog (Security, "Add a phone number") with a hierarchy (Anil, 2026-11-10: "this doesn't
 * have hierarchy"). Under the title nearly everything was 14px. The flow is title → the field → Send Code; the
 * description, the hint, the way out and Cancel step back, in that order:
 *
 *   1  title                      h2 18/600, --foreground
 *   2  the typed number           body 16/400 (was 14; 16 also stops iOS zooming into the field)
 *      its calling code         the same: "+91" is the start of the number, not a label (was 14/500)
 *   2  the field's label          label 14/500
 *   3  the description            small 14/400, --text-secondary
 *   4  the hint                   12/400, --text-muted (a role the scale doesn't have yet: "hint")
 *   4  Country Not in the List?   caption 12/500, --text-secondary, underlined (Button's link variant, xs)
 *
 * Both columns are the same Silicon UI components; "With hierarchy" only sets the fields' size variables
 * (--field-text-size, --field-hint-size; local patch) and uses the link variant. Live, sends nothing.
 */
import { Button } from "@teamofsilicons/silicon-ui/button";
import { PhoneInput } from "@teamofsilicons/silicon-ui/phone-input";
import styles from "./dialog-lab.module.css";

const TIERS = [
  ["Title", "h2 · 18/600"],
  ["Calling code and number", "body · 16/400, one number"],
  ["Label", "label · 14/500"],
  ["Description", "small · 14/400 · secondary"],
  ["Hint", "12/400 · muted (new role)"],
  ["Country Not in the List?", "caption · 12/500 · underlined"],
] as const;

function TextCode({ hierarchy }: { hierarchy: boolean }) {
  return (
    <div data-sq className={[styles.dialog, hierarchy ? styles.hierarchy : ""].filter(Boolean).join(" ")}>
      <div className={styles.header}>
        <h3 className={styles.title}>Text code</h3>
        <p className={styles.description}>A code texted to any of these numbers signs you in. Apps that can see your phone number get the primary one.</p>
      </div>
      <div className={styles.body}>
        <div className={styles.field}>
          <PhoneInput label="Phone number" defaultCountry="IN" description="The code has 6 digits and works for 10 minutes." />
          {hierarchy
            ? <Button type="button" variant="link" size="xs" className={styles.start}>Country Not in the List?</Button>
            : <Button type="button" variant="ghost" size="xs" className={styles.start}>Country Not in the List?</Button>}
        </div>
        <div className={styles.actions}>
          <Button type="button" variant="ghost">Cancel</Button>
          <Button type="button">Send Code</Button>
        </div>
      </div>
    </div>
  );
}

export function DialogLab() {
  return (
    <main className={styles.lab}>
      <header className={styles.intro}>
        <h1 className={styles.heading}>Dialog hierarchy</h1>
        <p className={styles.lede}>The Text code dialog as it is, and with its parts on four tiers: the title, then the field and Send Code, then the description, then the hint and the way out. Type in either; nothing is sent.</p>
      </header>
      <div className={styles.row}>
        <section className={styles.column} aria-labelledby="dialog-now">
          <h2 id="dialog-now" className={styles.columnName}>Now</h2>
          <TextCode hierarchy={false} />
        </section>
        <section className={styles.column} aria-labelledby="dialog-hierarchy">
          <h2 id="dialog-hierarchy" className={styles.columnName}>With hierarchy</h2>
          <TextCode hierarchy />
          <dl className={styles.tiers}>
            {TIERS.map(([part, type]) => (
              <div key={part} className={styles.tier}><dt>{part}</dt><dd>{type}</dd></div>
            ))}
          </dl>
        </section>
      </div>
    </main>
  );
}
