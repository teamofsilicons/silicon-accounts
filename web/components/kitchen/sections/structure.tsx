"use client";

import { useState } from "react";
import { Accordion } from "@/components/arc/accordion/accordion";
import { Button } from "@/components/arc/button/button";
import { Pagination } from "@/components/arc/pagination/pagination";
import { ScrollArea } from "@/components/arc/scroll-area/scroll-area";
import { Stepper } from "@/components/arc/stepper/stepper";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { Timeline, type TimelineEvent } from "@/components/arc/timeline/timeline";
import { formatRelative } from "@/lib/format";
import { HOUR, SAMPLE_APPS, SAMPLE_NOW } from "../samples";
import { Specimen, Specimens, kitchenStyles as styles } from "../specimen";

const EVENTS: TimelineEvent[] = [
  { id: "e1", at: SAMPLE_NOW - 0.05 * HOUR, actor: "You", title: "signed in to Briefcase", meta: "Email code · Safari on macOS", tone: "success" },
  { id: "e2", at: SAMPLE_NOW - 0.5 * HOUR, actor: "DM", title: "got a proof for Briefcase", meta: "files.write · 30 minutes" },
  { id: "e3", at: SAMPLE_NOW - 26 * HOUR, actor: "You", title: "changed your id to c:saket", meta: "c:saketdev stays reserved for you for 10 days", detail: <p style={{ margin: 0 }}>Apps were told through account.id_changed.</p> },
  { id: "e4", at: SAMPLE_NOW - 50 * HOUR, actor: "si:scout", title: "failed to sign in", meta: "Wrong STK · 3 tries", tone: "danger" },
];

export function Structure() {
  const [tab, setTab] = useState("overview");
  const [step, setStep] = useState(2);
  const [page, setPage] = useState(3);
  return (
    <Specimens>
      <Specimen title="Tabs">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList aria-label="App sections">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="branding">Branding</TabsTrigger>
            <TabsTrigger value="users">Users</TabsTrigger>
          </TabsList>
          <TabsContent value="overview"><p className={styles.prose}>1,284 users, 942 active in the last 30 days.</p></TabsContent>
          <TabsContent value="branding"><p className={styles.prose}>Colours, radius, fonts and layout of the sign-in pages.</p></TabsContent>
          <TabsContent value="users"><p className={styles.prose}>Every Carbon and Silicon that signed in.</p></TabsContent>
        </Tabs>
      </Specimen>
      <Specimen title="Stepper (import wizard) and Pagination">
        <Stepper label="Import users" current={step} onStepSelect={setStep} steps={[{ id: "upload", label: "Upload", description: "CSV or JSON" }, { id: "check", label: "Check columns" }, { id: "options", label: "Options" }, { id: "run", label: "Run" }]} />
        <div className={styles.row}>
          <Button size="sm" variant="secondary" onClick={() => setStep(value => Math.max(0, value - 1))}>Back</Button>
          <Button size="sm" onClick={() => setStep(value => Math.min(4, value + 1))}>Next</Button>
        </div>
        <Pagination page={page} pageCount={12} onPageChange={setPage} label="Users pages" />
      </Specimen>
      <Specimen title="Accordion">
        <Accordion items={[
          { title: "Why does my old id stay reserved?", content: <p className={styles.prose}>For 10 days nobody else can take it, and you can take it back.</p> },
          { title: "What does an app see?", content: <p className={styles.prose}>Your uuid, id, name and photo, plus what you agree to share.</p> },
        ]} />
      </Specimen>
      <Specimen title="ScrollArea">
        <ScrollArea maxHeight={180} label="Recent sign-ins">
          <div className={styles.scrollList}>
            {Array.from({ length: 14 }, (_, index) => (
              <div key={index} className={styles.scrollItem}>
                <span>{SAMPLE_APPS[index % SAMPLE_APPS.length]?.name}</span>
                <span>{formatRelative(SAMPLE_NOW - index * 2.3 * HOUR, SAMPLE_NOW)}</span>
              </div>
            ))}
          </div>
        </ScrollArea>
      </Specimen>
      <Specimen title="Timeline (activity by day)">
        <Timeline events={EVENTS} now={SAMPLE_NOW} label="Account activity" timeZone="Asia/Kolkata" />
      </Specimen>
    </Specimens>
  );
}
