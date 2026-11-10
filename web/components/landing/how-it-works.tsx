"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ShaderFill } from "./figma-shader/index";
import { stageShader } from "./columns-shader";
import styles from "./landing.module.css";

const STEPS = [
  {
    n: "01",
    title: "Sign in",
    body: "With a code sent to your email or phone, or with Google or Apple. The app decides which of these it offers.",
  },
  {
    n: "02",
    title: "See what's shared",
    body: "The first time you sign into an app, and whenever it asks for more, you see exactly what it will get. Optional details stay unticked until you tick them.",
  },
  {
    n: "03",
    title: "Take it back",
    body: "Every app you've signed into is listed in your account. Remove an app's access whenever you want.",
  },
] as const;

const DETAILS = [
  ["Display name", "Required", true],
  ["Email", "Required", true],
  ["Phone number", "Optional", false],
  ["Date of birth", "Optional", false],
] as const;

const APPS = [
  ["B", "Briefcase"],
  ["D", "DM"],
  ["C", "Commit"],
] as const;

function SignInCard() {
  return (
    <>
      <p className={styles.cardTitle}>Sign in to Briefcase</p>
      <div className={styles.methods}>
        {["Continue with email", "Continue with phone number", "Continue with Google", "Continue with Apple"].map(label => (
          <span key={label} className={styles.method}>{label}</span>
        ))}
      </div>
      <p className={styles.powered}>Powered by Silicon Accounts</p>
    </>
  );
}

function SharedCard() {
  return (
    <>
      <div className={styles.appHead}>
        <span className={styles.avatar} aria-hidden="true">B</span>
        <p className={styles.cardTitle}>Briefcase will get</p>
      </div>
      <div className={styles.rows}>
        {DETAILS.map(([name, note, on]) => (
          <div key={name} className={styles.detailRow}>
            <span className={on ? `${styles.box} ${styles.boxOn}` : `${styles.box} ${styles.boxOff}`}>
              {on ? <Image src="/brand/check.svg" alt="" width={18} height={18} /> : null}
            </span>
            <p className={styles.detailName}>{name}</p>
            <p className={styles.detailNote}>{note}</p>
          </div>
        ))}
      </div>
      <span className={styles.inkButton}>Continue as c:you</span>
    </>
  );
}

function AppsCard() {
  return (
    <>
      <p className={styles.cardTitle}>Your apps</p>
      <div className={styles.apps}>
        {APPS.map(([initial, name]) => (
          <div key={name} className={styles.appRow}>
            <span className={styles.avatar} aria-hidden="true">{initial}</span>
            <span className={styles.appMeta}>
              <p className={styles.appName}>{name}</p>
              <p className={styles.appState}>Signed in</p>
            </span>
            <span className={styles.dangerButton}>Remove access</span>
          </div>
        ))}
      </div>
    </>
  );
}

const CARDS = [SignInCard, SharedCard, AppsCard];

export function HowItWorks() {
  const sceneRef = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const onScroll = () => {
      const span = scene.offsetHeight - window.innerHeight;
      if (span < 40) return;
      const progress = Math.min(Math.max(-scene.getBoundingClientRect().top / span, 0), 0.999);
      setActive(Math.floor(progress * STEPS.length));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  function show(index: number) {
    const scene = sceneRef.current;
    if (!scene) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const span = scene.offsetHeight - window.innerHeight;
    if (span < 40) {
      document.getElementById(`how-step-${index}`)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      return;
    }
    const top = window.scrollY + scene.getBoundingClientRect().top + (span * index) / STEPS.length + 1;
    window.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
  }

  return (
    <section ref={sceneRef} className={styles.howScene} aria-labelledby="how-heading">
      <div className={styles.howPin}>
        <div className={styles.howSplit}>
          <div className={styles.howWriting}>
            <div className={styles.howHeader}>
              <p className={styles.eyebrow}>How it works</p>
              <h2 id="how-heading">See what every app gets, and take it back.</h2>
              <p className={styles.howLede}>Sign in with what the app offers, check what it&apos;s asking for, and remove its access whenever you want.</p>
            </div>
            <ol className={styles.steps}>
              {STEPS.map((step, index) => {
                const Card = CARDS[index]!;
                return (
                  <li key={step.n}>
                    <button
                      id={`how-step-${index}`}
                      type="button"
                      className={index === active ? `${styles.step} ${styles.stepActive}` : styles.step}
                      aria-current={index === active ? "step" : undefined}
                      onClick={() => show(index)}
                    >
                      <span className={styles.stepNum}>{step.n}</span>
                      <span className={styles.stepText}>
                        <span className={styles.stepTitle}>{step.title}</span>
                        <span className={styles.stepBody}>{step.body}</span>
                      </span>
                    </button>
                    <div className={styles.stepSnippet} aria-hidden="true">
                      <div className={`${styles.vignette} ${styles.vignetteOn}`}><Card /></div>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
          <div className={styles.stage} aria-hidden="true">
            <ShaderFill className={styles.stageShader} shader={stageShader} />
            {CARDS.map((Card, index) => (
              <div key={index} className={index === active ? `${styles.vignette} ${styles.vignetteOn}` : styles.vignette}>
                <Card />
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
