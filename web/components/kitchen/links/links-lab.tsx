"use client";

/**
 * /__links: the phone field's switches ("Country Not in the List?", "Use a Different Number") as Silicon UI Button's
 * `link` variant (local patch, 2026-11-10) beside today's ghost xs button (Anil asked: "any reason for this to be a
 * button and not a link?"). They stay buttons (they change the field, they go nowhere); only the look is a link.
 * The same two places are drawn three ways:
 *
 *   Ghost (now)        variant="ghost" size="xs": a box on hover
 *   Underlined         variant="link": a light underline at rest, darker with the text on hover and focus
 *   On hover only      variant="link" with --button-link-underline: transparent
 *
 * Hover and Tab through them; the phone field and the buttons are live but send nothing.
 */
import { Button } from "@teamofsilicons/silicon-ui/button";
import { PhoneInput } from "@teamofsilicons/silicon-ui/phone-input";
import styles from "./links-lab.module.css";

type Treatment = { id: string; name: string; note: string; variant: "ghost" | "link"; className?: string };

const TREATMENTS: Treatment[] = [
  { id: "ghost", name: "Ghost (now)", note: "A quiet button: a box appears on hover.", variant: "ghost" },
  { id: "always", name: "Underlined", note: "A light underline at rest that darkens on hover. Shows on phones too.", variant: "link" },
  { id: "hover", name: "Underline on hover", note: "No underline at rest; it appears on hover. Never on phones.", variant: "link", className: styles.hoverOnly },
];

function Switch({ treatment, children }: { treatment: Treatment; children: string }) {
  return treatment.variant === "ghost"
    ? <Button type="button" variant="ghost" size="xs" className={styles.start}>{children}</Button>
    : <Button type="button" variant="link" size="sm" className={[styles.start, treatment.className].filter(Boolean).join(" ")}>{children}</Button>;
}

export function LinksLab() {
  return (
    <main className={styles.lab}>
      <header className={styles.intro}>
        <h1 className={styles.title}>Link buttons</h1>
        <p className={styles.lede}>The phone field&rsquo;s switches as Silicon UI Button&rsquo;s new <code>link</code> variant beside today&rsquo;s ghost button. They stay buttons: they change the field and go nowhere. Hover and Tab through them; nothing is sent.</p>
      </header>
      <div className={styles.row}>
        {TREATMENTS.map(treatment => (
          <section key={treatment.id} className={styles.column} aria-labelledby={`links-${treatment.id}`}>
            <div className={styles.columnHead}>
              <h2 id={`links-${treatment.id}`} className={styles.columnName}>{treatment.name}</h2>
              <p className={styles.note}>{treatment.note}</p>
            </div>
            <div data-sq className={styles.dialog}>
              <h3 className={styles.dialogTitle}>Text code</h3>
              <div className={styles.field}>
                <PhoneInput label="Phone number" defaultCountry="IN" description="The code has 6 digits and works for 10 minutes." />
                <Switch treatment={treatment}>Country Not in the List?</Switch>
              </div>
              <div className={styles.actions}>
                <Switch treatment={treatment}>Use a Different Number</Switch>
                <span className={styles.end}>
                  <Button type="button" variant="ghost" size="sm">Cancel</Button>
                  <Button type="button" variant="secondary" size="sm">Send a New Code</Button>
                </span>
              </div>
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
