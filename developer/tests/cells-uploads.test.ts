import test,{afterEach} from "node:test";
import assert from "node:assert/strict";
import {resumeAuthorUpload,type UploadStatus} from "../lib/cells/uploads";
const original=globalThis.fetch;
afterEach(()=>{globalThis.fetch=original;});
const status=(changes:Partial<UploadStatus>={}):UploadStatus=>({id:"upload",object_id:"object",bucket:"files",name:"hello.txt",content_type:"text/plain",can_resume:true,status:"uploading",size:6,part_bytes:3,parts:[],result:null,...changes});
const digest=async(text:string)=>Buffer.from(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text))).toString("hex");
function fixture(value:UploadStatus){
  const parts:{index:number;text:string}[]=[];let completed=0;
  globalThis.fetch=(async(input,init)=>{
    const url=String(input);assert.ok(url.startsWith("/api/cells/cells/notes/storage-api/uploads/upload"));
    assert.equal(new Headers(init?.headers).get("authorization"),null);assert.equal(new Headers(init?.headers).get("x-upload-token"),null);
    if(url.endsWith("/complete")){completed++;return Response.json({id:"object"});}
    if(url.includes("/parts/")){assert.ok(init?.body instanceof Blob);parts.push({index:Number(url.split("/").at(-1)),text:await init.body.text()});return Response.json({});}
    return Response.json(value);
  }) as typeof fetch;
  return {parts,completed:()=>completed};
}
test("A resumed author upload validates old bytes and sends only the missing part",async()=>{
  const api=fixture(status({parts:[{number:0,size:3,sha256:await digest("abc")}]})),progress:number[]=[];
  await resumeAuthorUpload("notes","upload",new Blob(["abcdef"]),new AbortController().signal,n=>progress.push(n));
  assert.deepEqual(api.parts,[{index:1,text:"def"}]);assert.equal(api.completed(),1);assert.deepEqual(progress,[3,6]);
});
test("A same-size different file is refused before new bytes or completion are sent",async()=>{
  const api=fixture(status({parts:[{number:0,size:3,sha256:await digest("abc")}]}));
  await assert.rejects(resumeAuthorUpload("notes","upload",new Blob(["xyzdef"]),new AbortController().signal,()=>{}),/does not match/);
  assert.deepEqual(api.parts,[]);assert.equal(api.completed(),0);
});
test("Zero-byte files send one empty part before completion",async()=>{
  const api=fixture(status({size:0}));await resumeAuthorUpload("notes","upload",new Blob([]),new AbortController().signal,()=>{});
  assert.deepEqual(api.parts,[{index:0,text:""}]);assert.equal(api.completed(),1);
});
test("Paused uploads and another author's reservation cannot publish",async()=>{
  const api=fixture(status());const controller=new AbortController();
  await assert.rejects(resumeAuthorUpload("notes","upload",new Blob(["abcdef"]),controller.signal,()=>controller.abort()),{name:"AbortError"});
  assert.equal(api.completed(),0);assert.deepEqual(api.parts,[]);
  fixture(status({can_resume:false}));await assert.rejects(resumeAuthorUpload("notes","upload",new Blob(["abcdef"]),new AbortController().signal,()=>{}),/Only the author/);
});


test("A newly created reservation sends its first parts before publication",async()=>{
  const api=fixture(status({status:"creating"}));
  await resumeAuthorUpload("notes","upload",new Blob(["abcdef"]),new AbortController().signal,()=>{});
  assert.deepEqual(api.parts,[{index:0,text:"abc"},{index:1,text:"def"}]);
  assert.equal(api.completed(),1);
});
