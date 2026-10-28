"use client";
import {useState} from "react";
import {Section,Surface,Stack,Cluster} from "@/components/foundation/layout/layout";
import {Button} from "@/components/silicon-ui/button/button";
import {Input} from "@/components/silicon-ui/input/input";
import {Textarea} from "@/components/silicon-ui/textarea/textarea";
import {Select} from "@/components/silicon-ui/select/select";
import {Dialog,DialogContent} from "@/components/silicon-ui/dialog/dialog";
import {cellsRequest} from "@/lib/cells/api";
import {useCellAction,useCellData,useCellsLeaveGuard,cellPath,Failure,date} from "./shared";
import styles from "./cells.module.css";

interface Summary {name:string;active_version:string|null;created_at:string;updated_at:string}
interface Version {id:string;created_at:string;created_by:string}
interface Definition {runtime:"javascript"|"wasm";entrypoint:string;files:Record<string,string>;timeout_ms:number;memory_mb:number;allowed_origins:string[];routes:{method:string;path:string}[]}
interface Invocation {id:string;status:string;response_status:number|null;version:string;started_at:string;finished_at:string|null;duration_ms:number|null;error_code:string|null;logs:string[]}
interface Result {status:number;headers:Record<string,string>;body:string;invocation_id:string}
interface Editing {name:string;definition:Definition;fresh:boolean}
const tail=(name:string)=>`/functions/${encodeURIComponent(name)}`;
function encode(text:string){let binary="";for(const byte of new TextEncoder().encode(text))binary+=String.fromCharCode(byte);return btoa(binary);}
function decode(encoded:string){return new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)));}
const example="export default async function (request: Request): Promise<Response> {\n  return Response.json({ message: \"Hello from your cell\" });\n}\n";

export function CellFunctions({cellId}:{cellId:string}){
  const query=useCellData<{functions:Summary[]}>(cellId,"/functions");
  const [selected,setSelected]=useState<string|null>(null),[editing,setEditing]=useState<Editing|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState<unknown>(null),[editorChanged,setEditorChanged]=useState(false),[editorBusy,setEditorBusy]=useState(false),[discard,setDiscard]=useState(false);
  function openEditor(value:Editing){setEditorChanged(value.fresh);setEditing(value);}
  async function edit(name:string,version:string){
    setLoading(true);setError(null);
    try{const result=await cellsRequest<{definition:Definition}>(cellPath(cellId,`${tail(name)}/versions/${encodeURIComponent(version)}`));openEditor({name,definition:result.definition,fresh:false});}
    catch(cause){setError(cause);}finally{setLoading(false);}
  }
  return <Stack gap={8}>
    <Section title="Functions" description="Deploy endpoints from TypeScript or JavaScript, and bring back any earlier version." actions={<Button onClick={()=>openEditor({name:"",fresh:true,definition:{runtime:"javascript",entrypoint:"index.ts",files:{"index.ts":encode(example)},timeout_ms:30000,memory_mb:128,allowed_origins:[],routes:[]}})}>Create function</Button>}>
      <Stack><Failure error={query.error??error}/>{query.isPending?<p role="status">Loading functions…</p>:query.data?.functions.length?query.data.functions.map(fn=><Surface key={fn.name}><Stack><Cluster justify="between"><div><strong>{fn.name}</strong><p className={styles.muted}>{fn.active_version?"Active":"Disabled"} · Updated {date(fn.updated_at)}</p></div><Button variant={selected===fn.name?"secondary":"ghost"} onClick={()=>setSelected(fn.name)}>Open function</Button></Cluster><code>/functions/{fn.name}</code></Stack></Surface>):!query.error&&<p>Create your first endpoint, or deploy a source folder with the Cells CLI.</p>}</Stack>
    </Section>
    {selected&&<FunctionDetails key={selected} cellId={cellId} name={selected} onEdit={edit} loading={loading}/>}
    <Dialog open={editing!==null} onOpenChange={value=>{if(!value&&!editorBusy){if(editorChanged)setDiscard(true);else setEditing(null);}}}><DialogContent title={editing?.fresh?"Create function":"Edit function"} description="Deploying creates an immutable version and makes it active.">{editing&&<FunctionEditor key={`${editing.name}:${editing.fresh}`} cellId={cellId} editing={editing} onChanged={()=>setEditorChanged(true)} onBusy={setEditorBusy} onDone={name=>{setSelected(name);setEditing(null);}}/>}</DialogContent></Dialog>
    <Dialog open={discard} onOpenChange={setDiscard}><DialogContent title="Discard these changes?" description="Your edits have not been deployed. Existing deployed versions are kept."><Cluster><Button variant="secondary" onClick={()=>setDiscard(false)}>Keep editing</Button><Button variant="danger" onClick={()=>{setDiscard(false);setEditing(null);}}>Discard edits</Button></Cluster></DialogContent></Dialog>
  </Stack>;
}

