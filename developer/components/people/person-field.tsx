'use client';
import {useEffect,useId,useRef,useState} from 'react';
import Image from 'next/image';
import * as Popover from '@radix-ui/react-popover';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {Input} from '@/components/silicon-ui/input/input';
import {Button} from '@/components/silicon-ui/button/button';
import {contactsApi,safePhoto,usePeople} from './api';
import {ContactAccess} from './contact-access';
import {fuzzyMatch,mergePeople,type Person} from './ranking';
import styles from './people.module.css';
export function PersonAvatar({person}:{person:Person}){const url=safePhoto(person.pfp_url);return url?<Image className={styles.avatar} src={url} alt='' width={32} height={32} unoptimized referrerPolicy='no-referrer'/>:<span className={`${styles.avatar} ${styles.initial}`} aria-hidden='true'>{(person.display_name||person.id||'?').slice(0,2).toUpperCase()}</span>;}
export function PersonLabel({person}:{person:Person}){return <><PersonAvatar person={person}/><span className={styles.detail}><strong>{person.display_name||person.id||person.uuid}</strong><small>{person.id||person.uuid}{person.contact?` · Trust ${person.trust}`:''}</small></span></>;}
export function ContactEditor({person,onSaved}:{person:Person;onSaved?:()=>void}){const cache=useQueryClient();const [name,setName]=useState(person.display_name||person.id||'');const [trust,setTrust]=useState(String(person.trust||1));const [busy,setBusy]=useState(false);const [error,setError]=useState('');return <div className={styles.editor}><Input label='Saved contact name' value={name} onChange={e=>setName(e.target.value)} maxLength={200}/><Input label='Trust (1–255)' type='number' min={1} max={255} value={trust} onChange={e=>setTrust(e.target.value)}/><p className={styles.hint}>1 means saved; 2 means trusted. Higher values rank contacts higher.</p>{error&&<p role='alert'>{error}</p>}<Button type='button' loading={busy} disabled={!name.trim()||!Number.isInteger(Number(trust))||Number(trust)<1||Number(trust)>255} onClick={async()=>{setBusy(true);setError('');try{const c=person.contact;await contactsApi('contacts','POST',{id:person.uuid,name:name.trim(),trust:Number(trust),note:c?.note??'',phone:c?.phone??'',email:c?.email??'',photo_id:c?.photo_id??null,birthday_month:c?.birthday_month??null,birthday_day:c?.birthday_day??null,birthday_year:c?.birthday_year??null});await cache.invalidateQueries({queryKey:['contacts','list']});onSaved?.();}catch(e){setError(e instanceof Error?e.message:'Could not save this contact.');}finally{setBusy(false);}}}>Save contact</Button></div>;}
function matchesIdentity(person: Person, value: string) {
 return person.uuid === value || person.id?.toLowerCase() === value.toLowerCase();
}

function useSelectedPerson(value: string, data: ReturnType<typeof usePeople>) {
 const target = value.trim().toLowerCase();
 const [query, setQuery] = useState(target);
 useEffect(() => {
   const timer = setTimeout(() => setQuery(target), 250);
   return () => clearTimeout(timer);
 }, [target]);
 const known = data.people.find(person => matchesIdentity(person, target));
 const lookup = useQuery({
   queryKey: ['people', 'lookup', data.accountUuid, query],
   queryFn: ({signal}) => contactsApi<Person>(`lookup?q=${encodeURIComponent(query)}`, 'GET', undefined, signal),
   enabled: !!data.accountUuid && query === target && !known?.contact?.photo_id &&
     (/^(?:c:|si:)[^\s]{2,}$/i.test(query) || /^[a-f0-9-]{36}$/i.test(query)),
   retry: false,
   staleTime: 30_000,
 });
 const profile = lookup.data;
 if (!profile || !matchesIdentity(profile, target)) return known;
 const history = data.people.find(person => person.uuid === profile.uuid);
 const contact = data.contacts.data?.find(person => person.uuid === profile.uuid);
 return mergePeople(history ? [history, profile] : [profile], contact ? [contact] : [])[0];
}

type PersonFieldProps = {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  onSelect?: (person: Person) => void;
  allowContactEditing?: boolean;
  excludedRecipients?: ReadonlySet<string>;
};

