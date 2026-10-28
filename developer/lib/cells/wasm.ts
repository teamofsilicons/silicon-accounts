/** Read an already compiled WASI command. Staging never compiles, instantiates or runs it. */
export const MAX_WASM_BYTES=1024*1024;
export async function readCompiledWasm(file:File):Promise<{entrypoint:string;contents:string;size:number}>{
 if(!file.name.endsWith(".wasm")||new TextEncoder().encode(file.name).byteLength>512||/[/\\:\x00-\x1f\x7f-\x9f]/u.test(file.name))throw new Error("Choose a .wasm file with a filename without slashes, colons or control characters.");
 if(file.size>MAX_WASM_BYTES)throw new Error("The compiled WebAssembly file must be at most 1 MiB.");
 const bytes=new Uint8Array(await file.arrayBuffer());
 if(bytes.length!==file.size||[0,97,115,109,1,0,0,0].some((value,index)=>bytes[index]!==value))throw new Error("Choose a compiled core WebAssembly module, not source text, a component or a native executable.");
 // Full structure/import/export validation belongs to the isolated server. The page must not
 // compile untrusted modules or relax its Content Security Policy to stage a binary upload.
 let binary="";for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
 return {entrypoint:file.name,contents:btoa(binary),size:bytes.length};
}