function FunctionEditor({cellId,editing,onDone,onChanged,onBusy}:{cellId:string;editing:Editing;onDone:(name:string)=>void;onChanged:()=>void;onBusy:(busy:boolean)=>void}){
  const action=useCellAction(cellId),[name,setName]=useState(editing.name),[definition,setDefinition]=useState(editing.definition),[file,setFile]=useState(editing.definition.entrypoint),[addName,setAddName]=useState(""),[origins,setOrigins]=useState(editing.definition.allowed_origins.join("\n")),[routes,setRoutes]=useState(JSON.stringify(editing.definition.routes,null,2)),[dirty,setDirty]=useState(editing.fresh),[error,setError]=useState<unknown>(null);
  useCellsLeaveGuard(dirty||action.busy,"Your function has changes that have not been deployed.");
  function update(change:Partial<Definition>){setDefinition(value=>({...value,...change}));setDirty(true);onChanged();}
  let source:string|null=null;try{source=decode(definition.files[file]??"");}catch{/* Binary assets are preserved without pretending they are editable text. */}
  async function deploy(){
    setError(null);onBusy(true);
    try{
      const parsed:unknown=JSON.parse(routes);if(!Array.isArray(parsed)||parsed.some(route=>typeof route!=="object"||route===null||typeof route.method!=="string"||typeof route.path!=="string"))throw new Error("Routes must be an array of method and path objects.");
      const result=await action.run(`${tail(name)}`,"PUT",{...definition,allowed_origins:origins.split("\n").map(s=>s.trim()).filter(Boolean),routes:parsed});
      if(result){setDirty(false);onDone(name);}
    }catch(cause){setError(cause);}finally{onBusy(false);}
  }
  function add(){
    const value=addName.trim();if(!value||value.includes("\\")||value.includes(":")||value.split("/").some(p=>!p||p==="."||p==="..")){setError(new Error("Use a relative source filename without dot or parent segments."));return;}
    if(Object.hasOwn(definition.files,value)){setError(new Error("This file already exists."));return;}
    update({files:{...definition.files,[value]:encode("")}});setFile(value);setAddName("");setError(null);
  }
  return <form onSubmit={e=>{e.preventDefault();void deploy();}}><Stack>
    <Failure error={error??action.error}/><Input label="Function name" required pattern="[a-z][a-z0-9_-]{0,62}" value={name} disabled={!editing.fresh||action.busy} onChange={e=>{setName(e.target.value);setDirty(true);onChanged();}}/>
    <p className={styles.muted}>Runtime: {definition.runtime==="javascript"?"TypeScript / JavaScript":"WebAssembly"}. Use the CLI to deploy binary files and larger source folders.</p>
    <Select label="Source file" disabled={action.busy} value={file} onValueChange={setFile} options={Object.keys(definition.files).map(path=>({value:path,label:path}))}/>
    {source!==null?<Textarea label={`Source: ${file}`} className={styles.codeInput} value={source} spellCheck={false} disabled={action.busy} onChange={e=>update({files:{...definition.files,[file]:encode(e.target.value)}})}/>:<p>This file contains binary bytes and is preserved unchanged.</p>}
    <Cluster><Input label="New source filename" disabled={action.busy} value={addName} onChange={e=>setAddName(e.target.value)} placeholder="lib/helper.ts"/><Button type="button" variant="secondary" disabled={action.busy} onClick={add}>Add file</Button><Button type="button" variant="ghost" disabled={action.busy||file===definition.entrypoint} onClick={()=>{const files={...definition.files};delete files[file];update({files});setFile(definition.entrypoint);}}>Remove selected file</Button></Cluster>
    <Select label="Entrypoint" disabled={action.busy} value={definition.entrypoint} onValueChange={entrypoint=>update({entrypoint})} options={Object.keys(definition.files).filter(path=>definition.runtime==="wasm"?path.endsWith(".wasm"):/\.(ts|js|mjs)$/u.test(path)).map(path=>({value:path,label:path}))}/>
    <Cluster><Input label="Timeout (milliseconds)" disabled={action.busy} type="number" min={50} max={300000} required value={definition.timeout_ms} onChange={e=>update({timeout_ms:Number(e.target.value)})}/><Input label="Memory (MiB)" disabled={action.busy} type="number" min={32} max={2048} required value={definition.memory_mb} onChange={e=>update({memory_mb:Number(e.target.value)})}/></Cluster>
    <Textarea label="Allowed browser origins" disabled={action.busy} description="One exact origin per line. Cell browser-origin rules also apply." value={origins} onChange={e=>{setOrigins(e.target.value);setDirty(true);onChanged();}} placeholder="https://your-app.example"/>
    <Textarea label="Custom routes (JSON)" disabled={action.busy} description={'For example: [{"method":"GET","path":"/api/orders/{id}"}]'} value={routes} onChange={e=>{setRoutes(e.target.value);setDirty(true);onChanged();}} spellCheck={false}/>
    <Button type="submit" loading={action.busy}>Deploy version</Button>
  </Stack></form>;
}

