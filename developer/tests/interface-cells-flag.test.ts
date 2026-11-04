import test, {afterEach} from "node:test";
import assert from "node:assert/strict";
import {NextRequest} from "next/server";
import {interfaceCellsEnabled} from "../lib/server/config";
import {seal} from "../lib/server/seal";
import type {StoredSession} from "../lib/server/session";

const originalEnv = {...process.env};
const realFetch = globalThis.fetch;
afterEach(()=>{
  globalThis.fetch=realFetch;
  for (const key of ["NODE_ENV","DEVELOPER_INTERFACE_CELLS_ENABLED","CELLS_API_URL","DEVELOPER_PUBLIC_URL"]) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});
function request(path:string,method="GET") {
  const session:StoredSession={v:1,at:"author-access",rt:crypto.randomUUID(),ae:Date.now()+120000,re:Date.now()+86400000,sub:"author"};
  return new NextRequest(`https://developers.example/api/cells/${path}`,{method,body:method==="POST"?"{}":undefined,headers:{cookie:`__Host-sa_dev_session=${seal(session,"sa_dev_session")}`,origin:"https://developers.example","content-type":"application/json"}});
}
test("Interface Cell flag defaults closed in production and on in development; only true enables",()=>{
  delete process.env.DEVELOPER_INTERFACE_CELLS_ENABLED;
  Object.assign(process.env,{NODE_ENV:"production"});assert.equal(interfaceCellsEnabled(),false);
  Object.assign(process.env,{NODE_ENV:"development"});assert.equal(interfaceCellsEnabled(),true);
  process.env.DEVELOPER_INTERFACE_CELLS_ENABLED="false";assert.equal(interfaceCellsEnabled(),false);
  process.env.DEVELOPER_INTERFACE_CELLS_ENABLED="invalid";assert.equal(interfaceCellsEnabled(),false);
  Object.assign(process.env,{NODE_ENV:"production"});process.env.DEVELOPER_INTERFACE_CELLS_ENABLED="true";assert.equal(interfaceCellsEnabled(),true);
});
test("Disabled Interface Cell route fails closed without affecting other Cells routes; enabling restores it",async()=>{
  Object.assign(process.env,{NODE_ENV:"development"});process.env.DEVELOPER_INTERFACE_CELLS_ENABLED="false";
  process.env.CELLS_API_URL="http://cells.test";process.env.DEVELOPER_PUBLIC_URL="https://developers.example";
  const calls:string[]=[];
  globalThis.fetch=(async(input)=>{calls.push(String(input));return Response.json({cell:null});}) as typeof fetch;
  const {GET,POST}=await import("../app/api/cells/[...path]/route");
  for(const response of [await GET(request("interfaces/potato/cell")),await POST(request("interfaces/potato/cell","POST"))]) {
    assert.equal(response.status,503);assert.equal((await response.json()).error.code,"interface_cell_unavailable");
  }
  assert.equal(calls.length,0);
  assert.equal((await GET(request("cells"))).status,200);
  assert.equal((await GET(request("apps/notes/cell"))).status,200);
  process.env.DEVELOPER_INTERFACE_CELLS_ENABLED="true";
  assert.equal((await POST(request("interfaces/potato/cell","POST"))).status,200);
  assert.deepEqual(calls,["http://cells.test/v1/cells","http://cells.test/v1/apps/notes/cell","http://cells.test/v1/interfaces/potato/cell"]);
});
