"use client";
import {useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {Section,Surface,Stack,Cluster} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Alert} from "@/components/silicon-ui/alert/alert";
import {CopyField} from "@/components/developer/parts/copy-field";
import {cellsRequest} from "@/lib/cells/api";
import {cellPath,useCellAction,Failure,date} from "./shared";
import styles from "./cells.module.css";

interface Delivery {id:string;kind:string;recipient:string;status:string;attempts:number;last_error:string|null;created_at:string;sent_at:string|null;next_at:string}
interface Page {configured:boolean;active:boolean;deliveries:Delivery[];next:string|null}
const reasons:Record<string,string>={
  ting_subscription_required:"This recipient has not enabled Cells notifications in Ting yet.",
  recipient_no_longer_eligible:"This recipient no longer has access, the invitation ended, or the cell was stopped.",
  ting_rate_limited:"Ting asked Cells to wait before trying again.",
  ting_authorization_failed:"Ting refused the service’s sign-in. Delivery will retry.",
  ting_proof_unavailable:"The service could not sign in to Ting. Delivery will retry.",
  ting_conflict:"Ting reported a conflict. Check delivery before retrying.",
  ting_request_rejected:"Ting rejected this notification. Retry after the cause is fixed.",
  ting_invalid_receipt:"Ting did not confirm acceptance. Delivery will retry.",
  ting_unavailable:"Ting is unavailable. Delivery will retry.",
  ting_unreachable:"Ting could not be reached. Delivery will retry.",
};
export function CellNotifications({cellId}:{cellId:string}){
  const [pages,setPages]=useState<(string|null)[]>([null]);
  const cursor=pages.at(-1),tail=`/notifications${cursor?`?before=${encodeURIComponent(cursor)}`:""}`;
  const query=useQuery({queryKey:["cells",cellId,tail],queryFn:({signal})=>cellsRequest<Page>(cellPath(cellId,tail),{signal}),refetchInterval:10000});
  const retry=useCellAction(cellId);
  return <Section title="Notifications" description="Delivery records for this cell’s Silicon Ting notifications." actions={<Button variant="ghost" loading={query.isFetching} onClick={()=>void query.refetch()}>Refresh notifications</Button>}><Stack>
    <Failure error={query.error??retry.error}/>
    {query.data&&!query.data.configured&&<Alert tone="info" title="Delivery is paused">The service has not connected to Silicon Ting. Queued records are retained.</Alert>}
    <details><summary>Receive Cells notifications</summary><p className={styles.muted}>After signing in to the Cells CLI, run this once to allow Cells notifications through Silicon Ting.</p><CopyField label="Enable notifications" value="silicon-cells notifications enable"/></details>
    {query.isPending?<p role="status">Loading notifications…</p>:query.data?.deliveries.length===0?<p>No notification records on this page.</p>:query.data?.deliveries.map(item=><Surface key={item.id}><Stack>
      <Cluster justify="between"><strong>{item.kind}</strong><span>{item.status==="sent"?"Accepted by Ting":item.status}</span></Cluster>
      <p className={styles.muted}>{date(item.created_at)} · Recipient {item.recipient} · {item.attempts} {item.attempts===1?"attempt":"attempts"}</p>
      {item.last_error&&<p>{reasons[item.last_error]??"Delivery could not complete. Check the service and retry."}</p>}
      {item.sent_at&&<p className={styles.muted}>Accepted {date(item.sent_at)}</p>}
      {["pending","waiting"].includes(item.status)&&query.data?.configured&&<p className={styles.muted}>Next attempt {date(item.next_at)}</p>}
      {query.data?.active&&query.data.configured&&["failed","waiting"].includes(item.status)&&<Button variant="secondary" size="sm" loading={retry.busy} onClick={()=>void retry.run(`/notifications/${item.id}/retry`,"POST")}>Retry notification</Button>}
    </Stack></Surface>)}
    <Cluster><Button variant="secondary" disabled={pages.length===1||query.isFetching} onClick={()=>setPages(p=>p.slice(0,-1))}>Newer notifications</Button><Button variant="secondary" disabled={!query.data?.next||query.isFetching} onClick={()=>{if(query.data?.next)setPages(p=>[...p,query.data!.next]);}}>Older notifications</Button></Cluster>
  </Stack></Section>;
}