function FunctionDetails({cellId,name,onEdit,loading}:{cellId:string;name:string;onEdit:(name:string,version:string)=>Promise<void>;loading:boolean}){
  const query=useCellData<{function:Summary;versions:Version[]}>(cellId,tail(name)),action=useCellAction(cellId);
  const [disable,setDisable]=useState(false);
  const fn=query.data?.function;
  return <Stack gap={8}><Section title={name} description="Each deployment is kept so you can inspect it or roll back."><Stack><Failure error={query.error??action.error}/>{query.isPending?<p role="status">Loading function…</p>:fn&&<>
    <Cluster>{fn.active_version&&<Button variant="secondary" loading={loading} onClick={()=>void onEdit(name,fn.active_version!)}>Edit active version</Button>}<Button variant="ghost" disabled={!fn.active_version||action.busy} onClick={()=>setDisable(true)}>Disable function</Button></Cluster>
    {query.data?.versions.map(version=><Surface key={version.id}><Stack><Cluster justify="between"><div><strong>{version.id===fn.active_version?"Active version":"Version"}</strong><p className={styles.muted}>{date(version.created_at)} · {version.created_by}</p><code className={styles.muted}>{version.id}</code></div><Cluster><Button variant="ghost" loading={loading} onClick={()=>void onEdit(name,version.id)}>Inspect source</Button><Button variant="secondary" disabled={version.id===fn.active_version} loading={action.busy} onClick={()=>void action.run(`${tail(name)}/activate`,"POST",{version:version.id})}>Activate</Button></Cluster></Cluster></Stack></Surface>)}
  </>}</Stack></Section>
    {fn?.active_version&&<FunctionInvoke cellId={cellId} name={name}/>}
    <FunctionLogs cellId={cellId} name={name}/>
    <Dialog open={disable} onOpenChange={setDisable}><DialogContent title="Disable this function?" description="Its endpoints stop serving. Your source and deployment versions stay available."><Stack><Failure error={action.error}/><Button variant="danger" loading={action.busy} onClick={async()=>{if(await action.run(tail(name),"DELETE"))setDisable(false);}}>Disable function</Button></Stack></DialogContent></Dialog>
  </Stack>;
}

