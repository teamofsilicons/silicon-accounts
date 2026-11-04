import test,{afterEach} from "node:test";
import assert from "node:assert/strict";
import {request} from "../components/interfaces/api";

const originalFetch=globalThis.fetch;
const originalStorage=Object.getOwnPropertyDescriptor(globalThis,"sessionStorage");
function memoryStorage():Storage {
  const values=new Map<string,string>();
  return {get length(){return values.size;},clear(){values.clear();},getItem(key){return values.get(key)??null;},key(index){return [...values.keys()][index]??null;},removeItem(key){values.delete(key);},setItem(key,value){values.set(key,value);}};
}
afterEach(()=>{globalThis.fetch=originalFetch;if(originalStorage)Object.defineProperty(globalThis,"sessionStorage",originalStorage);else Reflect.deleteProperty(globalThis,"sessionStorage");});
async function operationId(method:string,path:string,body:unknown) {
  const raw=JSON.stringify([method,path,JSON.stringify(body)]);
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
}
test("Interface mutations recover an operation key from session storage and clear it on success",async()=>{
  const storage=memoryStorage();Object.defineProperty(globalThis,"sessionStorage",{value:storage,configurable:true});
  const body={interface_id:"fresh-example",name:"Example"};const path="interfaces";
  const id=await operationId("POST",path,body);storage.setItem(`silicon-interfaces-operation:${id}`,"saved-operation-key");
  globalThis.fetch=(async(_input,init)=>{assert.equal(new Headers(init?.headers).get("idempotency-key"),"saved-operation-key");return Response.json({ok:true});}) as typeof fetch;
  await request(path,{method:"POST",body});assert.equal(storage.length,0);
});
test("Uncertain failures retain only the hashed fingerprint and operation key for retry",async()=>{
  const storage=memoryStorage();Object.defineProperty(globalThis,"sessionStorage",{value:storage,configurable:true});
  const path="interfaces/another-example";const body={revision:1,name:"Private draft title"};const keys:string[]=[];let count=0;
  globalThis.fetch=(async(_input,init)=>{keys.push(new Headers(init?.headers).get("idempotency-key")!);count++;if(count===1)return Response.json({error:{code:"accounts_unavailable",message:"Try again"}},{status:503});if(count===2)return Response.json({error:{code:"idempotency_result_unavailable",message:"Pending"}},{status:409});return Response.json({ok:true});}) as typeof fetch;
  await assert.rejects(request(path,{method:"PATCH",body}));
  assert.equal(storage.length,1);const stored=storage.key(0)!;assert.match(stored,/^silicon-interfaces-operation:[a-f0-9]{64}$/);assert.equal(stored.includes("Private draft title"),false);
  await assert.rejects(request(path,{method:"PATCH",body}));assert.equal(storage.length,1);
  await request(path,{method:"PATCH",body});assert.deepEqual(keys,[keys[0],keys[0],keys[0]]);assert.equal(storage.length,0);
});
