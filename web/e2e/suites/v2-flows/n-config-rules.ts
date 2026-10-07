/**
 * The rules of an app's flow and page copy (build spec 06-v2.md §4: "Rules (422 with field paths when broken): 1..=8
 * steps; step id [a-z0-9-]{1,40} unique; every field of required_fields ∪ optional_fields appears in exactly ONE step
 * and steps only contain requested fields; a step has ≥1 field; title ≤ 80, subtitle ≤ 200, continue_label ≤ 30 chars
 * (plain text); layout null or card|split|minimal; review bool. Removing a field from the requested details removes it
 * from its step and drops an emptied step"; §5: copy.opening_title ≤ 80 chars, may contain {provider} and {app}).
 *
 * Every broken document is refused with the path of what is wrong and changes nothing; the merges a developer relies on
 * (a flow object merging into the stored one, details leaving and joining steps, flow: null) keep the document valid;
 * every accepted change is a new version with a history entry. ledgerly's setup is put back at the end.
 */
import type { Journey } from "../../context";
import { api } from "../../lib";
import { appDetails, basicAuth, patchConfig, restoreConfig, type AppDetails } from "./_helpers";

type Step = { id: string; fields: string[]; title?: string | null; subtitle?: string | null; continue_label?: string | null; layout?: string | null };
const contact: Step = { id: "contact", fields: ["phone"] };
const about: Step = { id: "about-you", fields: ["dob", "timezone"] };

