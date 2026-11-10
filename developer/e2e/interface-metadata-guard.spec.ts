import {test,expect} from "@playwright/test";
import {mock} from "./fixtures";

test("interface documentation drafts are protected across publishing steps and browser history",async({page})=>{
  await mock(page,true,{interface_api_documentation_url:null,interface_use_cases:null,interface_license:null});
  await page.goto("/apps/test-app/publishing?step=4");
  const url=page.getByLabel("Interface API documentation URL");
  await url.fill("https://example.test/interface-api");
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  const question=page.getByRole("dialog",{name:"Leave without saving?"});
  await expect(question).toBeVisible();
  await question.getByRole("button",{name:"Stay"}).click();
  await expect(url).toHaveValue("https://example.test/interface-api");
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await question.getByRole("button",{name:"Leave",exact:true}).click();
  await expect(page).toHaveURL(/step=5/);
  await page.goBack();
  await expect(page).toHaveURL(/step=4/);
  await expect(page.getByLabel("Interface API documentation URL")).toHaveValue("https://example.test/interface-api");
  await page.getByRole("button",{name:"Discard changes"}).click();
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await expect(page).toHaveURL(/step=5/);
});
