import type { Journey } from "../../context";
import { signInWithCode } from "../../lib";
import { getMe, newCarbon } from "./_helpers";

const switchProfiles: Journey = {
  name: "account-site-switch-profiles",
  title: "add a second personal account in the same browser and switch back and forth from the profile menu and Your accounts",
  async run(ctx) {
    const { env, results } = ctx;
    const first = await newCarbon(ctx, "profile-first");
    const second = await newCarbon(ctx, "profile-second");
    await second.context.close();

    const { page } = first;
    const menu = page.getByRole("button", { name: /^Account menu/ });
    await menu.click();
    await page.getByRole("menuitem", { name: "Add another account" }).click();
    await signInWithCode(env, page, { email: second.email });
    await page.waitForURL(`${env.site}/`);
    results.check("adding a profile signs the second account in on the first browser", (await getMe(first.probe)).uuid === second.uuid);

    await page.goto(`${env.site}/personal`);
    await menu.click();
    await page.getByRole("menuitemradio", { checked: false }).filter({ hasText: first.id }).click();
    await page.waitForURL(`${env.site}/`);
    results.check("the top-right menu switches to the first profile and returns Home", (await getMe(first.probe)).uuid === first.uuid);

    await menu.click();
    await page.getByRole("menuitem", { name: "Your accounts" }).click();
    const personal = page.getByRole("region", { name: "Personal", exact: true });
    await personal.getByText("Currently Using").waitFor();
    results.check("Your accounts lists both independent profiles", (await personal.getByRole("listitem").count()) === 2);
    await personal.getByRole("listitem").filter({ hasText: second.id }).getByRole("button", { name: "Switch" }).click();
    await page.waitForURL(`${env.site}/`);
    results.check("switching in Your accounts opens Home as the second profile", (await getMe(first.probe)).uuid === second.uuid);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${env.site}/personal`);
    await menu.click();
    const sheet = page.getByRole("dialog", { name: "Switch accounts" });
    const choices = sheet.getByRole("navigation", { name: "Signed-in accounts" });
    results.check("the phone picker marks the active account", await choices.locator('[aria-current="page"]').innerText().then(label => label.includes(second.id)));
    await choices.getByRole("button").filter({ hasText: first.id }).click();
    await page.waitForURL(`${env.site}/`);
    results.check("the phone picker returns Home as the selected profile", (await getMe(first.probe)).uuid === first.uuid);
    await first.context.close();
  },
};

export const journeys: Journey[] = [switchProfiles];
