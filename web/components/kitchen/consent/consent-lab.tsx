"use client";

/**
 * /__consent: the consent step's designs (components/auth/steps/consent-designs.tsx) inside the real hosted frame, as
 * an app's sign-in shows them. 1 to 4 are the second round (consent-v2.tsx, the hierarchy fixed); the earlier tries (D
 * and E on the site's parts, A to C first) stay for the record. The switches sit in a strip above the page. A bar at the top picks the design, the app (Briefcase in the default look, or a sample
 * app with its own colours) and the case (a first sign-in; a returning one that shared some details before; one where
 * the account has no phone yet). Nothing is sent. B draws the app's mark itself, so the frame's logo is off for it.
 */
import { useState } from "react";
import SegmentedControl from "@teamofsilicons/silicon-ui/segmented-control";
import { HostedFrame } from "@/components/auth/flow/hosted-frame";
import type { FrameApp } from "@/components/auth/flow/model";
import { OneListConsent, TwoSectionsConsent } from "@/components/auth/steps/consent-aligned";
import { BandConsent, CardConsent, OneTapConsent, SentenceConsent } from "@/components/auth/steps/consent-v2";
import { ChecklistConsent, HandshakeConsent, PreviewConsent, type ConsentField } from "@/components/auth/steps/consent-designs";
import type { Branding } from "@/lib/api/types";
import styles from "./consent-lab.module.css";

const DESIGNS = {
  sentence: { label: "1 Sentence", View: SentenceConsent },
  card: { label: "2 Card", View: CardConsent },
  onetap: { label: "3 One tap", View: OneTapConsent },
  band: { label: "4 Band", View: BandConsent },
  onelist: { label: "Earlier D", View: OneListConsent },
  sections: { label: "Earlier E", View: TwoSectionsConsent },
  preview: { label: "Earlier A", View: PreviewConsent },
  handshake: { label: "Earlier B", View: HandshakeConsent },
  checklist: { label: "Earlier C", View: ChecklistConsent },
} as const;
const ROUND_TWO = ["sentence", "card", "onetap", "band"];

const APPS: Record<string, { label: string; frame: FrameApp; domain: string; site?: boolean }> = {
  /* The account site's own tokens (HostedFrame site): how the step looks in today's Silicon Accounts design. */
  site: { label: "Account site look", domain: "briefcase.teamofsilicons.com", site: true, frame: { app_id: "briefcase", name: "Briefcase", logo_url: "/icons/briefcase/web/icon-192.png" } },
  briefcase: { label: "Default branding", domain: "briefcase.teamofsilicons.com", frame: { app_id: "briefcase", name: "Briefcase", logo_url: "/icons/briefcase/web/icon-192.png" } },
  northwind: {
    label: "Own colours", domain: "app.northwind.test",
    frame: { app_id: "northwind", name: "Northwind", branding: { show_app_name: true, light: { primary: "#1E6B4F", primary_foreground: "#FFFFFF", background: "#F1F5F2", surface: "#FFFFFF", foreground: "#14231C", muted: "#5B6B62", border: "#D5DED8", danger: "#B42318" } } as Partial<Branding> },
  },
};

const field = (f: Partial<ConsentField> & Pick<ConsentField, "field" | "label">): ConsentField => ({ value: null, mode: "optional", isNew: true, shared: false, ...f });
const CASES: Record<string, { label: string; fields: ConsentField[] }> = {
  first: { label: "First time", fields: [
    field({ field: "email", label: "Email address", value: "s***@gmail.com", mode: "required" }),
    field({ field: "timezone", label: "Timezone", value: "Kolkata, Asia (UTC+05:30)" }),
    field({ field: "dob", label: "Date of birth", value: "Mar 14, 1998" }),
  ] },
  returning: { label: "Returning", fields: [
    field({ field: "email", label: "Email address", value: "s***@gmail.com", mode: "required", isNew: false }),
    field({ field: "timezone", label: "Timezone", value: "Kolkata, Asia (UTC+05:30)", isNew: false, shared: true }),
    field({ field: "dob", label: "Date of birth", value: "Mar 14, 1998" }),
  ] },
  missing: { label: "No phone yet", fields: [
    field({ field: "email", label: "Email address", value: "s***@gmail.com", mode: "required" }),
    field({ field: "timezone", label: "Timezone", value: "Kolkata, Asia (UTC+05:30)" }),
    field({ field: "phone", label: "Phone number", value: null }),
  ] },
};

const ACCOUNT = { name: "Saket Dev", id: "c:saket" };

export function ConsentLab() {
  const [design, setDesign] = useState<keyof typeof DESIGNS>("sentence");
  const [app, setApp] = useState("briefcase");
  const [state, setState] = useState("first");
  const [shared, setShared] = useState<string[] | null>(null);
  const { View } = DESIGNS[design];
  const chosen = APPS[app];
  const option = ([value, entry]: [string, { label: string }]) => ({ value, label: entry.label });
  return (
    <>
      {/* The switches sit in a strip above the page, never over it, so the whole step shows. */}
      <div className={styles.bar} role="toolbar" aria-label="Consent lab">
        <SegmentedControl size="sm" label="Design" options={Object.entries(DESIGNS).filter(([key]) => ROUND_TWO.includes(key)).map(option)} value={ROUND_TWO.includes(design) ? design : ""} onValueChange={value => { setDesign(value as keyof typeof DESIGNS); setShared(null); }} />
        <SegmentedControl size="sm" label="Earlier" options={Object.entries(DESIGNS).filter(([key]) => !ROUND_TWO.includes(key)).map(option)} value={ROUND_TWO.includes(design) ? "" : design} onValueChange={value => { setDesign(value as keyof typeof DESIGNS); setShared(null); }} />
        <SegmentedControl size="sm" label="App" options={Object.entries(APPS).map(option)} value={app} onValueChange={value => { setApp(value); setShared(null); }} />
        <SegmentedControl size="sm" label="Case" options={Object.entries(CASES).map(option)} value={state} onValueChange={value => { setState(value); setShared(null); }} />
        {shared ? <span className={styles.said} role="status">Would share: profile{shared.length ? `, ${shared.join(", ")}` : ""}</span> : null}
      </div>
      <HostedFrame key={`${design}-${app}-${state}`} app={chosen.frame} site={chosen.site} title={`Sign in to ${chosen.frame.name}`} hideName plain={design === "handshake" || design === "band"}>
        <View app={{ name: chosen.frame.name, logo: chosen.frame.logo_url ?? null, domain: chosen.domain }} account={ACCOUNT} fields={CASES[state].fields} onShare={setShared} />
      </HostedFrame>
    </>
  );
}
