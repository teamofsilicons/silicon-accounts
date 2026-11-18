"use client";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {Section,Stack,Surface,Cluster} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Failure} from "@/components/cells/shared";
import {request,type Me} from "./api";

export function InterfaceInvitations() {
  const cache=useQueryClient();
  const me=useQuery({queryKey:["interfaces","me"],queryFn:()=>request<Me>("me")});
  const respond=useMutation({
    mutationFn:({id,decision}:{id:string;decision:"accept"|"decline"})=>request(`invites/${id}/${decision}`,{method:"POST",body:{}}),
    onSuccess:()=>cache.invalidateQueries({queryKey:["interfaces"]}),
  });
  const pending=me.data?.invites?.filter(invite=>invite.status==="pending")??[];
  if(!pending.length&&!me.error)return null;
  return <Section title="Interface invitations"><Stack>
    <Failure error={me.error??respond.error}/>
    {pending.map(invite=><Surface key={invite.id}><Stack><strong>{invite.interface_name||invite.interface_id}</strong>
      {invite.target_uuid?.startsWith("org:")&&<p>Invited organization · {invite.target_uuid.slice(4)}</p>}
      <Cluster><Button disabled={respond.isPending} onClick={()=>respond.mutate({id:invite.id,decision:"accept"})}>Accept</Button>
        <Button variant="secondary" disabled={respond.isPending} onClick={()=>respond.mutate({id:invite.id,decision:"decline"})}>Decline</Button></Cluster>
    </Stack></Surface>)}
  </Stack></Section>;
}
