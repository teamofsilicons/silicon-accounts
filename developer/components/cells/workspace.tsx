"use client";
import Link from "next/link";
import {Page,PageHeader,Stack,Section,Surface,DescriptionList,DescriptionItem} from "@/components/foundation/layout/layout";
import {Alert} from "@/components/silicon-ui/alert/alert";
import {Button} from "@/components/silicon-ui/button/button";
import {CopyField} from "@/components/developer/parts/copy-field";
import {paths} from "@/lib/navigation";
import type {Cell} from "@/lib/cells/api";
import {useCellAction,useCellData,Failure,date} from "./shared";
import {CellFiles} from "./files";
import {CellDatabase} from "./database";
import {CellEventTings} from "./event-tings";
import {CellLogs} from "./logs";
import {CellUsage} from "./usage";
import {CellCopies} from "./copies";
import {CellBackups} from "./backups";
import {CellDomains} from "./domains";
import {CellTemplates} from "./templates";
import {CellServices} from "./services";
import {CellRealtime} from "./realtime";
import {CellJobs} from "./jobs";
import {CellTriggers} from "./triggers";
import {CellQueues} from "./queues";
import {CellWebhooks} from "./webhooks";
import {CellFunctions} from "./functions";
import {CellAuthors,CellHistory,CellSettings} from "./management";
import styles from "./cells.module.css";
const tabs=["overview","database","files","functions","webhooks","queues","triggers","jobs","realtime","services","templates","tings","domains","copies","backups","usage","logs","authors","settings","history"] as const;
export function CellWorkspace({cellId,tab}:{cellId:string;tab:string}){
  const query=useCellData<{cell:Cell}>(cellId,"");
  const restore=useCellAction(cellId);
  const cell=query.data?.cell;
  return <Page><PageHeader title={cell?.name??cellId} description={cell?.url} back={{href:paths.cells,label:"Your cells"}}/>
    <Failure error={query.error}/>{query.isPending&&<p role="status">Loading cell…</p>}
    {cell&&<><nav className={styles.tabs} aria-label="Cell sections">{tabs.map(t=><Link key={t} href={paths.cell(cellId,t)} data-sq="surface" className={styles.tab} aria-current={tab===t?"page":undefined}>{t[0].toUpperCase()+t.slice(1)}</Link>)}</nav>
      {cell.status!=="active"&&<Alert tone="warning" title={`This cell is ${cell.status}.`}>{cell.status==="restoring"?"Database recovery is in progress. Follow it in Backups.":cell.status==="failed"?"Recovery failed. Review the error and retry the operation in Backups.":cell.status==="deleted"?<>Restore within 30 days of deletion. The Cell admin can restore it. {" "}<Button loading={restore.busy} onClick={()=>void restore.run("/restore","POST")}>Restore cell</Button></>:`This cell is ${cell.status}.`}</Alert>}
      <Failure error={restore.error}/>
      {tab==="usage"?<CellUsage cellId={cellId}/>:tab==="copies"?<CellCopies cell={cell}/>:tab==="logs"?<CellLogs cellId={cellId}/>:tab==="backups"?<CellBackups cell={cell}/>:tab==="settings"?<CellSettings cell={cell}/>:tab==="history"?<CellHistory cellId={cellId}/>:tab==="authors"?<CellAuthors cellId={cellId} active={cell.status==="active"}/>:tab==="overview"?<Overview cell={cell}/>:cell.status!=="active"?null:tab==="files"?<CellFiles cell={cell}/>:tab==="functions"?<CellFunctions cellId={cellId}/>:tab==="webhooks"?<CellWebhooks cellId={cellId}/>:tab==="queues"?<CellQueues cellId={cellId}/>:tab==="triggers"?<CellTriggers cellId={cellId}/>:tab==="jobs"?<CellJobs cellId={cellId}/>:tab==="realtime"?<CellRealtime cellId={cellId}/>:tab==="services"?<CellServices cellId={cellId}/>:tab==="templates"?<CellTemplates cellId={cellId}/>:tab==="domains"?<CellDomains cellId={cellId}/>:tab==="tings"?<CellEventTings cellId={cellId}/>:<CellDatabase cellId={cellId}/>}
    </>}
  </Page>;
}
function Overview({cell}:{cell:Cell}){
  return <Stack gap={8}><Section title="Connection"><Surface><Stack><CopyField label="Cell URL" value={cell.url}/>{cell.auth_url&&cell.auth_url!==cell.url&&<CopyField label="Authentication URL" value={cell.auth_url} description="Use this address for cookie-based sign-in; it stays the same when the Cell ID changes."/>}<p className={styles.muted}>Use a publishable key and a signed-in account in your frontend. Keep secret keys and database credentials on your backend.</p><Link href={paths.cell(cell.cell_id,"settings")}>Manage keys and settings →</Link></Stack></Surface></Section>
    <Section title="Cell"><DescriptionList><DescriptionItem label="ID">{cell.cell_id}</DescriptionItem><DescriptionItem label="Status">{cell.status}</DescriptionItem><DescriptionItem label="Created">{date(cell.created_at)}</DescriptionItem>{cell.deleted_at&&<DescriptionItem label="Deleted">{date(cell.deleted_at)}</DescriptionItem>}</DescriptionList></Section></Stack>;
}
