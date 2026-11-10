"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Select } from "@/components/silicon-ui/select/select";
import { api, clearPublishingDraft, keepPublishingDraft, publishingDraft, useMutation } from "./api";
import { Button, ErrorNotice, Input, Section, Textarea } from "./ui";
import type { App } from "./types";
import { parseStorageRows, startingValue, storageRows, storageTypes, type StorageRow, type StorageType } from "./storage-schema";

export function StorageFields({rows, onChange, locked = []}: {rows: StorageRow[]; onChange: (rows: StorageRow[]) => void; locked?: string[]}) {
  function update(index: number, change: Partial<StorageRow>) { onChange(rows.map((row, i) => i === index ? {...row, ...change} : row)); }
  return <div className="form-stack">
    <p className="small muted">Optional settings shared across your app’s features. Each Carbon and Silicon gets independent values. Your app also has one shared anonymous record.</p>
    {rows.map((row, index) => <fieldset key={index} className="editor-group" disabled={(index < locked.length && locked.includes(row.key))} style={{border: 0, margin: 0, padding: 0, minWidth: 0}}>
      <legend className="small">Setting {index + 1}{(index < locked.length && locked.includes(row.key)) ? " · Saved" : ""}</legend>
      <Input label={`Key ${index + 1}`} value={row.key} maxLength={128} placeholder="theme" onChange={event => update(index, {key: event.target.value})}/>
      <Select label={`Type ${index + 1}`} value={row.type} disabled={index < locked.length && locked.includes(row.key)} options={storageTypes.map(type => ({value: type, label: type}))} onValueChange={value => {const type = value as StorageType; update(index, {type, value: startingValue[type]});}}/>
      <Textarea style={{minHeight: row.type === "object" || row.type === "array" ? undefined : "2.75rem"}} label={`Initial value ${index + 1}`} rows={row.type === "object" || row.type === "array" ? 3 : 1} value={row.value} description={row.type === "string" ? "Enter text without quotes." : "Enter a JSON value matching the selected type."} onChange={event => update(index, {value: event.target.value})}/>
      {!(index < locked.length && locked.includes(row.key)) && <Button type="button" variant="ghost" size="sm" aria-label={`Remove setting ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}><Trash2 size={16}/> Remove</Button>}
    </fieldset>)}
    <Button type="button" variant="secondary" disabled={rows.length >= 128} onClick={() => onChange([...rows, {key: "", type: "string", value: ""}])}><Plus size={16}/> Add storage key</Button>
  </div>;
}

export function UserStorage({app, refresh}: {app: App; refresh: () => void}) {
  const draftKey = `storage:${app.app_id}`;
  const restored = publishingDraft<{rows: StorageRow[]}>(draftKey);
  const [rows, setRows] = useState(() => restored?.rows ?? storageRows(app.user_storage));
  const [dirty, setDirty] = useState(!!restored);
  const [locked, setLocked] = useState(() => Object.keys(app.user_storage ?? {}));
  const [saved, setSaved] = useState(false);
  const mutation = useMutation();
  return <Section title="User storage (optional)" description="Define keys and initial values for your app’s settings.">
    <fieldset className="form-stack" disabled={mutation.pending} style={{border: 0, margin: 0, padding: 0, minWidth: 0}}>
      <StorageFields rows={rows} locked={locked} onChange={next => {setRows(next); setDirty(true); setSaved(false); keepPublishingDraft(draftKey, {rows: next});}}/>
      <p className="small muted">Saved keys, types and initial values stay fixed. You can add keys later. Other apps with a valid User verification can read a user’s settings; only your verified app can write them.</p>
      <ErrorNotice error={mutation.error}/>
      <div className="row"><Button type="button" disabled={!dirty} loading={mutation.pending} onClick={() => void mutation.run(async () => {
        const schema = parseStorageRows(rows);
        await api(`/apps/${app.app_id}/storage-schema`, {method: "PUT", body: schema});
        clearPublishingDraft(draftKey); setDirty(false); setSaved(true); setLocked(Object.keys(schema)); refresh();
      })}>Save storage definition</Button>
      {dirty && <Button type="button" variant="secondary" onClick={() => {setRows(storageRows(app.user_storage)); clearPublishingDraft(draftKey); setDirty(false); setSaved(false); mutation.clearError();}}>Discard changes</Button>}
      {saved && <span role="status">Storage definition saved</span>}</div>
    </fieldset>
  </Section>;
}
