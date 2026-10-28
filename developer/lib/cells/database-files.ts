/** CSV/JSON conversion for explicit local imports and downloads. No persistence. */
export function parseRows(text:string,csv:boolean):Record<string,unknown>[] {
  if(new TextEncoder().encode(text).length>900_000)throw new Error("Import at most 900 KB per batch.");
  if(!csv){const value:unknown=editableJson(text);if(!Array.isArray(value)||value.some(row=>row===null||typeof row!=="object"||Array.isArray(row)))throw new Error("Use a JSON array of row objects.");if(value.length<1||value.length>10_000)throw new Error("Import 1–10000 rows per batch.");return value as Record<string,unknown>[];}
  const rows:string[][]=[];let row:string[]=[],field="",quoted=false,closed=false;
  text=text.replace(/^\uFEFF/u,"");
  for(let i=0;i<text.length;i++){
    const c=text[i]!;
    if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;continue;}
    if(c==='"'){if(field||closed)throw new Error("A CSV quote must start a field.");quoted=true;continue;}
    if(closed&&c!==","&&c!=="\r"&&c!=="\n")throw new Error("Unexpected text after a CSV quote.");
    if(c===","){row.push(field);field="";closed=false;}else if(c==="\n"||c==="\r"){if(c==="\r"&&text[i+1]==="\n")i++;row.push(field);rows.push(row);row=[];field="";closed=false;}else field+=c;
  }
  if(quoted)throw new Error("A CSV quoted field is not closed.");if(field||row.length||closed){row.push(field);rows.push(row);}
  const headers=rows.shift();if(!headers?.length||headers.some(h=>!h)||new Set(headers).size!==headers.length)throw new Error("CSV headers must be distinct nonempty column names.");
  if(rows.length<1||rows.length>10_000)throw new Error("Import 1–10000 rows per batch.");
  return rows.map(values=>{if(values.length!==headers.length)throw new Error("Every CSV row must match the header column count.");return Object.fromEntries(headers.map((name,i)=>[name,values[i]===""?null:values[i]]));});
}
/** CSV JSON/array cells use their JSON representation, not a JSON string value. */
export function parseTableRows(text:string,csv:boolean,columns:{name:string;data_type:string}[]):Record<string,unknown>[] {
 const parsed=parseRows(text,csv);if(!csv)return parsed;
 for(const row of parsed)for(const column of columns){if(!Object.hasOwn(row,column.name))continue;const value=row[column.name];if(typeof value==="string"&&(column.data_type==="json"||column.data_type==="jsonb"||column.data_type.endsWith("[]")))row[column.name]=editableJson(value);}
 return parsed;
}
export function rowsText(rows:Record<string,unknown>[],csv:boolean):string {
  if(!csv)return JSON.stringify(rows,null,2);
  const columns=Array.from(new Set(rows.flatMap(Object.keys)));
  const escape=(value:unknown)=>{const text=value===null||value===undefined?"":typeof value==="object"?JSON.stringify(value):String(value);return `"${text.replaceAll('"','""')}"`;};
  return [columns.map(escape).join(","),...rows.map(row=>columns.map(column=>escape(Object.hasOwn(row,column)?row[column]:undefined)).join(","))].join("\r\n")+"\r\n";
}
export function downloadText(name:string,text:string,type="text/plain"){
  const url=URL.createObjectURL(new Blob([text],{type})),link=document.createElement("a");link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
/** Preserve table values exactly when exporting PostgreSQL's JSON text fields. */
export function exactRowsText(snapshots:string[],cells:Record<string,string>[],csv:boolean):string{
 if(!csv)return `[\n${snapshots.join(",\n")}\n]`;
 const columns=Array.from(new Set(cells.flatMap(Object.keys)));
 const value=(raw:string|undefined)=>raw===undefined||raw==="null"?"":raw.startsWith('"')?String(JSON.parse(raw)):raw;
 const escape=(text:string)=>`"${text.replaceAll('"','""')}"`;
 return [columns.map(escape).join(","),...cells.map(row=>columns.map(column=>escape(value(Object.hasOwn(row,column)?row[column]:undefined))).join(","))].join("\r\n")+"\r\n";
}
/** Reject JSON numbers that a browser round trip could change; SQL handles them. */
export function editableJson(text:string):unknown{
 let quoted=false,escaped=false;
 for(let i=0;i<text.length;i++){
  const c=text[i]!;if(quoted){if(escaped)escaped=false;else if(c==="\\")escaped=true;else if(c==='"')quoted=false;continue;}if(c==='"'){quoted=true;continue;}
  if(c==="-"||/[0-9]/u.test(c)){const token=text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];if(!token)continue;const digits=token.split(/[eE]/u)[0]!.replace(/[-.]/gu,"").replace(/^0+/u,"").replace(/0+$/u,"");if(digits.length>15||!Number.isFinite(Number(token))||(digits.length>0&&Math.abs(Number(token))<1e-307))throw new Error("Use SQL for JSON numbers outside the editor’s exact precision range.");i+=token.length-1;}
 }
 return JSON.parse(text) as unknown;
}
