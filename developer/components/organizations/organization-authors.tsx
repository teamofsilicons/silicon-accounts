"use client";

import {useState} from "react";
import {Section, Stack, Cluster} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Input} from "@/components/silicon-ui/input/input";
import {Alert} from "@/components/silicon-ui/alert/alert";

type Props = {
  organizations: string[];
  canManage: boolean;
  invite: (id:string)=>Promise<unknown>;
  remove: (id:string)=>Promise<unknown>;
};

export function OrganizationAuthors({organizations,canManage,invite,remove}:Props) {
  const [id,setId]=useState("");
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  const [error,setError]=useState("");
  const [removing,setRemoving]=useState<string|null>(null);
  const target=id.trim().toLowerCase().replace(/^org:/,"");
  async function change(action:()=>Promise<unknown>,message:string) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); setNotice(message); setId(""); setRemoving(null); }
    catch(e) { setError(e instanceof Error?e.message:"The author list could not be updated."); }
    finally { setBusy(false); }
  }
  if(!canManage && !organizations.length) return null;
  return <Section title="Organization authors"><Stack>
    {organizations.map(org=><Cluster key={org} justify="between"><strong>{org}</strong>
      {canManage && (removing===org ? <Cluster><Button size="sm" disabled={busy} variant="secondary" onClick={()=>setRemoving(null)}>Cancel</Button>
        <Button size="sm" variant="danger" loading={busy} onClick={()=>void change(()=>remove(org),`Removed ${org}.`)}>Confirm removal</Button></Cluster>
        : <Button size="sm" variant="ghost" disabled={busy} onClick={()=>setRemoving(org)} aria-label={`Remove organization ${org}`}>Remove</Button>)}
    </Cluster>)}
    {canManage&&<form onSubmit={event=>{event.preventDefault();if(!busy&&/^[a-z0-9_-]{3,30}$/.test(target))void change(()=>invite(target),`Invitation sent to ${target}.`);}}><Stack>
      <Input label="Organization ID" value={id} disabled={busy} onChange={event=>setId(event.target.value)} description="A manager accepts for the organization. Its publishing permissions determine which members can contribute."/>
      <div><Button variant="secondary" type="submit" loading={busy} disabled={!/^[a-z0-9_-]{3,30}$/.test(target)}>Invite organization</Button></div>
    </Stack></form>}
    {notice&&<p role="status">{notice}</p>}{error&&<Alert tone="danger" title={error}/>}
  </Stack></Section>;
}
