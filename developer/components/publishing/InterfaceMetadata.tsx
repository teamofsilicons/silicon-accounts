"use client";

import {useEffect, useRef, useState} from "react";
import Link from "next/link";
import {Plus, Trash2} from "lucide-react";
import {useNavigationGuard} from "@/lib/navigation-guard";
import {api, clearPublishingDraft, keepPublishingDraft, publishingDraft, useMutation} from "./api";
import {Button, ErrorNotice, Input, Section} from "./ui";
import type {App, InterfaceLicense, InterfaceUseCase} from "./types";

type Preset = Extract<InterfaceLicense, {kind: "preset"}>["preset"];
type Draft = { interface_api_documentation_url: string | null; interface_use_cases: InterfaceUseCase[] | null; interface_license: InterfaceLicense | null };
const presets: {value: Preset; label: string}[] = [
  {value: "free", label: "Free use"},
  {value: "attribution", label: "Attribution required"},
  {value: "attribution_unless_paid", label: "Attribution unless paid"},
  {value: "permission_required", label: "Permission required"},
];
const presetTerms: Record<Preset, string> = {
  free: "You may use this app’s interface API to build, distribute and operate interfaces, including commercially, without payment or attribution.",
  attribution: "You may use this app’s interface API to build, distribute and operate interfaces, including commercially. Credit the app by name and link to its app page wherever you give interface credits.",
  attribution_unless_paid: "You may use this app’s interface API to build, distribute and operate interfaces, including commercially. Credit the app by name and link to its app page wherever you give interface credits. Attribution is not required if the app publisher has granted you a paid attribution waiver. Arrange its price and terms with the publisher.",
  permission_required: "Ask the app publisher for permission before using this app’s interface API in an interface.",
};

