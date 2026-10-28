import test from "node:test";
import assert from "node:assert/strict";
import {cellsBody, CellsBodyLimit} from "../lib/server/cells-body";
import {cellsProxyRoute, cellsUploadPart} from "../lib/server/cells-routes";

test("Encoded function envelopes allow 2 MiB without raising ordinary control limits",async()=>{
  const bytes=new Uint8Array(1024**2+1);
  await assert.rejects(cellsBody(new Request("https://developer.example/api/cells/cells/notes/sql",{method:"POST",body:bytes}),false),CellsBodyLimit);
  const accepted=await cellsBody(new Request("https://developer.example/api/cells/cells/notes/functions/hello",{method:"PUT",body:bytes}),false,true);
  assert.equal((accepted.body as Uint8Array).byteLength,bytes.byteLength);
  await assert.rejects(cellsBody(new Request("https://developer.example/api/cells/cells/notes/functions/hello",{method:"PUT",body:new Uint8Array(2*1024**2+1)}),false,true),CellsBodyLimit);
});

test("Storage paths allow encoded file names without route or origin escapes", () => {
  const id="12345678-1234-1234-1234-123456789abc";
  const part=`cells/notes/storage-api/uploads/${id}/parts/0`;
  assert.equal(cellsUploadPart(cellsProxyRoute(part,"PUT")!,"PUT"),true);
  assert.equal(cellsUploadPart(cellsProxyRoute(part,"PUT")!,"POST"),false);
  assert.equal(cellsProxyRoute("cells/notes/storage-api/object/photos/family/%E6%97%A5%20%231.png","GET"),"v1/cells/notes/storage-api/object/photos/family/%E6%97%A5%20%231.png");
  for (const name of ["%2e%2e", "%2Fauth", "%5c..", "%00", "%ZZ"]) assert.equal(cellsProxyRoute(`cells/notes/storage-api/object/photos/${name}`,"GET"),null);
  assert.equal(cellsProxyRoute("cells/notes/storage-api/auth/silicon","POST"),null);
});
test("Control bodies remain bounded and file parts stream without buffering", async () => {
  await assert.rejects(cellsBody(new Request("https://developer.example",{method:"POST",body:new Uint8Array(1024*1024+1)}),false),CellsBodyLimit);
  const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array([1,2,3]));c.close();}});
  const request=new Request("https://developer.example",{method:"PUT",body:stream,duplex:"half"} as RequestInit);
  const prepared=await cellsBody(request,true);
  assert.ok(prepared.body instanceof ReadableStream);
  assert.deepEqual(new Uint8Array(await new Response(prepared.body).arrayBuffer()),new Uint8Array([1,2,3]));
});
test("Streaming limits count actual bytes when Content-Length is absent",async()=>{
  const chunk=new Uint8Array(1024*1024);let sent=0;
  const request=new Request("https://developer.example",{method:"PUT",body:new ReadableStream<Uint8Array>({pull(c){if(sent++<1025)c.enqueue(chunk);else c.close();}}),duplex:"half"} as RequestInit);
  const prepared=await cellsBody(request,true);assert.ok(prepared.body instanceof ReadableStream);
  const reader=prepared.body.getReader();
  await assert.rejects(async()=>{while(!(await reader.read()).done){/* Discard without allocating 1 GiB. */}},CellsBodyLimit);
  assert.equal(prepared.oversized(),true);
});
