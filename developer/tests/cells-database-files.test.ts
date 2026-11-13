import {test} from "node:test";
import assert from "node:assert/strict";
import {parseTableRows,parseRows,rowsText,exactRowsText,editableJson} from "../lib/cells/database-files";
test("CSV preserves quoted commas, embedded newlines and escaped quotes",()=>{
 const rows=parseRows('\uFEFFid,value,empty\r\n1,"hello, \"\"world\"\"\nnext",\r\n',true);assert.deepEqual(rows,[{id:"1",value:'hello, "world"\nnext',empty:null}]);assert.deepEqual(parseRows(rowsText(rows,true),true),rows);
});
test("imports reject malformed headers, broken quotes, row widths and non-object JSON",()=>{
 for(const csv of ['id,id\n1,2','id,value\n1','id\n"unfinished','id\n"ok"bad'])assert.throws(()=>parseRows(csv,true));
 for(const json of ['{}','[null]','[[]]','[]'])assert.throws(()=>parseRows(json,false));
 assert.deepEqual(parseRows('[{"__proto__":"data","a":1}]',false),[JSON.parse('{"__proto__":"data","a":1}')]);
});

test("table exports preserve exact integer/decimal tokens and edited JSON rejects lossy numbers",()=>{
 const snapshot='{"id":9007199254740993,"amount":0.10000000000000002,"value":"quoted"}';
 const cells={id:"9007199254740993",amount:"0.10000000000000002",value:'"quoted"'};
 assert.ok(exactRowsText([snapshot],[cells],false).includes(snapshot));assert.ok(exactRowsText([snapshot],[cells],true).includes('"9007199254740993","0.10000000000000002"'));
 assert.throws(()=>editableJson('{"id":9007199254740993}'));assert.throws(()=>editableJson('1e-999'));assert.throws(()=>editableJson('3e-324'));assert.deepEqual(editableJson('{"x":0.1,"s":"9007199254740993"}'),{x:0.1,s:"9007199254740993"});
});

test("CSV JSON and array columns preserve structures rather than JSON strings",()=>{
 assert.deepEqual(parseTableRows('id,document,tags\n9007199254740993,"{\"\"value\"\":true}","[1,2]"\n',true,[{name:"document",data_type:"jsonb"},{name:"tags",data_type:"integer[]"}]),[{id:"9007199254740993",document:{value:true},tags:[1,2]}]);
});
