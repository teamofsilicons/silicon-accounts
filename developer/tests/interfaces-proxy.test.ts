import test,{afterEach} from "node:test";
import assert from "node:assert/strict";
import {NextRequest} from "next/server";
import {seal} from "../lib/server/seal";
import type {StoredSession} from "../lib/server/session";

const realFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=realFetch;});
process.env.INTERFACES_API_URL="http://interfaces.test";
process.env.ACCOUNTS_API_URL="http://accounts.test";
process.env.DEVELOPER_PUBLIC_URL="https://developers.example";
function request(path:string,method="GET",body?:BodyInit,extra:Record<string,string>={}) {
  const session:StoredSession={v:1,at:"author-access",rt:crypto.randomUUID(),ae:Date.now()+120000,re:Date.now()+86400000,sub:"author"};
  return new NextRequest(`https://developers.example/api/interfaces/${path}`,{method,body,headers:{cookie:`__Host-sa_dev_session=${seal(session,"sa_dev_session")}`,origin:"https://developers.example","content-type":"application/octet-stream",...extra}});
}
test("Interfaces image uploads stream to the API with a server-held token",async()=>{
  const bytes=new Uint8Array(2*1024*1024).fill(11);
  globalThis.fetch=(async(input,init)=>{assert.equal(String(input),"http://interfaces.test/v1/interfaces/potato/uploads?category=image");assert.equal(new Headers(init?.headers).get("authorization"),"Bearer author-access");assert.equal(new Headers(init?.headers).get("x-filename"),"image.png");assert.ok(init?.body instanceof ReadableStream);assert.deepEqual(new Uint8Array(await new Response(init.body).arrayBuffer()),bytes);return Response.json({upload:{id:"x"}});}) as typeof fetch;
  const {POST}=await import("../app/api/interfaces/[...path]/route");
  const response=await POST(request("interfaces/potato/uploads?category=image","POST",bytes,{"x-filename":"image.png","idempotency-key":"test"}));
  assert.equal(response.status,200);assert.equal(response.headers.get("set-cookie"),null);
});
test("Interfaces refuses oversized uploads and cross-origin changes before calling the API",async()=>{
  let calls=0;globalThis.fetch=(async()=>{calls++;return Response.json({});}) as typeof fetch;
  const {POST}=await import("../app/api/interfaces/[...path]/route");
  const oversized=await POST(request("interfaces/potato/uploads?category=image","POST",new Uint8Array(1),{"content-length":String(10*1024*1024+1)}));
  assert.equal(oversized.status,413);
  const crossOrigin=await POST(request("interfaces/potato/publish","POST","{}",{origin:"https://elsewhere.example"}));
  assert.equal(crossOrigin.status,403);assert.equal(calls,0);
});
