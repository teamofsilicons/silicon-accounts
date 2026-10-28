import test from "node:test";
import assert from "node:assert/strict";
import {MAX_WASM_BYTES,readCompiledWasm} from "../lib/cells/wasm";

const header=[0,97,115,109,1,0,0,0];
const command=[...header,1,4,1,96,0,0,3,2,1,0,7,10,1,6,95,115,116,97,114,116,0,0,10,4,1,2,0,11];
const file=(bytes:number[],name="endpoint.wasm")=>new File([new Uint8Array(bytes)],name,{type:"application/wasm"});

test("Compiled Wasm upload preserves opaque bytes including invalid UTF-8",async()=>{
 const bytes=[...command,0,7,1,120,0,255,128,192,254];
 const result=await readCompiledWasm(file(bytes));
 assert.equal(result.entrypoint,"endpoint.wasm");assert.equal(result.size,bytes.length);
 assert.deepEqual([...Buffer.from(result.contents,"base64")],bytes);
});
test("Staging never compiles or executes the uploaded module",async context=>{
 const compile=context.mock.method(WebAssembly,"compile",()=>{throw new Error("forbidden by production CSP");});
 const instantiate=context.mock.method(WebAssembly,"instantiate",()=>{throw new Error("must never execute");});
 const traps=[...command.slice(0,30),8,1,0,10,5,1,3,0,0,11];
 const result=await readCompiledWasm(file(traps));
 assert.deepEqual([...Buffer.from(result.contents,"base64")],traps);
 assert.equal(compile.mock.callCount(),0);assert.equal(instantiate.mock.callCount(),0);
});
test("Reject source/native/component files and truncated core headers",async()=>{
 for(const bytes of [[...Buffer.from("(module)")],[127,69,76,70,1,0,0,0],[0,97,115,109,13,0,1,0],header.slice(0,7)])await assert.rejects(readCompiledWasm(file(bytes)),/compiled core WebAssembly/);
});
test("Reject unsafe names and oversized files before reading",async()=>{
 for(const name of ["endpoint.cwasm","../endpoint.wasm","a\\b.wasm","a:b.wasm","bad\n.wasm"])await assert.rejects(readCompiledWasm(file(command,name)),/filename/);
 const oversized=new File([new Uint8Array(MAX_WASM_BYTES+1)],"large.wasm");
 Object.defineProperty(oversized,"arrayBuffer",{value:()=>{throw new Error("must not read");}});
 await assert.rejects(readCompiledWasm(oversized),/at most 1 MiB/);
});
