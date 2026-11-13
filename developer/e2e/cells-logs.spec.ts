import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";
test("logs filters and opaque paging keep payloads private and report native query coverage",async({page})=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));await mock(page,true);
  const at="2026-10-28T12:00:00Z",requests:URL[]=[];let native=false;
  await page.route("**/api/cells/**",async route=>{
    const url=new URL(route.request().url()),path=url.pathname.replace("/api/cells","");requests.push(url);let result:unknown;
    if(path==="/cells/notes")result={cell:{uuid:"12345678-1234-1234-1234-123456789abc",cell_id:"notes",name:"Notes",url:"https://notes.cells.example",status:"active",created_at:at,deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}}};
    else if(path==="/cells/notes/logs")result={logs:[{id:url.searchParams.has("before")?"api:older":"function:latest",source:"functions",category:"invocation",resource:url.searchParams.has("before")?"Older task":"Latest task",reference_id:"safe-reference",created_at:at,status:"failed",response_status:504,duration_ms:20,error_code:"<img src=x onerror=alert(1)>",metric:null,method:null,route:null,request_id:null}],next:url.searchParams.has("before")?null:"opaque_fixture_cursor",retention_days:30};
    else if(path==="/cells/notes/database/slow-queries")result={queries:[{source:"author",fingerprint:"a".repeat(64),statement_type:"SELECT",calls:3,failed:0,total_ms:300,mean_ms:100,max_ms:200,last_seen:at}],native:{status:native?"available":"unavailable",reason:native?null:"pg_stat_statements_not_installed"},observed_at:at,retention_days:30};
    else throw new Error(`Unexpected private request ${path}`);
    await route.fulfill({json:result});
  });
  await page.goto("/cells/notes/logs");await expect(page.getByRole("heading",{name:"Activity logs",exact:true})).toBeVisible();await expect(page.getByText("functions · invocation · Latest task",{exact:true})).toBeVisible();await expect(page.getByText(/Native PostgreSQL statistics are unavailable/)).toBeVisible();expect(await page.locator('img[src="x"]').count()).toBe(0);
  await page.getByRole("combobox",{name:"Log source",exact:true}).click();await page.getByRole("option",{name:"functions",exact:true}).click();await page.getByLabel("Search logs",{exact:true}).fill("function_timeout");await page.getByText("More log filters",{exact:true}).click();await page.getByLabel("Status",{exact:true}).fill("failed");await page.getByRole("button",{name:"Apply log filters",exact:true}).click();
  await expect.poll(()=>requests.filter(url=>url.pathname.endsWith("/logs")).at(-1)?.searchParams.get("q")).toBe("function_timeout");expect(requests.filter(url=>url.pathname.endsWith("/logs")).at(-1)?.searchParams.get("source")).toBe("functions");
  await page.getByRole("button",{name:"Older logs",exact:true}).click();await expect(page.getByText("functions · invocation · Older task",{exact:true})).toBeVisible();await expect(page.getByRole("button",{name:"Older logs",exact:true})).toBeDisabled();expect(requests.filter(url=>url.pathname.endsWith("/logs")).at(-1)?.searchParams.get("before")).toBe("opaque_fixture_cursor");
  await page.getByRole("button",{name:"Newer logs",exact:true}).click();await expect(page.getByText("functions · invocation · Latest task",{exact:true})).toBeVisible();
  native=true;await page.getByRole("button",{name:"Refresh query statistics",exact:true}).click();await expect(page.getByText(/Native PostgreSQL statistics are available/)).toBeVisible();await page.getByRole("combobox",{name:"Sort query statistics",exact:true}).click();await page.getByRole("option",{name:"Total execution time",exact:true}).click();await expect.poll(()=>requests.filter(url=>url.pathname.endsWith("/slow-queries")).at(-1)?.searchParams.get("sort")).toBe("total");
  await expect(page.getByRole("link",{name:"Open functions details",exact:true})).toHaveAttribute("href","/cells/notes/functions");expect(errors).toEqual([]);
});
