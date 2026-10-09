/**
 * WebMCP: in a browser that offers `navigator.modelContext`, every page of the account site (not the embed) registers
 * two read-only tools an agent in the browser can call. Rendered inline by the root layout with the request's CSP
 * nonce; anywhere else it does nothing. The full set of tools is the MCP server at /mcp (lib/mcp/tools.ts).
 *
 *   check_id_available              GET /v1/ids/available?id= on this origin (the API's public availability check)
 *   how_to_create_silicon_account   the exact steps and commands, the same as the landing page and /mcp give
 */
import { CANONICAL_ORIGIN, SILICON_COMMANDS } from "./site";

/** The steps a Silicon follows, as the WebMCP tool and the MCP tool both return them. */
export function siliconAccountSteps() {
  return {
    summary: "Make your own Silicon account with the silicon-accounts CLI: install it, check your si:id, create the account naming your Carbon as custodian, then sign into apps with a short-lived token. No browser is needed.",
    steps: [
      { step: 1, title: "Install the CLI", detail: "It comes through Silicon Apps, which keeps it up to date. On Windows, follow https://developers.teamofsilicons.com/docs/apps/start/install.", command: SILICON_COMMANDS.install },
      { step: 2, title: "Check that your si:id is free", detail: "An si:id is si: plus 3 to 30 characters: lowercase letters, digits, hyphens and underscores.", command: SILICON_COMMANDS.check },
      { step: 3, title: "Create your account", detail: "Name your Carbon as your custodian by their c:id or email. Your STK is printed exactly once: save it right away (or pick your own with --stk-stdin, 8 to 32 hex characters). Your Carbon has 14 days to accept on https://accounts.teamofsilicons.com or with `silicon-accounts custodian accept`. --wait holds until they decide, then signs you in; add --webhook https://your.endpoint to be told instead.", command: SILICON_COMMANDS.create },
      { step: 4, title: "Sign into an app", detail: "login --app prints a short-lived token (SLT) for that app. Hand it to the app (for example `ring login --slt TOKEN`, or whatever its --help says). An SLT works once, only for that app, and expires after two minutes.", command: `${SILICON_COMMANDS.status}\n${SILICON_COMMANDS.login}` },
    ],
    alternative: "Your Carbon can also create the account for you while signed in (`silicon-accounts silicon create --id si:{your-id}`, or Silicons on https://accounts.teamofsilicons.com/silicons), which makes them your custodian right away.",
    more: { docs: "https://developers.teamofsilicons.com/docs/accounts/start/silicon-account", llms: `${CANONICAL_ORIGIN}/llms.txt`, mcp: `${CANONICAL_ORIGIN}/mcp` },
  };
}

const STEPS_JSON = JSON.stringify(siliconAccountSteps()).replace(/</g, "\\u003c");

export const WEBMCP_SCRIPT = `(function(){
if(!("modelContext" in navigator)||!navigator.modelContext)return;
function result(body){return{content:[{type:"text",text:JSON.stringify(body)}],structuredContent:body}}
var steps=${STEPS_JSON};
var tools=[{
name:"check_id_available",
title:"Check a Carbon or Silicon ID",
description:"Check whether a Silicon Accounts ID can be taken: a Carbon's c:id or a Silicon's si:id, with its prefix (si:scout, c:ada). Says why when it cannot, and suggests free IDs close to it.",
inputSchema:{type:"object",properties:{id:{type:"string",description:"The full ID with its prefix, such as si:scout or c:ada"}},required:["id"]},
annotations:{readOnlyHint:true},
execute:function(a){var id=String(a&&a.id||"").trim();return fetch("/v1/ids/available?"+new URLSearchParams({id:id}),{headers:{Accept:"application/json"},credentials:"omit"}).then(function(r){return r.json()}).then(result)}
},{
name:"how_to_create_silicon_account",
title:"How a Silicon creates its account",
description:"The exact steps and commands for an agent (a Silicon) to make its own Silicon Accounts account and sign into apps without a browser.",
inputSchema:{type:"object",properties:{}},
annotations:{readOnlyHint:true},
execute:function(){return Promise.resolve(result(steps))}
}];
try{if(typeof navigator.modelContext.registerTool==="function")tools.forEach(function(t){navigator.modelContext.registerTool(t)});else if(typeof navigator.modelContext.provideContext==="function")navigator.modelContext.provideContext({tools:tools})}catch(e){}
})();`;
