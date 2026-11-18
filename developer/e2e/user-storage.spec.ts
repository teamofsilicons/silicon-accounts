import {test, expect} from "@playwright/test";
import {mock} from "./fixtures";

test("creation accepts optional typed storage and rejects duplicate keys before submission", async ({page}) => {
  const changes = await mock(page,true);
  await page.goto("/apps");
  await page.getByRole("button",{name:"New app",exact:true}).click();
  await page.getByLabel("App name",{exact:true}).fill("Settings demo");
  await page.getByLabel("App ID",{exact:true}).fill("test-app");
  await expect(page.getByText("This app ID is available")).toBeVisible();
  await page.getByRole("button",{name:"Add storage key"}).click();
  await page.getByLabel("Key 1",{exact:true}).fill("theme");
  await page.getByLabel("Initial value 1",{exact:true}).fill("system");
  await page.getByRole("button",{name:"Add storage key"}).click();
  await page.getByLabel("Key 2",{exact:true}).fill("theme");
  await page.getByRole("button",{name:"Create app",exact:true}).last().click();
  await expect(page.getByRole("alert")).toContainText("appears more than once");
  expect(changes.filter(change => change.path === "/apps")).toHaveLength(0);
  await page.getByLabel("Key 2",{exact:true}).fill("alerts");
  await page.getByLabel("Type 2",{exact:true}).click();
  await page.getByRole("option",{name:"boolean",exact:true}).click();
  await page.getByRole("button",{name:"Create app",exact:true}).last().click();
  await expect.poll(() => changes.find(change => change.path === "/apps")?.body.user_storage).toEqual({theme:{type:"string",default:"system"},alerts:{type:"boolean",default:true}});
  await expect(page.getByText("test-secret-shown-once")).toBeVisible();
});

test("existing apps can add storage keys while saved fields stay fixed", async ({page}) => {
  const changes = await mock(page,true,{user_storage:{theme:{type:"string",default:"system"}}});
  await page.goto("/apps/test-app/publishing?step=1");
  await expect(page.getByLabel("Key 1",{exact:true})).toBeDisabled();
  await page.getByRole("button",{name:"Add storage key"}).click();
  await page.getByLabel("Key 2",{exact:true}).fill("fontSize");
  await page.getByLabel("Type 2",{exact:true}).click();
  await page.getByRole("option",{name:"number",exact:true}).click();
  await page.getByLabel("Initial value 2",{exact:true}).fill("14");
  await page.getByRole("button",{name:"Save storage definition"}).click();
  await expect(page.getByText("Storage definition saved")).toBeVisible();
  expect(changes.find(change => change.path.endsWith("/storage-schema"))?.body).toEqual({theme:{type:"string",default:"system"},fontSize:{type:"number",default:14}});
});