export function PersonField({
  value, onChange, label = 'Carbon, Silicon or email', placeholder = 'c:name or si:name',
  disabled = false, onSelect, allowContactEditing = true, excludedRecipients,
}: PersonFieldProps) {
  const id = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const contactsAction = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<HTMLElement | null>(null);
  const [index, setIndex] = useState(-1);
  const [requesting, setRequesting] = useState(false);
  const [editing, setEditing] = useState(false);
  const data = usePeople(open || !!value.trim());
  const selected = useSelectedPerson(value, data);
  const available = (person: Person) => !excludedRecipients || ![person.uuid, person.id, person.contact?.email]
    .some(identity => identity && excludedRecipients.has(identity.toLowerCase()));
  const matches = data.people.filter(person => available(person) &&
    fuzzyMatch(value, [person.id, person.display_name, person.uuid, person.contact?.email].filter(Boolean).join(' ')),
  ).slice(0, 8);
  const suggestions = selected && available(selected) && !matches.some(person => person.uuid === selected.uuid)
    ? [selected, ...matches].slice(0, 8)
    : matches.map(person => person.uuid === selected?.uuid ? selected : person);
  const offerContacts = !!data.accountUuid && data.connection.data?.connected === false &&
    (!value.trim() || suggestions.length > 0);
  const partial = data.history.data?.partial;
  const visible = open && !disabled && (suggestions.length > 0 || offerContacts || !!partial);
  const active = visible && index >= 0 && index < suggestions.length ? index : -1;

  useEffect(() => {
    if (active >= 0) document.getElementById(`${id}-${active}`)?.scrollIntoView({block: 'nearest'});
  }, [active, id]);

  function choose(person: Person) {
    onChange(person.id || person.uuid);
    onSelect?.(person);
    setOpen(false);
    setIndex(-1);
    setEditing(false);
  }

  return <div className={styles.field} data-person-field>
    <Popover.Root open={visible} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div ref={anchor}>
          <Input ref={input} label={label} placeholder={placeholder} value={value} disabled={disabled}
            autoComplete="off" role="combobox" aria-autocomplete="list"
            aria-expanded={visible && suggestions.length > 0}
            aria-controls={visible && suggestions.length ? `${id}-list` : undefined}
            aria-activedescendant={active >= 0 ? `${id}-${active}` : undefined}
            onFocus={event => {
              setDialog(event.currentTarget.closest<HTMLElement>('[role="dialog"], dialog'));
              setOpen(true);
              setIndex(-1);
            }}
            onClick={() => setOpen(true)}
            onBlur={event => {
              if (!panel.current?.contains(event.relatedTarget)) setOpen(false);
            }}
            onChange={event => {
              onChange(event.target.value);
              setOpen(true);
              setIndex(-1);
              setEditing(false);
            }}
            onKeyDown={event => {
              if (event.key === 'Tab' && !event.shiftKey && visible && contactsAction.current) {
                event.preventDefault();
                contactsAction.current.focus();
              } else if (event.key === 'Escape' && open) {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setOpen(true);
                const last = suggestions.length - 1;
                setIndex(event.key === 'ArrowDown' ? Math.min(active + 1, last) : active < 0 ? last : Math.max(0, active - 1));
              } else if (event.key === 'Enter' && active >= 0) {
                event.preventDefault();
                choose(suggestions[active]);
              }
            }}/>
        </div>
      </Popover.Anchor>
      <Popover.Portal container={dialog}>
        <Popover.Content ref={panel} role="presentation" className={styles.popup} data-sq="surface"
          align="start" sideOffset={4} collisionPadding={8}
          onOpenAutoFocus={event => event.preventDefault()}
          onCloseAutoFocus={event => event.preventDefault()}
          onInteractOutside={event => { if (anchor.current?.contains(event.target as Node)) event.preventDefault(); }}>
          {suggestions.length > 0 && <div id={`${id}-list`} role="listbox" aria-label="People suggestions" className={styles.list}>
            {suggestions.map((person, i) => (
              <button id={`${id}-${i}`} key={person.uuid} className={styles.person} role="option"
                aria-selected={active === i} type="button" tabIndex={-1}
                onMouseDown={event => event.preventDefault()} onClick={() => choose(person)}>
                <PersonLabel person={person}/>
              </button>
            ))}
          </div>}
          {offerContacts && <Button ref={contactsAction} type="button" variant="ghost" size="sm" className={styles.connect}
            onKeyDown={event => {
              if (event.key !== 'Tab' && event.key !== 'Escape') return;
              event.stopPropagation();
              if (event.shiftKey || event.key === 'Escape') event.preventDefault();
              input.current?.focus({preventScroll: true});
              if (!event.shiftKey) setOpen(false);
            }}
            onMouseDown={event => event.preventDefault()} onClick={() => { setOpen(false); setRequesting(true); }}>
            Use saved contacts
          </Button>}
          {partial && <p className={styles.hint}>Some invitation history is temporarily unavailable.</p>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
    {requesting && <ContactAccess onGranted={() => setRequesting(false)} onCancel={() => setRequesting(false)}/>}
    {selected && <div className={styles.selected} data-sq="surface">
      <div className={styles.person}><PersonLabel person={selected}/></div>
      {allowContactEditing && data.connection.data?.connected && <>
        <Button type="button" variant="secondary" disabled={disabled} onClick={() => setEditing(!editing)}>
          {selected.contact ? 'Edit saved contact' : 'Save to Contacts'}
        </Button>
        {editing && <ContactEditor key={selected.uuid} person={selected} onSaved={() => setEditing(false)}/>}
      </>}
    </div>}
  </div>;
}

export function SavedPerson({person}:{person:Person}){const {people}=usePeople();const saved=people.find(p=>p.uuid===person.uuid);return <span className={styles.person}><PersonLabel person={{...person,...saved}}/></span>;}
function SelectedPerson({value}:{value:string}) {
 const data=usePeople();
 const person=useSelectedPerson(value,data)??{uuid:value,id:value};
 return <div className={styles.person}><PersonLabel person={person}/></div>;
}
export function AddPeople({value,onChange,label='Add a Carbon or Silicon',useIds=false,disabled=false}:{value:string;onChange:(value:string)=>void;label?:string;useIds?:boolean;disabled?:boolean}) {
 const [target,setTarget]=useState('');
 const lines=[...new Set(value.split(/[\n,]/).map(v=>v.trim()).filter(v=>/^(?:c:|si:)[^\s]+$/.test(v)||/^[a-f0-9-]{36}$/i.test(v)))];
 return <div><PersonField label={label} value={target} disabled={disabled} onChange={setTarget} onSelect={p=>{const entries=value.split('\n').map(v=>v.trim()).filter(Boolean);const selected=useIds?(p.id||p.uuid):p.uuid;if(!entries.includes(selected))onChange([...entries,selected].join('\n'));setTarget('');}}/>{lines.map(value=><SelectedPerson key={value} value={value}/>)}</div>;
}
