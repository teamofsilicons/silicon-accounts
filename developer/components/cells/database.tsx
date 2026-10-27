"use client";
import {useState} from "react";
import {Section,Surface,Stack,Cluster} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Input} from "@/components/silicon-ui/input/input";
import {Textarea} from "@/components/silicon-ui/textarea/textarea";
import {Checkbox} from "@/components/silicon-ui/checkbox/checkbox";
import {Select} from "@/components/silicon-ui/select/select";
import {Dialog,DialogContent} from "@/components/silicon-ui/dialog/dialog";
import {cellsRequest} from "@/lib/cells/api";
import {useCellAction,useCellData,cellPath,Failure,date} from "./shared";
import styles from "./cells.module.css";
interface Table {name:string;kind:string;rls:boolean;columns:{name:string;type:string;nullable:boolean}[]}
interface SqlResult {rows:Record<string,unknown>[];rows_affected:number}
interface Migration {id:number;name:string;sql:string;source:string;created_at:string}
const quote=(name:string)=>`"${name.replaceAll('"','""')}"`;
export function CellDatabase({cellId}:{cellId:string}){
  const tables=useCellData<{tables:Table[]}>(cellId,"/tables"),migrations=useCellData<{migrations:Migration[]}>(cellId,"/migrations"),action=useCellAction(cellId);
  const [sql,setSql]=useState("SELECT 1 AS ready;"),[execute,setExecute]=useState(false),[result,setResult]=useState<SqlResult|null>(null),[create,setCreate]=useState(false),[exportError,setExportError]=useState<unknown>(null);
  async function run(){const value=await action.run<SqlResult>("/sql","POST",{sql,execute});if(value)setResult(value);}
  async function exportTypes(language:string){try{setExportError(null);const {source}=await cellsRequest<{source:string}>(cellPath(cellId,`/types/${language}`));const url=URL.createObjectURL(new Blob([source],{type:"text/plain"}));const link=document.createElement("a");link.href=url;link.download=`${cellId}.${language==="rust"?"rs":"ts"}`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){setExportError(error);}}
  const columns=result?Array.from(new Set(result.rows.flatMap(Object.keys))):[];
  return <Stack gap={8}>
    <Section title="Tables" description="New tables start with row-level security enabled and no public access." actions={<Button variant="secondary" onClick={()=>setCreate(true)}>Create table</Button>}><Stack><Failure error={tables.error??exportError}/>{tables.isPending?<p role="status">Loading tables…</p>:!tables.data?.tables.length?<p>No public tables yet.</p>:tables.data.tables.map(table=><Surface key={table.name}><Stack><Cluster justify="between"><strong>{table.name}</strong><span className={styles.muted}>{table.rls?"Row-level security enabled":table.kind==="v"?"View":"Row-level security disabled"}</span><Button variant="ghost" size="sm" onClick={()=>{setSql(`SELECT * FROM public.${quote(table.name)} LIMIT 100;`);setExecute(false);setResult(null);}}>Prepare row query</Button></Cluster><details><summary>Columns ({table.columns.length})</summary><div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>Name</th><th>Type</th><th>Nullable</th></tr></thead><tbody>{table.columns.map(column=><tr key={column.name}><td>{column.name}</td><td>{column.type}</td><td>{column.nullable?"Yes":"No"}</td></tr>)}</tbody></table></div></details></Stack></Surface>)}
      <Cluster><Button variant="secondary" onClick={()=>void exportTypes("typescript")}>Download TypeScript types</Button><Button variant="secondary" onClick={()=>void exportTypes("rust")}>Download Rust types</Button></Cluster>
    </Stack></Section>
    <Section title="SQL" description="Run SQL as the cell’s database owner. Schema changes are recorded in migration history."><form onSubmit={e=>{e.preventDefault();void run();}}><Stack><Failure error={action.error}/><Textarea className={styles.codeInput} label="SQL statement" required value={sql} onChange={e=>setSql(e.target.value)} spellCheck={false}/><Checkbox label="Execute without returning rows" description="Use for schema changes or statements that do not return a result set." checked={execute} onCheckedChange={value=>setExecute(value===true)}/><Button type="submit" loading={action.busy}>Run SQL</Button></Stack></form>
      {result&&<Stack><p role="status">{result.rows_affected} {execute?"rows affected":"rows returned"}.</p>{result.rows.length>0&&<div className={styles.tableWrap}><table className={styles.table}><thead><tr>{columns.map(c=><th key={c}>{c}</th>)}</tr></thead><tbody>{result.rows.map((row,i)=><tr key={i}>{columns.map(c=><td key={c}>{row[c]===null?<em>NULL</em>:typeof row[c]==="object"?JSON.stringify(row[c]):String(row[c]??"")}</td>)}</tr>)}</tbody></table></div>}</Stack>}
    </Section>
    <Section title="Migrations"><Stack><Failure error={migrations.error}/>{migrations.isPending?<p role="status">Loading migrations…</p>:migrations.data?.migrations.length?migrations.data.migrations.map(m=><Surface key={m.id}><details><summary>{m.name} · {m.source} · {date(m.created_at)}</summary><pre className={styles.pre}>{m.sql}</pre></details></Surface>):!migrations.error&&<p>No migrations yet.</p>}</Stack></Section>
    <Dialog open={create} onOpenChange={setCreate}><DialogContent title="Create table" description="The table is private until you add access rules.">{create&&<CreateTable cellId={cellId} onDone={()=>setCreate(false)}/>}</DialogContent></Dialog>
  </Stack>;
}
function CreateTable({cellId,onDone}:{cellId:string;onDone:()=>void}){
  const action=useCellAction(cellId),[name,setName]=useState("");
  const [columns,setColumns]=useState([{name:"id",data_type:"uuid",nullable:false,primary_key:true,default:"gen_random_uuid()"},{name:"name",data_type:"text",nullable:false,primary_key:false,default:""}]);
  function update(index:number,change:Partial<typeof columns[number]>){setColumns(items=>items.map((item,i)=>i===index?{...item,...change}:item));}
  return <form onSubmit={async e=>{e.preventDefault();if(await action.run("/schema","POST",{action:"create_table",table:name,columns:columns.map(c=>({...c,default:c.default||null}))}))onDone();}}><Stack><Failure error={action.error}/><Input label="Table name" required value={name} onChange={e=>setName(e.target.value)}/>
    {columns.map((column,index)=><Stack key={index}><Input label={`Column ${index+1} name`} required value={column.name} onChange={e=>update(index,{name:e.target.value})}/><Select label="Type" value={column.data_type} onValueChange={value=>update(index,{data_type:value,default:""})} options={["text","uuid","integer","bigint","boolean","timestamptz","jsonb","numeric"].map(t=>({value:t,label:t}))}/><Cluster><Checkbox label="Nullable" checked={column.nullable} onCheckedChange={value=>update(index,{nullable:value===true})}/><Checkbox label="Primary key" checked={column.primary_key} onCheckedChange={value=>update(index,{primary_key:value===true})}/><Button type="button" variant="ghost" size="sm" disabled={columns.length===1} onClick={()=>setColumns(items=>items.filter((_,i)=>i!==index))}>Remove column</Button></Cluster><Input label="Default expression (optional)" value={column.default} onChange={e=>update(index,{default:e.target.value})}/></Stack>)}
    <Cluster><Button type="button" variant="secondary" onClick={()=>setColumns(items=>[...items,{name:"",data_type:"text",nullable:true,primary_key:false,default:""}])}>Add column</Button><Button type="submit" loading={action.busy}>Create table</Button></Cluster>
  </Stack></form>;
}