export const journey: Journey = {
  name: "v2-flows-config-rules",
  title: "an app's flow and page copy are validated with field paths (steps 1..8, ids, each requested detail on exactly one step, lengths, layouts, opening_title placeholders); merges keep the flow consistent (details leave and join steps, emptied steps go, flow: null); each change is versioned in the history",
  async run(ctx) {
    const { results } = ctx;
    const before = (await appDetails(ctx, "ledgerly")).signin_config;
    const versionBefore = (await appDetails(ctx, "ledgerly")).config_version ?? 0;
    try {
      const refuse = async (name: string, patch: Record<string, unknown>, path: string | RegExp) => {
        const answer = await patchConfig(ctx, "ledgerly", patch);
        const fields = answer.body.error?.details?.fields ?? {};
        const hit = Object.keys(fields).find(key => (typeof path === "string" ? key === path : path.test(key)));
        results.check(`${name} → 422 at ${String(path)}`, answer.status === 422 && answer.body.error?.code === "validation_failed" && !!hit, `${answer.status} ${JSON.stringify(fields).slice(0, 300)}`);
      };
      const step = (extra: Partial<Step>) => ({ flow: { steps: [{ ...contact }, { ...about, ...extra }], review: true } });

      await refuse("a flow with no steps", { flow: { steps: [], review: false } }, "flow.steps");
      await refuse("a flow with 9 steps", { flow: { steps: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, fields: i === 0 ? ["phone"] : i === 1 ? ["dob"] : i === 2 ? ["timezone"] : [] })), review: false } }, "flow.steps");
      await refuse("a step id with capitals and a space", step({ id: "About You" }), "flow.steps[1].id");
      await refuse("a step id longer than 40", step({ id: "a".repeat(41) }), "flow.steps[1].id");
      await refuse("two steps with the same id", step({ id: "contact" }), "flow.steps[1].id");
      await refuse("a step with no details", { flow: { steps: [{ ...contact }, { ...about }, { id: "empty", fields: [] }], review: true } }, "flow.steps[2].fields");
      await refuse("a detail ledgerly does not ask for (email) on a step", step({ fields: ["dob", "timezone", "email"] }), "flow.steps[1].fields[2]");
      await refuse("the same detail on two steps", step({ fields: ["dob", "timezone", "phone"] }), "flow.steps[1].fields[2]");
      await refuse("a requested detail on no step (timezone)", step({ fields: ["dob"] }), "flow.steps");
      await refuse("a title of 81 characters", step({ title: "t".repeat(81) }), "flow.steps[1].title");
      await refuse("a subtitle of 201 characters", step({ subtitle: "s".repeat(201) }), "flow.steps[1].subtitle");
      await refuse("a continue label of 31 characters", step({ continue_label: "c".repeat(31) }), "flow.steps[1].continue_label");
      await refuse("a layout that does not exist (grid)", step({ layout: "grid" }), /^flow\.steps\[1\]\.layout$/);
      await refuse("review that is not true or false", { flow: { review: "yes" } }, /^flow\.review$/);
      await refuse("an unknown key on a step", { flow: { steps: [{ ...contact, colour: "red" }, { ...about }], review: true } }, "flow.steps[0].colour");
      await refuse("an opening_title of 81 characters", { copy: { opening_title: "o".repeat(81) } }, "copy.opening_title");
      await refuse("an opening_title with a placeholder that does not exist ({service})", { copy: { opening_title: "Opening {service}…" } }, "copy.opening_title");
      await refuse("a signup_title of 81 characters", { copy: { signup_title: "x".repeat(81) } }, "copy.signup_title");
      await refuse("the same detail required and optional", { required_fields: ["phone", "dob", "timezone"], optional_fields: ["timezone"] }, /required_fields|optional_fields/);
      const unchanged = await appDetails(ctx, "ledgerly");
      results.check("none of the refused changes touched ledgerly's setup (same version, same flow)", unchanged.config_version === versionBefore && JSON.stringify(unchanged.signin_config.flow) === JSON.stringify(before.flow), `version ${unchanged.config_version} vs ${versionBefore}`);

      // Accepted changes and the merges that keep the flow consistent.
      const steps = (details: AppDetails) => ((details.signin_config.flow as { steps?: Step[] } | null)?.steps ?? null)?.map(entry => `${entry.id}:${entry.fields.join("+")}`) ?? null;
      const titled = await patchConfig(ctx, "ledgerly", { copy: { opening_title: "Off to {provider} for {app}…" }, flow: { review: false } });
      results.check("a flow object merges into the stored flow ({flow: {review: false}} keeps both steps) and opening_title may use {provider} and {app}", titled.status === 200 && (titled.body.signin_config.flow as { review?: boolean } | null)?.review === false && JSON.stringify(steps(titled.body)) === JSON.stringify(["contact:phone", "about-you:dob+timezone"]) && titled.body.signin_config.copy?.opening_title === "Off to {provider} for {app}…", `${titled.status} ${JSON.stringify(steps(titled.body))} ${JSON.stringify(titled.body.signin_config.copy?.opening_title)}`);
      results.check("…as a new version", (titled.body.config_version ?? 0) === versionBefore + 1, `${titled.body.config_version} vs ${versionBefore}`);
      const dropped = await patchConfig(ctx, "ledgerly", { required_fields: ["dob"] });
      results.check("dropping the phone from the details takes it off its step, and the emptied step goes", dropped.status === 200 && JSON.stringify(steps(dropped.body)) === JSON.stringify(["about-you:dob+timezone"]), `${dropped.status} ${JSON.stringify(steps(dropped.body))}`);
      const joined = await patchConfig(ctx, "ledgerly", { required_fields: ["dob", "email"] });
      results.check("a newly requested detail (email) joins the last step", joined.status === 200 && JSON.stringify(steps(joined.body)) === JSON.stringify(["about-you:dob+timezone+email"]), `${joined.status} ${JSON.stringify(steps(joined.body))}`);
      const emptied = await patchConfig(ctx, "ledgerly", { required_fields: [], optional_fields: [] });
      results.check("asking for no details at all leaves no flow (null: the one what's-shared page)", emptied.status === 200 && (emptied.body.signin_config.flow ?? null) === null, `${emptied.status} ${JSON.stringify(emptied.body.signin_config.flow)}`);
      await refuse("a flow for an app that asks for no details", { flow: { steps: [{ id: "x", fields: ["email"] }], review: false } }, "flow.steps");
      const restored = await patchConfig(ctx, "ledgerly", { required_fields: ["phone", "dob"], optional_fields: ["timezone"], flow: { steps: [contact, about], review: true } });
      results.check("details and a flow sent together are checked together (accepted when consistent)", restored.status === 200 && JSON.stringify(steps(restored.body)) === JSON.stringify(["contact:phone", "about-you:dob+timezone"]), `${restored.status} ${JSON.stringify(steps(restored.body))}`);
      const reset = await patchConfig(ctx, "ledgerly", { flow: null });
      results.check("flow: null goes back to the default (one page)", reset.status === 200 && (reset.body.signin_config.flow ?? null) === null, `${reset.status} ${JSON.stringify(reset.body.signin_config.flow)}`);

      const history = await api<{ items?: Array<{ version: number; changes: Array<{ path: string }> }> }>(ctx, "/v1/apps/ledgerly/signin-config/history?limit=20", { direct: true, headers: { authorization: basicAuth("ledgerly") } });
      const paths = (history.body.items ?? []).flatMap(item => item.changes.map(change => change.path));
      results.check("the history keeps every accepted change, newest first (flow, details, copy.opening_title)", history.status === 200 && (history.body.items?.[0]?.version ?? 0) > versionBefore && paths.includes("flow") && paths.includes("required_fields") && paths.includes("copy.opening_title"), `${history.status} ${JSON.stringify(paths.slice(0, 20))}`);
    } finally {
      await restoreConfig(ctx, "ledgerly", before);
    }
  },
};
