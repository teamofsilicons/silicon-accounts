"use client";
import {usePeople,safePhoto} from "@/components/people/api";
import {fuzzyMatch} from "@/components/people/ranking";
/* eslint-disable @next/next/no-img-element -- Organization directory pictures are rendered without exposing tokens. */
import {useId,useState} from "react";
import {Button} from "@/components/silicon-ui/button/button";
import {Input} from "@/components/silicon-ui/input/input";
import {Select} from "@/components/silicon-ui/select/select";
import {Alert} from "@/components/silicon-ui/alert/alert";
import {type Directory,type Grant,type Permission,type ResourceKind,type ResourcePolicy,type Subject,useOrganizationDirectory} from "./api";
import styles from "./policies.module.css";

export const permissionLabels:Record<Permission,string>={create:"Create drafts",read:"Read drafts",edit:"Edit",publish:"Publish and deploy",manage:"Manage access and settings"};
const kinds:ResourceKind[]=["apps","interfaces","cells"];
const subjectKey=(subject:Subject)=>`${subject.type}:${subject.id}`;
export function SubjectPicker({directory,value,onChange,label="Carbon, Silicon or team"}:{directory:Directory;value:Subject|null;onChange:(value:Subject)=>void;label?:string}) {
  const id=useId(),[query,setQuery]=useState("");
  const people=usePeople().people;
  const candidates=[...directory.members.filter(m=>!m.removed_at).map(m=>({subject:{type:"account",id:m.uuid} as Subject,name:people.find(p=>p.uuid===m.uuid)?.display_name||m.display_name||m.id,detail:m.id,photo:people.find(p=>p.uuid===m.uuid)?.pfp_url||m.pfp_url})),...directory.teams.map(t=>({subject:{type:"team",id:t.id} as Subject,name:t.name,detail:"Team",photo:""}))];
  const selected=candidates.find(c=>value&&subjectKey(c.subject)===subjectKey(value));
  const matches=candidates.filter(c=>fuzzyMatch(query,`${c.name} ${c.detail}`)).sort((a,b)=>{const ai=people.findIndex(p=>p.uuid===a.subject.id),bi=people.findIndex(p=>p.uuid===b.subject.id);return (ai<0?100000:ai)-(bi<0?100000:bi);}).slice(0,12);
  return <div className={styles.picker}>
    {value&&<div className={styles.selected}>{selected?.photo&&safePhoto(selected.photo)?<img src={selected.photo} alt="" width={28} height={28}/>:null}<span>{selected?.name||value.id}<small>{selected?.detail||value.type}</small></span></div>}
    <Input label={label} value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search a name or c:/si: ID" aria-controls={`${id}-suggestions`} autoComplete="off"/>
    <ul id={`${id}-suggestions`} className={styles.suggestions} aria-label={`${label} suggestions`}>{matches.map(candidate=><li key={subjectKey(candidate.subject)}><button type="button" onClick={()=>{onChange(candidate.subject);setQuery("");}} aria-pressed={value?subjectKey(value)===subjectKey(candidate.subject):false}>{candidate.photo&&safePhoto(candidate.photo)?<img src={candidate.photo} alt="" width={24} height={24}/>:null}<span>{candidate.name}<small>{candidate.detail}</small></span></button></li>)}</ul>
    {!matches.length&&<p>No matching members or teams.</p>}
  </div>;
}
function subjectName(directory:Directory,subject:Subject) {
  if(subject.type==="team")return directory.teams.find(t=>t.id===subject.id)?.name||subject.id;
  const member=directory.members.find(m=>m.uuid===subject.id);return member?.display_name||member?.id||subject.id;
}
export function GrantsEditor({value,onChange,directory,resource=false}:{value:Grant[];onChange:(value:Grant[])=>void;directory:Directory;resource?:boolean}) {
  const [subject,setSubject]=useState<Subject|null>(null);
  return <div className={styles.stack}>
    {value.map((grant,index)=><div key={index} className={styles.rule} data-sq="surface"><div className={styles.row}><strong>{subjectName(directory,grant.subject)}</strong><Button size="sm" variant="ghost" onClick={()=>onChange(value.filter((_,i)=>i!==index))}>Remove</Button></div>
      {!resource&&<fieldset className={styles.choices}><legend>Applies to</legend>{kinds.map(kind=><label key={kind}><input type="checkbox" checked={!grant.resources.length||grant.resources.includes(kind)} onChange={event=>{const current=grant.resources.length?grant.resources:kinds;const resources=event.target.checked?[...new Set([...current,kind])]:current.filter(k=>k!==kind);if(resources.length)onChange(value.map((g,i)=>i===index?{...g,resources}:g));}}/>{kind[0].toUpperCase()+kind.slice(1)}</label>)}</fieldset>}
      <fieldset className={styles.choices}><legend>Permissions</legend>{(Object.keys(permissionLabels) as Permission[]).filter(p=>!resource||p!=="create").map(permission=><label key={permission}><input type="checkbox" checked={grant.permissions.includes(permission)} onChange={event=>onChange(value.map((g,i)=>i===index?{...g,permissions:event.target.checked?[...g.permissions,permission]:g.permissions.filter(p=>p!==permission)}:g))}/>{permissionLabels[permission]}</label>)}</fieldset>
    </div>)}
    <SubjectPicker directory={directory} value={subject} onChange={setSubject}/>
    <Button variant="secondary" disabled={!subject} onClick={()=>{if(subject){onChange([...value,{subject,resources:[],permissions:resource?["read"]:["create"]}]);setSubject(null);}}}>Add permission grant</Button>
    <p>Organization owners and admins retain management access. All other grants require current organization membership.</p>
  </div>;
}
function AudienceList({label,value,onChange,directory}:{label:string;value:Subject[];onChange:(value:Subject[])=>void;directory:Directory}) {
  const [selected,setSelected]=useState<Subject|null>(null);
  return <div className={styles.stack}><h4>{label}</h4><ul>{value.map(subject=><li key={subjectKey(subject)} className={styles.row}><span>{subjectName(directory,subject)}</span><Button size="sm" variant="ghost" onClick={()=>onChange(value.filter(s=>subjectKey(s)!==subjectKey(subject)))}>Remove</Button></li>)}</ul><SubjectPicker directory={directory} value={selected} onChange={setSelected} label={label}/><Button variant="secondary" disabled={!selected||value.some(s=>selected&&subjectKey(s)===subjectKey(selected))} onClick={()=>{if(selected){onChange([...value,selected]);setSelected(null);}}}>Add to {label.toLowerCase()}</Button></div>;
}
export function ResourceAccessEditor({org,value,onSave,canManage}:{org:string;value:ResourcePolicy;onSave:(value:ResourcePolicy)=>Promise<void>;canManage:boolean}) {
  const directory=useOrganizationDirectory(org),[draft,setDraft]=useState(value),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[saved,setSaved]=useState(false);
  if(!canManage)return <p>Your organization controls this resource. Ask a manager to change its permissions.</p>;
  if(directory.isPending)return <p role="status">Loading organization members and teams…</p>;
  if(!directory.data)return <Alert tone="danger" title="Organization members could not be loaded"><button type="button" onClick={()=>void directory.refetch()}>Retry</button></Alert>;
  return <div className={styles.stack}><fieldset disabled={busy}><legend>Who can manage this resource</legend><GrantsEditor resource value={draft.grants} onChange={grants=>{setSaved(false);setDraft({...draft,grants});}} directory={directory.data}/></fieldset>
    <Select label="Private audience" value={draft.audience.mode} onValueChange={mode=>{setSaved(false);setDraft({...draft,audience:{...draft.audience,mode:mode as ResourcePolicy["audience"]["mode"]}});}} options={[{value:"organization",label:"Everyone in the organization"},{value:"restricted",label:"Only included members and teams"}]} description="This audience controls private access. Management permissions are configured separately."/>
    {draft.audience.mode==="restricted"&&<AudienceList label="Included members and teams" value={draft.audience.include} onChange={include=>{setSaved(false);setDraft({...draft,audience:{...draft.audience,include}});}} directory={directory.data}/>}
    <AudienceList label="Excluded members and teams" value={draft.audience.exclude} onChange={exclude=>{setSaved(false);setDraft({...draft,audience:{...draft.audience,exclude}});}} directory={directory.data}/><p>Exclusions override the private audience. Managers can still inspect the resource and repair its settings.</p>
    {error&&<Alert tone="danger" title={error}/>}{saved&&<p role="status">Organization access saved.</p>}<Button disabled={busy||draft.grants.some(g=>!g.permissions.length)} onClick={async()=>{setBusy(true);setError(null);try{await onSave(draft);setSaved(true);}catch(error){setError(error instanceof Error?error.message:"Access could not be saved.");}finally{setBusy(false);}}}>Save organization access</Button>
  </div>;
}