/** Interface documentation is saved as a complete set; partial use cases never reach the API. */
export function InterfaceMetadata({app, refresh}: {app: App; refresh: () => void}) {
  const draftKey = `interface-metadata:${app.app_id}`;
  const initial = ():Draft => ({
    interface_api_documentation_url: app.interface_api_documentation_url ?? null,
    interface_use_cases: app.interface_use_cases ?? null,
    interface_license: app.interface_license ?? null,
  });
  const [draft, setDraft] = useState<Draft>(() => publishingDraft<Draft>(draftKey) ?? initial());
  const latest=useRef(draft);
  const [dirty, setDirty] = useState(() => !!publishingDraft<Draft>(draftKey));
  const [fileError, setFileError] = useState<Error>();
  const [saved, setSaved] = useState(false);
  const mutation = useMutation();
  const update = (change: Partial<Draft>) => {const next={...latest.current,...change};latest.current=next;keepPublishingDraft(draftKey,next);setDraft(next);setDirty(true);setSaved(false);};
  useNavigationGuard(dirty ? {question: {title: "Leave without saving?", description: "Your interface documentation changes are not saved yet."}} : null);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = "";};
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  const cases = draft.interface_use_cases ?? [];
  const changeCase = (index: number, change: Partial<InterfaceUseCase>) => update({interface_use_cases: cases.map((item, i) => i === index ? {...item, ...change} : item)});
  const selectFiles = async (index: number, files: FileList | null) => {
    if (!files?.length) return;
    setFileError(undefined);
    try {
      const next = Array.from(files);
      if (next.some(file => !file.name.toLowerCase().endsWith(".md") || file.size > 100 * 1024)) throw new Error("Choose Markdown files up to 100 KiB each.");
      const contents = await Promise.all(next.map(async file => ({name: file.name, content: await file.text()})));
      const nextCases = cases.map((item, i) => i === index ? {...item, files: [...item.files, ...contents]} : item);
      update({interface_use_cases: nextCases});
    } catch (error) {setFileError(error instanceof Error ? error : new Error("Could not read the files."));}
  };
  const license = draft.interface_license;
  const save = async () => {
    setFileError(undefined);
    if (cases.some(item => !item.name.trim() || !item.files.length || item.files.some(file => !file.content.trim()))) {
      setFileError(new Error("Give each use case a name and at least one nonempty Markdown file.")); return;
    }
    const result = await mutation.run(() => api(`/apps/${encodeURIComponent(app.app_id)}`, {method: "PATCH", body: draft}));
    if (result !== undefined) {clearPublishingDraft(draftKey); setDirty(false); setSaved(true); refresh();}
  };
  return <Section title="Building interfaces with your app" description="Help interface creators understand the APIs and make the best experience for their Carbons and Silicons.">
    <fieldset className="form-stack" disabled={mutation.pending} style={{border: 0, margin: 0, padding: 0, minWidth: 0}}>
      <p className="small muted"><Link href="/docs/interfaces#api-documentation">Interface API documentation guide</Link> · <Link href="/docs/interfaces#use-case-understandings">Use case understanding guide</Link> · <Link href="/docs/interfaces#licenses">License guide</Link></p>
      <Input label="Interface API documentation URL" type="url" value={draft.interface_api_documentation_url ?? ""} placeholder="https://…" maxLength={2048} description="Required before publishing a new app. Link to the APIs interfaces can use and how to use them." onChange={event => update({interface_api_documentation_url: event.target.value || null})}/>
      <div className="row between"><div><h3>Use case understandings</h3><p className="small muted">Optional Markdown files describing the experiences an interface can build.</p></div><Button type="button" variant="secondary" size="sm" disabled={cases.length >= 20} onClick={() => update({interface_use_cases: [...cases, {name: "", files: []}]})}><Plus size={15}/> Add use case</Button></div>
      {cases.map((item, index) => <div className="editor-group" key={index}>
        <div className="row between"><strong>Use case {index + 1}</strong><Button type="button" variant="ghost" size="sm" aria-label={`Remove use case ${index + 1}`} onClick={() => update({interface_use_cases: cases.filter((_, i) => i !== index)})}><Trash2 size={16}/></Button></div>
        <Input label="Use case name" value={item.name} maxLength={120} onChange={event => changeCase(index, {name: event.target.value})}/>
        <label className="field-label">Add Markdown files <input type="file" accept=".md,text/markdown" multiple disabled={item.files.length >= 10} onChange={event => {void selectFiles(index, event.currentTarget.files); event.currentTarget.value = "";}}/></label>
        {item.files.map((file, fileIndex) => <div className="row between" key={`${file.name}-${fileIndex}`}><span>{file.name}</span><Button type="button" variant="ghost" size="sm" aria-label={`Remove ${file.name}`} onClick={() => changeCase(index, {files: item.files.filter((_, i) => i !== fileIndex)})}><Trash2 size={16}/></Button></div>)}
        <span className="small muted">Up to 10 files, 100 KiB each.</span>
      </div>)}
      <label className="field-label">Interface license <select value={license?.kind ?? "none"} onChange={event => {
        const kind = event.target.value;
        update({interface_license: kind === "preset" ? {kind, preset: "free"} : kind === "link" ? {kind, url: ""} : kind === "file" ? {kind, name: "", content: ""} : null});
      }}><option value="none">No license specified</option><option value="preset">Choose a preset</option><option value="link">Link to a license</option><option value="file">Upload a license file</option></select></label>
      {license?.kind === "preset" && <label className="field-label">Preset <select value={license.preset} onChange={event => update({interface_license: {kind: "preset", preset: event.target.value as Preset}})}>{presets.map(preset => <option key={preset.value} value={preset.value}>{preset.label}</option>)}</select></label>}
      {license?.kind === "preset" && <p className="small muted">{presetTerms[license.preset]} These terms do not grant rights to the app’s source code, trademarks or user data, or waive other applicable terms.</p>}
      {license?.kind === "link" && <Input label="License URL" type="url" value={license.url} placeholder="https://…" onChange={event => update({interface_license: {...license, url: event.target.value}})}/>}
      {license?.kind === "file" && <><label className="field-label">License file <input type="file" accept=".txt,.md,text/plain,text/markdown" onChange={event => {const file = event.currentTarget.files?.[0]; if (!file) return; if (file.size > 100 * 1024) {setFileError(new Error("Choose a license file up to 100 KiB.")); return;} void file.text().then(content => {setFileError(undefined); update({interface_license: {kind: "file", name: file.name, content}});}).catch(() => setFileError(new Error("Could not read the license file.")));}}/></label>{license.name && <p className="small muted">{license.name}</p>}</>}
      <ErrorNotice error={fileError || mutation.error}/>
      <div className="row"><Button type="button" disabled={!dirty} loading={mutation.pending} onClick={() => void save()}>Save interface details</Button>{dirty&&<Button type="button" variant="secondary" onClick={()=>{clearPublishingDraft(draftKey);const next=initial();latest.current=next;setDraft(next);setDirty(false);setSaved(false);setFileError(undefined);}}>Discard changes</Button>}{saved && <span role="status">Saved</span>}</div>
    </fieldset>
  </Section>;
}
