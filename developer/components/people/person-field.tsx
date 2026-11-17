'use client';
import {useEffect,useId,useState} from 'react';
import Image from 'next/image';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Input} from '@/components/silicon-ui/input/input';
import {Button} from '@/components/silicon-ui/button/button';
import {contactsApi,safePhoto,usePeople} from './api';
import {fuzzyMatch,mergePeople,type Person} from './ranking';
import styles from './people.module.css';
export function PersonAvatar({person}:{person:Person}){const url=safePhoto(person.pfp_url);return url?<Image className={styles.avatar} src={url} alt='' width={32} height={32} unoptimized referrerPolicy='no-referrer'/>:<span className={`${styles.avatar} ${styles.initial}`} aria-hidden='true'>{(person.display_name||person.id||'?').slice(0,2).toUpperCase()}</span>;}
export function PersonLabel({person}:{person:Person}){return <><PersonAvatar person={person}/><span className={styles.detail}><strong>{person.display_name||person.id||person.uuid}</strong><small>{person.id||person.uuid}{person.contact?` · Trust ${person.trust}`:''}</small></span></>;}
export function ContactEditor({person,onSaved}:{person:Person;onSaved?:()=>void}){const cache=useQueryClient();const [name,setName]=useState(person.display_name||person.id||'');const [trust,setTrust]=useState(String(person.trust||1));const [busy,setBusy]=useState(false);const [error,setError]=useState('');return <div className={styles.editor}><Input label='Saved contact name' value={name} onChange={e=>setName(e.target.value)} maxLength={200}/><Input label='Trust (1–255)' type='number' min={1} max={255} value={trust} onChange={e=>setTrust(e.target.value)}/><p className={styles.hint}>1 means saved; 2 means trusted. Higher values rank contacts higher.</p>{error&&<p role='alert'>{error}</p>}<Button type='button' loading={busy} disabled={!name.trim()||!Number.isInteger(Number(trust))||Number(trust)<1||Number(trust)>255} onClick={async()=>{setBusy(true);setError('');try{const c=person.contact;await contactsApi('contacts','POST',{id:person.uuid,name:name.trim(),trust:Number(trust),note:c?.note??'',phone:c?.phone??'',email:c?.email??'',photo_id:c?.photo_id??null,birthday_month:c?.birthday_month??null,birthday_day:c?.birthday_day??null,birthday_year:c?.birthday_year??null});await cache.invalidateQueries({queryKey:['contacts','list']});onSaved?.();}catch(e){setError(e instanceof Error?e.message:'Could not save this contact.');}finally{setBusy(false);}}}>Save contact</Button></div>;}
export function PersonField({value,onChange,label='Carbon, Silicon or email',placeholder='c:name or si:name',disabled=false,onSelect}:{value:string;onChange:(v:string)=>void;label?:string;placeholder?:string;disabled?:boolean;onSelect?:(p:Person)=>void}){
 const id=useId(),data=usePeople();const [open,setOpen]=useState(false),[index,setIndex]=useState(0),[query,setQuery]=useState(value),[editing,setEditing]=useState(false);
 useEffect(()=>{const timer=setTimeout(()=>setQuery(value.trim()),250);return()=>clearTimeout(timer);},[value]);
 const lookup=useQuery({queryKey:['people','lookup',data.accountUuid,query],queryFn:({signal})=>contactsApi<Person>(`lookup?q=${encodeURIComponent(query)}`,'GET',undefined,signal),enabled:!!data.accountUuid&&(/^(?:c:|si:)[^\s]{2,}$/.test(query)||/^[a-f0-9-]{36}$/i.test(query)),retry:false,staleTime:30_000});
 const known=data.people.find(p=>p.uuid===value.trim()||p.id?.toLowerCase()===value.trim().toLowerCase());
 const resolved=lookup.data&&(lookup.data.uuid===value.trim()||lookup.data.id?.toLowerCase()===value.trim().toLowerCase())?lookup.data:undefined;
 const exact=resolved?mergePeople([resolved],data.contacts.data??[]).find(p=>p.uuid===resolved.uuid):undefined;
 const selected=known??exact;
 const matches=data.people.filter(p=>fuzzyMatch(value,[p.id,p.display_name,p.uuid,p.contact?.email].filter(Boolean).join(' '))).slice(0,8);
 const suggestions=exact&&!matches.some(p=>p.uuid===exact.uuid)?[exact,...matches].slice(0,8):matches;
 const choose=(p:Person)=>{onChange(p.id||p.uuid);onSelect?.(p);setOpen(false);setEditing(false);};
 return <div className={styles.field}><Input label={label} placeholder={placeholder} value={value} disabled={disabled} autoComplete='off' role='combobox' aria-autocomplete='list' aria-expanded={open&&suggestions.length>0} aria-controls={`${id}-list`} aria-activedescendant={open&&suggestions.length?`${id}-${Math.min(index,suggestions.length-1)}`:undefined} onFocus={()=>setOpen(true)} onBlur={()=>setTimeout(()=>setOpen(false),150)} onChange={e=>{onChange(e.target.value);setOpen(true);setIndex(0);setEditing(false);}} onKeyDown={e=>{if(e.key==='Escape')setOpen(false);if(e.key==='ArrowDown'){e.preventDefault();setOpen(true);setIndex(i=>Math.min(i+1,suggestions.length-1));}if(e.key==='ArrowUp'){e.preventDefault();setIndex(i=>Math.max(0,i-1));}if(e.key==='Enter'&&open&&suggestions[index]){e.preventDefault();choose(suggestions[index]);}}}/>
 {open&&suggestions.length>0&&<div id={`${id}-list`} role='listbox' aria-label='People suggestions' className={styles.list} data-sq='surface'>{suggestions.map((p,i)=><button id={`${id}-${i}`} key={p.uuid} className={styles.person} role='option' aria-selected={index===i} type='button' onMouseDown={e=>e.preventDefault()} onClick={()=>choose(p)}><PersonLabel person={p}/></button>)}</div>}
 {selected&&<div className={styles.selected} data-sq='surface'><div className={styles.person}><PersonLabel person={selected}/></div>{data.connection.data?.connected&&<><Button type='button' variant='secondary' disabled={disabled} onClick={()=>setEditing(!editing)}>{selected.contact?'Edit saved contact':'Save to Contacts'}</Button>{editing&&<ContactEditor key={selected.uuid} person={selected} onSaved={()=>setEditing(false)}/>}</>}</div>}
 {data.history.data?.partial&&<p className={styles.hint}>Some invitation history is temporarily unavailable.</p>}
 {!data.connection.data?.connected&&<p className={styles.hint}>Connect your address book in <a href='/contacts'>Contacts</a> to include saved names, photos and trust.</p>}
 </div>;
}

