/**
 * WebMCP: in a browser that offers `navigator.modelContext`, every page registers two read-only tools an agent in the
 * browser can call, backed by this site's public JSON API (app/api/docs). Rendered inline by the root layout with the
 * request's CSP nonce; anywhere else it does nothing. The full set of tools is the MCP server at /mcp.
 */
export const WEBMCP_SCRIPT = `(function(){
if(!("modelContext" in navigator)||!navigator.modelContext)return;
function call(path){return fetch(path,{headers:{Accept:"application/json"}}).then(function(r){return r.json()}).then(function(body){return{content:[{type:"text",text:JSON.stringify(body)}],structuredContent:body}})}
var tools=[{
name:"search_docs",
title:"Search the Silicon developer docs",
description:"Search the Silicon Apps and Silicon Accounts docs. Returns matching pages and sections with their links and Markdown addresses.",
inputSchema:{type:"object",properties:{query:{type:"string",description:"Words to look for, such as publish an app or invalid_grant"},product:{type:"string",enum:["apps","accounts"]},kind:{type:"string",enum:["start","learn","reference"]},limit:{type:"integer",minimum:1,maximum:50}},required:["query"]},
annotations:{readOnlyHint:true},
execute:function(a){var q=new URLSearchParams({q:String(a&&a.query||"")});if(a&&a.product)q.set("product",a.product);if(a&&a.kind)q.set("kind",a.kind);if(a&&a.limit)q.set("limit",String(a.limit));return call("/api/docs/search?"+q)}
},{
name:"read_doc",
title:"Read a Silicon developer docs page",
description:"Read one docs page as Markdown by its path, such as apps/start/publish or accounts/reference/errors.",
inputSchema:{type:"object",properties:{path:{type:"string",description:"The page path after /docs/"}},required:["path"]},
annotations:{readOnlyHint:true},
execute:function(a){var p=String(a&&a.path||"").replace(/^https?:\\/\\/[^/]+/,"").replace(/^\\/?(docs\\/)?/,"").replace(/\\.md$/,"");return call("/api/docs/pages/"+p.split("/").map(encodeURIComponent).join("/"))}
}];
try{if(typeof navigator.modelContext.registerTool==="function")tools.forEach(function(t){navigator.modelContext.registerTool(t)});else if(typeof navigator.modelContext.provideContext==="function")navigator.modelContext.provideContext({tools:tools})}catch(e){}
})();`;
