"use client";

import { useState } from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import { useDeveloperApp } from "@/components/developer/lib/context";
import { api, flushPendingSaves, useResource } from "./api";
import { useSearchParams } from "./navigation";
import { AppHistory, Authors, Releases } from "./Management";
import { Setup } from "./Setup";
import { STEPS, type App } from "./types";
import { Badge, Button, Empty, ErrorNotice, Loading } from "./ui";
import "./publishing.css";

function Workspace({ section }: { section: "publishing" | "releases" | "authors" | "history" }) {
  const { appId } = useDeveloperApp();
  const resource = useResource<App>(`/apps/${appId}`);
  const [params, setParams] = useSearchParams();
  const [navigationError, setNavigationError] = useState<Error>();
  const app = resource.data;
  const requested = Number(params.get("step") || app?.setup_step || 1);
  const step = Number.isInteger(requested) ? Math.max(1, Math.min(7, requested)) : 1;
  const go = async (next: number) => {
    try {
      await flushPendingSaves();
      await api(`/apps/${appId}`, { method: "PATCH", body: { setup_step: next } });
      setParams({ step: String(next) });
      setNavigationError(undefined);
    } catch (error) { setNavigationError(error as Error); }
  };
  if (resource.loading && !app) return <Loading label="Loading publishing settings…" />;
  if (resource.error) return <ErrorNotice error={resource.error} retry={resource.reload} />;
  if (!app) return null;
  if (!app.is_author) return <Empty title="Publishing is available to this app’s authors" description="An author can invite you to work on its listing, packages and releases." />;
  return <div className="publishing-panel">
    <div className="row between publishing-status"><p className="muted">{app.published ? "This app is published for its allowed audience." : "Complete the required steps, then publish when you are ready."}</p><Badge tone={app.published ? "success" : "warning"}>{app.published ? "Published" : "Continue setup"}</Badge></div>
    <ErrorNotice error={navigationError} />
    {section === "releases" ? <Releases app={app} refresh={resource.reload} /> : section === "authors" ? <Authors app={app} refresh={resource.reload} /> : section === "history" ? <AppHistory app={app} /> : <div className="setup-layout">
      <aside className="setup-sidebar"><nav aria-label="Publishing steps">{STEPS.map((label, index) => <button key={label} type="button" data-sq="surface" className={`step-link ${step === index + 1 ? "active" : ""}`} aria-current={step === index + 1 ? "step" : undefined} onClick={() => void go(index + 1)}><span data-sq="surface" className="step-number">{index + 1}</span><span>{label}{index < 3 && <small>Required</small>}</span>{step === index + 1 && <ChevronRight size={15} />}</button>)}</nav><p className="small muted">Move freely between steps. Your progress is saved as you go.</p></aside>
      <div data-sq="surface" className="setup-main"><Setup key={`${appId}-${step}`} app={app} step={step} refresh={resource.reload} go={go} />{step < 7 && <div className="setup-footer"><Button variant="secondary" disabled={step === 1} onClick={() => void go(step - 1)}>Back</Button><Button onClick={() => void go(step + 1)}>Continue <ArrowRight size={16} /></Button></div>}</div>
    </div>}
  </div>;
}
export const PublishingTab = () => <Workspace section="publishing" />;
export const ReleasesTab = () => <Workspace section="releases" />;
export const AuthorsTab = () => <Workspace section="authors" />;
export const HistoryTab = () => <Workspace section="history" />;