export function SavedPerson({person}:{person:Person}){const {people}=usePeople();const saved=people.find(p=>p.uuid===person.uuid);return <span className={styles.person}><PersonLabel person={{...person,...saved}}/></span>;}
function SelectedPerson({value}:{value:string}) {
 const data=usePeople();
 const known=data.people.find(p=>p.uuid===value||p.id===value);
 const lookup=useQuery({queryKey:['people','lookup',data.accountUuid,value],queryFn:({signal})=>contactsApi<Person>(`lookup?q=${encodeURIComponent(value)}`,'GET',undefined,signal),enabled:!!data.accountUuid&&!known&&(/^(?:c:|si:)[^\s]{2,}$/.test(value)||/^[a-f0-9-]{36}$/i.test(value)),retry:false,staleTime:30_000});
 const resolved=lookup.data;
 const person=known??(resolved?mergePeople([resolved],data.contacts.data??[]).find(p=>p.uuid===resolved.uuid):undefined)??{uuid:value,id:value};
 return <div className={styles.person}><PersonLabel person={person}/></div>;
}
export function AddPeople({value,onChange,label='Add a Carbon or Silicon',useIds=false,disabled=false}:{value:string;onChange:(value:string)=>void;label?:string;useIds?:boolean;disabled?:boolean}) {
 const [target,setTarget]=useState('');
 const lines=[...new Set(value.split(/[\n,]/).map(v=>v.trim()).filter(v=>/^(?:c:|si:)[^\s]+$/.test(v)||/^[a-f0-9-]{36}$/i.test(v)))];
 return <div><PersonField label={label} value={target} disabled={disabled} onChange={setTarget} onSelect={p=>{const entries=value.split('\n').map(v=>v.trim()).filter(Boolean);const selected=useIds?(p.id||p.uuid):p.uuid;if(!entries.includes(selected))onChange([...entries,selected].join('\n'));setTarget('');}}/>{lines.map(value=><SelectedPerson key={value} value={value}/>)}</div>;
}
