import test, {afterEach} from "node:test";
import assert from "node:assert/strict";
import {NextRequest} from "next/server";
import {seal} from "../lib/server/seal";
import type {StoredSession} from "../lib/server/session";
const realFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=realFetch;});
process.env.CELLS_API_URL="http://cells.test";
process.env.ACCOUNTS_API_URL="http://accounts.test";
process.env.DEVELOPER_PUBLIC_URL="https://developers.example";
const id="12345678-1234-1234-1234-123456789abc";
function request(path:string,method="GET",body?:BodyInit):NextRequest {
  const session:StoredSession={v:1,at:"author-access",rt:crypto.randomUUID(),ae:Date.now()+120000,re:Date.now()+86400000,sub:"author"};
  return new NextRequest(`https://developers.example/api/cells/${path}`,{method,body,headers:{cookie:`__Host-sa_dev_session=${seal(session,"sa_dev_session")}`,origin:"https://developers.example","content-type":"application/octet-stream"}});
}
const json=(status:number,body:unknown)=>Response.json(body,{status});
test("The Cells proxy streams parts over 1 MiB and keeps Accounts credentials server-side",async()=>{
  const bytes=new Uint8Array(2*1024*1024).fill(7);let calls=0;
  globalThis.fetch=(async(input,init)=>{
    calls++;assert.equal(String(input),`http://cells.test/v1/cells/notes/storage-api/uploads/${id}/parts/0`);
    assert.equal(new Headers(init?.headers).get("authorization"),"Bearer author-access");
    assert.ok(init?.body instanceof ReadableStream);
    const body=new Uint8Array(await new Response(init.body).arrayBuffer());assert.deepEqual(body,bytes);
    return json(200,{number:0,size:body.length});
  }) as typeof fetch;
  const {PUT}=await import("../app/api/cells/[...path]/route");
  const response=await PUT(request(`cells/notes/storage-api/uploads/${id}/parts/0`,"PUT",bytes));
  assert.equal(response.status,200);assert.equal(calls,1);assert.equal((await response.json()).size,bytes.length);
});
test("A streamed part refused for expiry refreshes once and asks for a new request without replaying consumed bytes",async()=>{
  let parts=0;let refreshes=0;
  globalThis.fetch=(async(input,init)=>{
    const url=String(input);
    if(url.startsWith("http://cells.test/")){parts++;await new Response(init?.body).arrayBuffer();return json(401,{error:{code:"invalid_token"}});}
    if(url.endsWith("/v1/session"))return json(401,{error:{code:"invalid_token"}});
    if(url.endsWith("/v1/oauth/token")){refreshes++;return json(200,{access_token:"rotated",refresh_token:"new-refresh",expires_in:1800,account:{uuid:"author"}});}
    throw new Error("Unexpected upstream");
  }) as typeof fetch;
  const {PUT}=await import("../app/api/cells/[...path]/route");
  const response=await PUT(request(`cells/notes/storage-api/uploads/${id}/parts/0`,"PUT",new Uint8Array(2)));
  assert.equal(response.status,503);assert.equal((await response.json()).error.code,"upload_retry");
  assert.equal(parts,1);assert.equal(refreshes,1);assert.match(response.headers.get("set-cookie")??"",/__Host-sa_dev_session=v1\./);
});
test("Downloaded active content stays sandboxed and is delivered as an attachment",async()=>{
  globalThis.fetch=(async()=>new Response("<script>danger</script>",{headers:{"content-type":"text/html","content-security-policy":"default-src 'none'; sandbox","referrer-policy":"no-referrer","set-cookie":"never-forward=this"}})) as typeof fetch;
  const {GET}=await import("../app/api/cells/[...path]/route");
  const response=await GET(request("cells/notes/storage-api/object/files/report.html"));
  assert.equal(response.status,200);assert.match(response.headers.get("content-disposition")??"",/^attachment;/);
  assert.match(response.headers.get("content-security-policy")??"",/sandbox/);assert.equal(response.headers.get("set-cookie"),null);
});


test("Backup downloads stream privately with integrity metadata and a fixed safe filename",async()=>{
  const hash="a".repeat(64);
  globalThis.fetch=(async(input,init)=>{
    assert.equal(String(input),`http://cells.test/v1/cells/notes/backups/${id}/download`);
    assert.equal(new Headers(init?.headers).get("authorization"),"Bearer author-access");
    return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode("dump"));controller.close();}}),{headers:{"content-type":"application/octet-stream","content-length":"4","x-content-sha256":hash,etag:`"${hash}"`,"content-disposition":"inline; filename=unsafe.html","set-cookie":"must-not-forward=1"}});
  }) as typeof fetch;
  const {GET}=await import("../app/api/cells/[...path]/route");
  const response=await GET(request(`cells/notes/backups/${id}/download`));
  assert.equal(response.headers.get("content-disposition"),`attachment; filename="notes-${id}.dump"`);
  assert.equal(response.headers.get("x-content-sha256"),hash);
  assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal(response.headers.get("referrer-policy"),"no-referrer");
  assert.equal(response.headers.get("set-cookie"),null);
  assert.equal(await response.text(),"dump");
});
