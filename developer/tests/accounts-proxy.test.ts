import test,{afterEach} from "node:test";
import assert from "node:assert/strict";
import {NextRequest} from "next/server";
import {seal} from "../lib/server/seal";
import type {StoredSession} from "../lib/server/session";

const realFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=realFetch;});
process.env.ACCOUNTS_API_URL="http://accounts.test";
process.env.DEVELOPER_PUBLIC_URL="https://developers.example";
function request(path:string,signedIn:boolean,extra:Record<string,string>={}) {
  const session:StoredSession={v:1,at:"author-access",rt:crypto.randomUUID(),ae:Date.now()+120000,re:Date.now()+86400000,sub:"author"};
  const cookie:Record<string,string>=signedIn?{cookie:`__Host-sa_dev_session=${seal(session,"sa_dev_session")}`}:{};
  return new NextRequest(`https://developers.example/api/accounts/${path}`,{method:"POST",body:new Uint8Array(1),headers:{...cookie,origin:"https://developers.example","content-type":"text/csv",...extra}});
}
test("Accounts reads no request body before the session, and refuses one larger than the API accepts",async()=>{
  let calls=0;globalThis.fetch=(async()=>{calls++;return Response.json({});}) as typeof fetch;
  const {POST}=await import("../app/api/accounts/[...path]/route");
  const signedOut=request("apps/briefcase/imports",false);
  assert.equal((await POST(signedOut)).status,401);
  assert.equal(signedOut.bodyUsed,false);
  const oversized=await POST(request("apps/briefcase/imports",true,{"content-length":String(52_494_336+1)}));
  assert.equal(oversized.status,413);assert.equal(calls,0);
  assert.equal((await oversized.json()).error.code,"payload_too_large");
});