function FunctionInvoke({cellId,name}:{cellId:string;name:string}){
  const action=useCellAction(cellId),[method,setMethod]=useState("GET"),[url,setUrl]=useState(`/functions/${name}`),[headers,setHeaders]=useState("{}"),[body,setBody]=useState(""),[result,setResult]=useState<Result|null>(null),[error,setError]=useState<unknown>(null);
  async function invoke(){
    setError(null);setResult(null);
    try{const parsed:unknown=JSON.parse(headers);if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||Object.values(parsed).some(v=>typeof v!=="string"))throw new Error("Request headers must be a JSON object of string values.");const response=await action.run<Result>(`${tail(name)}/invoke`,"POST",{method,url,headers:parsed,body:["GET","HEAD"].includes(method)?"":encode(body)});if(response)setResult(response);}catch(cause){setError(cause);}
  }
  let text:string|null=null;if(result)try{text=decode(result.body);}catch{/* Binary response remains downloadable. */}
  function download(){if(!result)return;const blob=new Blob([Uint8Array.from(atob(result.body),c=>c.charCodeAt(0))],{type:"application/octet-stream"}),object=URL.createObjectURL(blob),link=document.createElement("a");link.href=object;link.download=`${name}-response.bin`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(object),1000);}
  return <Section title="Invoke" description="Run the active version as a cell author. A function may change data or call external services."><Stack><form onSubmit={e=>{e.preventDefault();void invoke();}}><Stack><Failure error={error??action.error}/><Cluster><Select label="Method" value={method} onValueChange={setMethod} options={["GET","HEAD","POST","PUT","PATCH","DELETE"].map(m=>({value:m,label:m}))}/><Input label="Request path" required value={url} onChange={e=>setUrl(e.target.value)}/></Cluster><Textarea label="Request headers (JSON)" value={headers} onChange={e=>setHeaders(e.target.value)} autoComplete="off" spellCheck={false}/>{!["GET","HEAD"].includes(method)&&<Textarea label="Request body" value={body} onChange={e=>setBody(e.target.value)} spellCheck={false}/>}<Button type="submit" loading={action.busy}>Invoke once</Button></Stack></form>{result&&<Surface><Stack><p role="status">HTTP {result.status} · Invocation {result.invocation_id}</p><details><summary>Response headers</summary><pre className={styles.pre}>{JSON.stringify(result.headers,null,2)}</pre></details>{text!==null?<pre className={styles.pre}>{text||"(empty body)"}</pre>:<p>Binary response</p>}<Button variant="secondary" onClick={download}>Download response</Button></Stack></Surface>}</Stack></Section>;
}

function FunctionLogs({cellId,name}:{cellId:string;name:string}){
  const [before,setBefore]=useState<string|null>(null);
  const query=useCellData<{invocations:Invocation[]}>(cellId,`${tail(name)}/invocations${before?`?before=${encodeURIComponent(before)}`:""}`),items=query.data?.invocations??[];
  return <Section title="Invocations" description="Recent runs and their recorded output." actions={<Button variant="secondary" onClick={()=>void query.refetch()}>Refresh</Button>}><Stack><Failure error={query.error}/>{query.isPending?<p role="status">Loading invocations…</p>:items.length?items.map(item=><Surface key={item.id}><details><summary>{item.status}{item.response_status!==null?` · HTTP ${item.response_status}`:""} · {date(item.started_at)}{item.duration_ms!==null?` · ${item.duration_ms} ms`:""}</summary><p className={styles.muted}>Invocation {item.id} · Version {item.version}</p>{item.error_code&&<p>{item.error_code}</p>}<pre className={styles.pre}>{item.logs.join("\n")||"No recorded log output."}</pre></details></Surface>):!query.error&&<p>No invocations in this page.</p>}<Cluster>{before&&<Button variant="ghost" onClick={()=>setBefore(null)}>Latest</Button>}{items.length===100&&<Button variant="secondary" onClick={()=>setBefore(items[items.length-1].id)}>Older invocations</Button>}</Cluster></Stack></Section>;
}
