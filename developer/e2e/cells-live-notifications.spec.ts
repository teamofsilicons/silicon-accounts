import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";
test("dashboard live updates require consent and refetch private data through author routes",async({page})=>{
  await mock(page,true);
  let reads=0,streams=0;
  await page.route("**/api/cells/**",async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith("/notifications/live")){
      streams++;
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({allow:true});
      expect(route.request().headers().authorization).toBeUndefined();
      return route.fulfill({contentType:"text/event-stream",body:"event: ready\ndata: {}\n\nevent: changed\ndata: {}\n\n"});
    }
    if(path.endsWith("/notifications")){reads++;return route.fulfill({json:{configured:true,active:true,deliveries:[],next:null}});}
    if(path.endsWith("/history"))return route.fulfill({json:{events:[],history:[]}});
    return route.fulfill({json:{cell:{uuid:"11111111-1111-4111-8111-111111111111",cell_id:"notes",name:"Notes",status:"active",url:"https://notes.cells.example",created_at:"2026-11-10T00:00:00Z",deleted_at:null,settings:{allowed_origins:[],redirect_urls:[]}}}});
  });
  await page.goto("/cells/notes/history");
  await expect(page.getByRole("button",{name:"Enable live updates",exact:true})).toBeVisible();
  expect(streams).toBe(0);const before=reads;
  await page.getByRole("button",{name:"Enable live updates",exact:true}).click();
  await expect.poll(()=>streams).toBeGreaterThan(0);
  await expect.poll(()=>reads).toBeGreaterThan(before);
  await page.getByRole("button",{name:"Stop live updates",exact:true}).click();
  await expect(page.getByText("Live updates are off",{exact:true})).toBeVisible();
  const stopped=streams;await page.waitForTimeout(1200);expect(streams).toBe(stopped);
  expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toContain("recv_");
});
