"use client";
import {useRef,useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {Section,Surface,Stack,Cluster} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {cellsRequest} from "@/lib/cells/api";
import {Failure,date} from "./shared";
interface Invitation {id:string;cell_id:string;status:string;created_at:string}
export function CellInvitations(){
  const query=useQuery({queryKey:["cells","invitations"],queryFn:({signal})=>cellsRequest<{invitations:Invitation[]}>("/invitations",{signal})});
  const invitations=query.data?.invitations.filter(i=>i.status==="pending")??[];
  if(!invitations.length&&!query.error)return null;
  return <Section title="Invitations"><Stack><Failure error={query.error}/>{invitations.map(invitation=><InvitationCard key={invitation.id} invitation={invitation}/>)}</Stack></Section>;
}
function InvitationCard({invitation}:{invitation:Invitation}){
  const cache=useQueryClient(),keys=useRef<Partial<Record<string,string>>>({}),running=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<unknown>(null);
  async function decide(decision:"accept"|"decline"){
    if(running.current)return;running.current=true;setBusy(true);setError(null);
    keys.current[decision]??=crypto.randomUUID();
    try{await cellsRequest(`/invitations/${invitation.id}/${decision}`,{method:"POST",key:keys.current[decision]});void cache.invalidateQueries({queryKey:["cells"]});}
    catch(cause){setError(cause);}finally{running.current=false;setBusy(false);}
  }
  return <Surface><Stack><Cluster justify="between"><div><strong>{invitation.cell_id}</strong><p>Invited {date(invitation.created_at)}</p></div><Cluster><Button loading={busy} onClick={()=>void decide("accept")}>Accept</Button><Button variant="secondary" disabled={busy} onClick={()=>void decide("decline")}>Decline</Button></Cluster></Cluster><Failure error={error}/></Stack></Surface>;
}
