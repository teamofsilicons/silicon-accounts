import {test} from "node:test";
import assert from "node:assert/strict";
import {parseStorageRows, storageRows} from "../components/publishing/storage-schema";
import {proxyRoute} from "../lib/server/apps-routes";

test("storage editor preserves JSON types and rejects duplicate or unsafe definitions", () => {
  const schema = {theme:{type:"string" as const,default:"dark"},alerts:{type:"boolean" as const,default:false},scale:{type:"number" as const,default:1.5},items:{type:"array" as const,default:[1]},options:{type:"object" as const,default:{nested:true}}};
  assert.deepEqual(parseStorageRows(storageRows(schema)),schema);
  assert.deepEqual(parseStorageRows([]),{});
  assert.throws(() => parseStorageRows([{key:"x",type:"string",value:""},{key:"x",type:"string",value:""}]),/more than once/);
  assert.throws(() => parseStorageRows([{key:"__proto__",type:"object",value:"{}"}]),/reserved/);
  assert.throws(() => parseStorageRows([{key:"x",type:"boolean",value:'"true"'}]),/must be a boolean/);
  assert.throws(() => parseStorageRows([{key:"x",type:"object",value:'null'}]),/must be a object/);
  assert.throws(() => parseStorageRows([{key:"x",type:"number",value:'1e999'}]),/must be a number/);
});
test("developer proxy exposes schema management but never runtime user values", () => {
  assert.ok(proxyRoute("apps/my-app/storage-schema","GET"));
  assert.ok(proxyRoute("apps/my-app/storage-schema","PUT"));
  for(const method of ["GET","PATCH","POST","DELETE"]) {
    assert.equal(proxyRoute("apps/my-app/storage/users/anon",method),null);
    assert.equal(proxyRoute("apps/my-app/storage/users/anon/reset",method),null);
  }
});
