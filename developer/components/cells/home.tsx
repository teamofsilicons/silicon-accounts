"use client";
import Link from "next/link";
import {useRef,useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {Page,PageHeader,Section,Surface,Grid,Stack,Cluster} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Input} from "@/components/silicon-ui/input/input";
import {Alert} from "@/components/silicon-ui/alert/alert";
import {Dialog,DialogContent} from "@/components/silicon-ui/dialog/dialog";
import {SecretReveal} from "@/components/developer/parts/secret-reveal";
import {CopyField} from "@/components/developer/parts/copy-field";
import {ApiError} from "@/lib/api/errors";
import {cellsApi,type CreatedCell} from "@/lib/cells/api";
import {paths} from "@/lib/navigation";
import {useCellsLeaveGuard} from "./shared";
import {CellInvitations} from "./invitations";
import {CellIdInput} from "./cell-id-input";
import styles from "./cells.module.css";

export function CellsHome(){
  const cache=useQueryClient();
  const query=useQuery({queryKey:["cells","list"],queryFn:({signal})=>cellsApi.list(signal)});
  const [open,setOpen]=useState(false),[name,setName]=useState(""),[id,setId]=useState("");
  const [busy,setBusy]=useState(false),[failure,setFailure]=useState<unknown>(null),[created,setCreated]=useState<CreatedCell|null>(null);
  const inFlight=useRef(false);
  useCellsLeaveGuard(busy||created!==null,"Save your new cell credentials before leaving. They are shown only once.");
  const operation=useRef<{input:string;key:string}|null>(null);
  async function create(){
    if(inFlight.current)return;inFlight.current=true;
    const input=JSON.stringify([name,id]);if(operation.current?.input!==input)operation.current={input,key:crypto.randomUUID()};
    setBusy(true);setFailure(null);
    try{const result=await cellsApi.create(name,id,operation.current.key);setCreated(result);operation.current=null;void cache.invalidateQueries({queryKey:["cells","list"]});}
    catch(error){setFailure(error);}finally{inFlight.current=false;setBusy(false);}
  }
  return <Page><PageHeader title="Your cells" description="A backend for each thing you build." actions={<Button onClick={()=>setOpen(true)}>Create cell</Button>}/>
    {query.error&&<Alert tone="danger" title={ApiError.from(query.error).message}>{ApiError.from(query.error).hint}</Alert>}
    {query.isPending?<p role="status">Loading your cells…</p>:<><Section title="Cells you author" hideTitle>
      {!query.data?.cells.some(cell=>cell.status!=="deleted")?<Surface><p>No active cells yet. Create one here, or connect a cell from an app or interface.</p></Surface>:<Grid>{query.data.cells.filter(cell=>cell.status!=="deleted").map(cell=><Surface key={cell.uuid} className={styles.card}>
        <div><Link className={styles.cellName} href={paths.cell(cell.cell_id)}>{cell.name}</Link><p className={styles.muted}>{cell.cell_id}</p></div>
        <Cluster justify="between"><span className={styles.status}>{cell.status}</span><Link href={paths.cell(cell.cell_id)}>Open cell →</Link></Cluster>
      </Surface>)}</Grid>}
    </Section>{!!query.data?.cells.some(cell=>cell.status==="deleted")&&<Section title="Deleted cells" description="Deleted cells can be restored within 30 days."><Grid>{query.data.cells.filter(cell=>cell.status==="deleted").map(cell=><Surface key={cell.uuid} className={styles.card}><div><Link className={styles.cellName} href={paths.cell(cell.cell_id)}>{cell.name}</Link><p className={styles.muted}>{cell.cell_id}</p></div><Link href={paths.cell(cell.cell_id)}>View deleted cell →</Link></Surface>)}</Grid></Section>}</>}
    <CellInvitations/>
    <Dialog open={open} onOpenChange={value=>{if(!busy&&!created)setOpen(value);}}><DialogContent title={created?"Your cell is ready":"Create a cell"} description={created?"Save the server credentials before continuing.":"Its ID becomes its address and stays reserved permanently."}>
      {created?<Stack><CopyField label="Cell URL" value={created.cell.url}/><CopyField label="Publishable key" value={created.publishable_key}/><SecretReveal title="Server credentials" description="Keep these on your backend. Your frontend uses the publishable key." secrets={[{label:"Secret key",value:created.secret_key},{label:"Database connection",value:created.database_url}]} onDone={()=>{setCreated(null);setOpen(false);setName("");setId("");}} doneLabel="I’ve saved these credentials"/></Stack>:<form onSubmit={event=>{event.preventDefault();void create();}}><Stack>
        {failure!=null&&<Alert tone="danger" title={ApiError.from(failure).message}>{ApiError.from(failure).hint}</Alert>}
        <Input label="Name" required maxLength={100} value={name} disabled={busy} onChange={e=>setName(e.target.value)}/>
        <CellIdInput value={id} disabled={busy} onChange={setId}/><p>Cell URL: https://{id||"your-cell-id"}.cells.teamofsilicons.com</p>
        <Button type="submit" loading={busy}>Create cell</Button>
      </Stack></form>}
    </DialogContent></Dialog>
  </Page>;
}
