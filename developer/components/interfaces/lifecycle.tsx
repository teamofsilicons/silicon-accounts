"use client";

import {useEffect,useState} from "react";
import {useRouter} from "next/navigation";
import {useMutation,useQuery,useQueryClient} from "@tanstack/react-query";
import {Section,Stack,Cluster} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {DeleteResourceForm} from "@/components/developer/parts/delete-resource-form";
import {Failure} from "@/components/cells/shared";
import {request,type Interface} from "./api";

export function InterfaceSettings({item,disabled}:{item:Interface;disabled:boolean}) {
  const cache=useQueryClient();
  const router=useRouter();
  const deletion=useMutation({
    mutationFn:(confirmedId:string)=>request(`interfaces/${encodeURIComponent(item.interface_id)}`,{method:"DELETE",body:{revision:item.revision,interface_id:confirmedId}}),
    onSuccess:async()=>{await cache.invalidateQueries({queryKey:["interfaces"]});cache.removeQueries({queryKey:["interface",item.interface_id]});router.push("/interfaces");},
  });
  if(!item.permissions?.manage)return <Section title="Interface settings"><p>Deleting this interface requires management permission.</p></Section>;
  return <DeleteResourceForm kind="interface" id={item.interface_id}
    description="Deletion removes the listing and disables interface sign-in. You can restore the interface within 30 days. Its ID stays reserved."
    disabled={disabled} pending={deletion.isPending} error={<Failure error={deletion.error}/>} remove={id=>deletion.mutate(id)}/>;
}

type DeletedInterface={interface_id:string;name:string;revision:number;restore_until:number};
export function DeletedInterfaces() {
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),60_000);return ()=>clearInterval(timer);},[]);
  const cache=useQueryClient();
  const deleted=useQuery({queryKey:["interfaces","deleted"],queryFn:()=>request<{interfaces:DeletedInterface[]}>("interfaces?mine=true&deleted=true")});
  const restore=useMutation({
    mutationFn:(item:DeletedInterface)=>request(`interfaces/${encodeURIComponent(item.interface_id)}/restore`,{method:"POST",body:{revision:item.revision}}),
    onSuccess:async(_result,item)=>{await Promise.all([cache.invalidateQueries({queryKey:["interfaces"]}),cache.invalidateQueries({queryKey:["interface",item.interface_id]})]);},
  });
  if(!deleted.error&&!deleted.data?.interfaces.length)return null;
  return <Section title="Deleted interfaces" description="You can restore a deleted interface within 30 days."><Stack>
    <Failure error={deleted.error??restore.error}/>
    {deleted.data?.interfaces.map(item=><Cluster key={item.interface_id} justify="between">
      <div><strong>{item.name}</strong><p>{item.interface_id} · Recover until {new Date(item.restore_until*1000).toLocaleDateString()}</p></div>
      <Button disabled={restore.isPending||now>=item.restore_until*1000} onClick={()=>restore.mutate(item)}>Restore interface</Button>
    </Cluster>)}
  </Stack></Section>;
}
