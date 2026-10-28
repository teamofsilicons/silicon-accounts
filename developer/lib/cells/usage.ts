import {ApiError} from "@/lib/api/errors";
/** Integers remain decimal strings until encoded: quotas can exceed Number's exact range. */
export type Integers = {[key:string]:string|Integers};
export interface UsageConfig {usage:Integers;realtime:Integers;services:Integers}
export interface UsageMetric {metric:string;used:string|null;reserved:string;limit:string;period_start:string|null;resets_at:string|null;enforcement:string}
export interface UsageResponse {limits:UsageConfig;revision:string;observed_at:string;usage:UsageMetric[];database:{status:string;checked_at:string|null;error_code:string|null;used_bytes:string|null;enforced_bytes:string|null;desired_bytes:string}}
export interface LimitsResponse {limits:UsageConfig;revision:string;updated_at:string}
export function parseUsage(text:string):unknown {
  JSON.parse(text); // Validate the original grammar before preserving numeric tokens.
  // A JSON string is matched as a whole before its numeric contents. The number
  // token is therefore quoted only outside strings; JSON.parse validates syntax.
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu,token=>token.startsWith('"')?token:JSON.stringify(token))) as unknown;
}
export function encodeLimits(value:UsageConfig):string {
  function encode(v:string|Integers):string {if(typeof v==="string"){if(!/^\d+$/u.test(v))throw new Error("Limits must be whole positive numbers.");return BigInt(v).toString();}return `{${Object.entries(v).map(([key,item])=>`${JSON.stringify(key)}:${encode(item)}`).join(",")}}`;}
  return encode(value as unknown as Integers);
}
export async function usageRequest<T>(cell:string,tail:"usage"|"limits",options:{body?:UsageConfig;key?:string;signal?:AbortSignal}={}):Promise<T>{
 const headers=new Headers({accept:"application/json"});if(options.body)headers.set("content-type","application/json");if(options.key)headers.set("idempotency-key",options.key);
 let response:Response;try{response=await fetch(`/api/cells/cells/${encodeURIComponent(cell)}/${tail}`,{method:options.body?"PUT":"GET",headers,body:options.body?encodeLimits(options.body):undefined,credentials:"same-origin",cache:"no-store",redirect:"error",signal:options.signal});}catch(cause){if(cause instanceof DOMException&&cause.name==="AbortError")throw cause;throw new ApiError({status:0,code:"network_error",message:"Could not reach Silicon Cells.",hint:"Retrying the same limits keeps the same operation key.",cause});}
 const text=await response.text();if(!response.ok){let body:{error?:{code?:string;message?:string;hint?:string}}={};try{body=JSON.parse(text) as typeof body;}catch{}throw new ApiError({status:response.status,code:body.error?.code??"invalid_response",message:body.error?.message??"Cells could not read or change limits.",hint:body.error?.hint});}return parseUsage(text) as T;
}
export interface LimitField {path:string;label:string;min:bigint;max:bigint}
const max=9223372036854775807n;
export const limitGroups:{title:string;fields:LimitField[]}[]=[
 {title:"Accounting and alerts",fields:[{path:"usage.period_seconds",label:"Accounting period (seconds)",min:60n,max:31536000n},{path:"usage.near_percent",label:"Near-limit alert (%)",min:1n,max:99n}]},
 {title:"Resources",fields:[...[['database_bytes','Database bytes',1024n],['storage_bytes','Storage bytes',1n],['bandwidth_bytes','Bandwidth bytes',1n],['function_ms','Function time (milliseconds)',1n],['service_ms','Service time (milliseconds)',1n],['requests','Requests per accounting period',1n]].map(([key,label,min])=>({path:`usage.limits.${key}`,label:String(label),min:min as bigint,max})),{path:"usage.limits.function_concurrency",label:"Concurrent functions",min:1n,max:4294967295n}]},
 ...[['api','API requests'],['sign_in','Sign-ins'],['functions','Function invocations']].map(([key,label])=>({title:`${label} rate limits`,fields:[{path:`usage.rate_limits.${key}.per_ip`,label:`${label} per IP`,min:1n,max},{path:`usage.rate_limits.${key}.per_user`,label:`${label} per user`,min:1n,max},{path:`usage.rate_limits.${key}.window_seconds`,label:`${label} window (seconds)`,min:1n,max:86400n}]})),
 {title:"Realtime capacity",fields:[['connections','Realtime connections',1n,100000n],['subscriptions_per_connection','Subscriptions per connection',1n,128n],['channels_per_connection','Channels per connection',1n,128n],['commands_per_second','Commands per second',1n,10000n],['broadcasts_per_second','Broadcasts per second',1n,100000n],['max_change_bytes','Maximum row-change bytes',1024n,1048576n],['max_presence_bytes','Maximum presence bytes',1024n,1048576n],['retention_seconds','Replay retention (seconds)',60n,604800n]].map(([key,label,min,max])=>({path:`realtime.${key}`,label:String(label),min:min as bigint,max:max as bigint}))},
 {title:"Persistent service capacity",fields:[['instances','Service instances',1n],['memory_mb','Combined service memory (MiB)',32n],['cpu_millis','Combined service CPU (millicores)',100n],['connections','Service connections',1n]].map(([key,label,min])=>({path:`services.${key}`,label:String(label),min:min as bigint,max:2147483647n}))},
];
export function limitValue(config:UsageConfig,path:string):string {let item:unknown=config;for(const key of path.split(".")){if(!item||typeof item!=="object")return "";item=(item as Record<string,unknown>)[key];}return typeof item==="string"?item:"";}
export function updateLimit(config:UsageConfig,path:string,value:string):UsageConfig {const next=structuredClone(config);let item=next as unknown as Integers;const keys=path.split(".");for(const key of keys.slice(0,-1))item=item[key] as Integers;item[keys.at(-1)!]=value;return next;}
export function invalidLimits(config:UsageConfig):string|null {for(const field of limitGroups.flatMap(group=>group.fields)){const text=limitValue(config,field.path);if(!/^\d+$/u.test(text))return `${field.label} must be a whole number.`;const n=BigInt(text);if(n<field.min||n>field.max)return `${field.label} must be between ${field.min.toString()} and ${field.max.toString()}.`;}return null;}
