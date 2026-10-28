"use client";
import {useState} from "react";
import {ApiError} from "@/lib/api/errors";
import {Stack,Cluster} from "@/components/foundation/layout/layout";
import {Input} from "@/components/silicon-ui/input/input";
import {Textarea} from "@/components/silicon-ui/textarea/textarea";
import {Select} from "@/components/silicon-ui/select/select";
import {Checkbox} from "@/components/silicon-ui/checkbox/checkbox";
import {Button} from "@/components/silicon-ui/button/button";
import {Failure,useCellsLeaveGuard} from "./shared";
import styles from "./cells.module.css";
export type TemplateKind="waitlist"|"contact"|"feedback"|"file_upload"|"notify"|"counter"|"short_links"|"api_proxy"|"webhook_receiver";
interface Property{type?:string;title?:string;description?:string;enum?:unknown[];default?:unknown;minimum?:number;maximum?:number;minLength?:number;maxLength?:number}
export interface TemplateDescriptor{kind:TemplateKind;name:string;description:string;config_schema:{properties?:Record<string,Property>;required?:string[]};defaults:Record<string,unknown>;public_methods:string[]}
export interface TemplateDefinition{kind:TemplateKind;path:string;enabled:boolean;allowed_origins:string[];config:Record<string,unknown>;reset_source:boolean}
export interface TemplateSummary{name:string;kind:TemplateKind;path:string;enabled:boolean;publication_status?:"pending"|"ready";publication_error?:string|null;function:string;version:string|null;resources:{tables:string[];functions:string[];endpoint_function:string;notification_function?:string;queue?:string;bucket?:string};created_at:string;updated_at:string}
function invalid(message:string){return new ApiError({status:400,code:"invalid_template",message,hint:"Review the template settings and try again."});}
const label=(name:string,property:Property)=>property.title??name.replaceAll("_"," ").replace(/^./u,first=>first.toUpperCase());
const complex=(property:Property,value:unknown)=>property.type==="array"||property.type==="object"||(typeof value==="object"&&value!==null);
const text=(value:unknown,property:Property)=>value===undefined?"":complex(property,value)?JSON.stringify(value,null,2):String(value);
export function TemplateEditor({descriptor,name:original,definition,busy,error,onChanged,onSave}:{descriptor:TemplateDescriptor;name?:string;definition?:TemplateDefinition;busy:boolean;error:unknown;onChanged:()=>void;onSave:(name:string,definition:TemplateDefinition)=>Promise<boolean>}){
  const initial=definition??{kind:descriptor.kind,path:`/${descriptor.kind.replaceAll("_","-")}`,enabled:true,allowed_origins:[],config:descriptor.defaults,reset_source:false},properties=descriptor.config_schema.properties??{};
  const [name,setName]=useState(original??""),[path,setPath]=useState(initial.path),[enabled,setEnabled]=useState(initial.enabled),[origins,setOrigins]=useState(initial.allowed_origins.join("\n")),[draft,setDraft]=useState<Record<string,string>>(()=>Object.fromEntries(Object.entries(properties).map(([key,property])=>[key,text(initial.config[key]??property.default,property)]))),[baseConfig,setBaseConfig]=useState(initial.config),[present,setPresent]=useState(()=>new Set(Object.keys(initial.config))),[advanced,setAdvanced]=useState(false),[raw,setRaw]=useState(JSON.stringify(initial.config,null,2)),[dirty,setDirty]=useState(!original),[problem,setProblem]=useState<unknown>(null);
  useCellsLeaveGuard(dirty||busy,"Your template configuration has changes that have not been saved.");
  function changed(){setDirty(true);onChanged();}
  function config():Record<string,unknown>{
    if(advanced){let parsed:unknown;try{parsed=JSON.parse(raw);}catch{throw invalid("Template configuration must be valid JSON.");}if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw invalid("Template configuration must be a JSON object.");return parsed as Record<string,unknown>;}
    const result={...baseConfig};for(const [key,property] of Object.entries(properties)){
      const value=draft[key]??"";if(value===""){if(descriptor.config_schema.required?.includes(key))throw invalid(`${label(key,property)} is required.`);if(property.type==="string"&&present.has(key))result[key]="";else delete result[key];continue;}
      if(property.type==="boolean")result[key]=value==="true";
      else if(property.type==="integer"||property.type==="number"){const number=Number(value);if(!Number.isFinite(number)||(property.type==="integer"&&!Number.isInteger(number))||(property.minimum!==undefined&&number<property.minimum)||(property.maximum!==undefined&&number>property.maximum))throw invalid(`${label(key,property)} is outside its supported range.`);result[key]=number;}
      else if(complex(property,initial.config[key])){let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw invalid(`${label(key,property)} must be valid JSON.`);}if(property.type==="array"&&!Array.isArray(parsed)||property.type==="object"&&(!parsed||typeof parsed!=="object"||Array.isArray(parsed)))throw invalid(`${label(key,property)} must be a JSON ${property.type}.`);result[key]=parsed;}
      else result[key]=value;
    }return result;
  }
  function mode(value:boolean){setProblem(null);try{if(value)setRaw(JSON.stringify(config(),null,2));else{const parsed=config();setBaseConfig(parsed);setPresent(new Set(Object.keys(parsed)));setDraft(Object.fromEntries(Object.entries(properties).map(([key,property])=>[key,text(parsed[key],property)])));}setAdvanced(value);}catch(cause){setProblem(cause);}}
  async function save(){setProblem(null);try{
    if(!/^[a-z][a-z0-9-]{0,39}$/u.test(name)||name==="catalog")throw invalid("Use 1–40 lowercase letters, digits or hyphens, starting with a letter. catalog is reserved.");
    if(!path.startsWith("/")||path.endsWith("/")||/[{}*?#]/u.test(path))throw invalid("Use a static absolute base path without a trailing slash, parameters or query.");
    const settings=config();if(new TextEncoder().encode(JSON.stringify(settings)).length>65536)throw invalid("Template configuration exceeds 64 KiB.");
    const definition:TemplateDefinition={kind:descriptor.kind,path,enabled,allowed_origins:origins.split("\n").map(value=>value.trim()).filter(Boolean),config:settings,reset_source:false};
    if(new TextEncoder().encode(JSON.stringify(definition)).length>131072)throw invalid("Template definition exceeds 128 KiB.");
    if(await onSave(name,definition))setDirty(false);
  }catch(cause){setProblem(cause);}}
  return <form onSubmit={event=>{event.preventDefault();void save();}}><Stack><Failure error={problem??error}/><p>{descriptor.description}</p><Input label="Template name" required disabled={busy||!!original} maxLength={40} pattern="[a-z][a-z0-9-]{0,39}" value={name} onChange={event=>{setName(event.target.value);changed();}}/><Input label="Endpoint base path" required disabled={busy} value={path} description={descriptor.kind==="short_links"?"Short codes are appended to this path, for example /go/hello.":"Choose a static custom route for this endpoint."} onChange={event=>{setPath(event.target.value);changed();}}/><Checkbox label="Template enabled" checked={enabled} disabled={busy} onCheckedChange={value=>{setEnabled(value===true);changed();}}/>
    <p className={styles.muted}>{descriptor.public_methods.length?`${descriptor.public_methods.join(", ")} on the custom route ${descriptor.kind==="webhook_receiver"?"requires a valid webhook signature":"is public"}. Other requests use cell keys and access rules.`:"Requests use cell keys and the template’s access rules."}</p>
    <Checkbox label="Edit configuration as JSON" checked={advanced} disabled={busy} onCheckedChange={value=>mode(value===true)}/>
    {advanced?<Textarea label="Template configuration (JSON)" disabled={busy} value={raw} className={styles.codeInput} autoComplete="off" spellCheck={false} onChange={event=>{setRaw(event.target.value);changed();}}/>:Object.entries(properties).map(([key,property])=>{
      const title=label(key,property),value=draft[key]??"",required=descriptor.config_schema.required?.includes(key);
      const change=(value:string)=>{setPresent(current=>new Set([...current,key]));setDraft(current=>({...current,[key]:value}));changed();};
      if(property.type==="boolean")return <Checkbox key={key} label={title} checked={value==="true"} disabled={busy} onCheckedChange={value=>change(String(value===true))}/>;
      if(property.enum?.length)return <Select key={key} label={title} description={property.description} disabled={busy} value={value} options={property.enum.map(value=>({value:String(value),label:String(value)}))} onValueChange={change}/>;
      if(complex(property,initial.config[key]))return <Textarea key={key} label={`${title} (JSON)`} required={required} disabled={busy} description={property.description} value={value} className={styles.codeInput} autoComplete="off" spellCheck={false} onChange={event=>change(event.target.value)}/>;
      return <Input key={key} label={title} required={required} disabled={busy} description={property.description} value={value} type={property.type==="number"||property.type==="integer"?"number":"text"} step={property.type==="integer"?1:"any"} min={property.minimum} max={property.maximum} minLength={property.minLength} maxLength={property.maxLength} autoComplete="off" onChange={event=>change(event.target.value)}/>;
    })}
    <p className={styles.muted}>Use cell secret names for signing and proxy authentication. Keep secret values in Secrets. Configuration remains private in this editor.</p><Textarea label="Template allowed origins" disabled={busy} value={origins} description="One exact browser origin per line. Cell origin rules also apply." onChange={event=>{setOrigins(event.target.value);changed();}}/><p className={styles.muted}>Saving preserves edited function source. Generated tables, SQL, rules, queues and functions remain editable through their ordinary tools.</p><Cluster><Button type="submit" loading={busy}>{original?"Save template configuration":"Create endpoint"}</Button></Cluster>
  </Stack></form>;
}
