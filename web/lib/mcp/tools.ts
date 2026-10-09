/**
 * The tools /mcp offers, all read-only, each one call to the Silicon Accounts API on the server (ACCOUNTS_API_URL):
 *
 *   check_id_available               whether a c:id or si:id can be taken: GET /v1/ids/available?id=
 *   lookup_account                   an account's public identity by c:id, si:id or uuid: GET /v1/accounts/by-id/{id}
 *                                    or /v1/accounts/{uuid}, as the caller (its Authorization header: an app's Basic
 *                                    credentials or a Carbon's or Silicon's bearer token); without one, whether the id
 *                                    is held (from the availability check) and how to look it up
 *   get_capabilities                 what this deployment supports: GET /v1/capabilities (GET /v1/meta on servers
 *                                    without it), with `require` passed on
 *   get_openid_configuration         GET /.well-known/openid-configuration
 *   how_to_create_silicon_account    the exact steps and commands, filled in with the Silicon's id and custodian
 *   docs_link                        where the developer docs answer a topic
 *
 * Failures come back as tool results with isError, in the API's own words (code, message, hint).
 */
import "server-only";
import { apiUrl, developerUrl } from "@/lib/server/meta";
import { CANONICAL_ORIGIN, DOCS_TOPICS, LINKS, SILICON_COMMANDS, matchTopic } from "@/lib/site";
import { siliconAccountSteps } from "@/lib/webmcp";
import { isToolResult, stringArg, toolError, toolResult, type Tool, type ToolContext, type ToolResult } from "./protocol";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const LOCAL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const UPSTREAM_TIMEOUT_MS = 10_000;

type Upstream = { ok: true; status: number; body: unknown } | { ok: false; status: number; result: ToolResult };

/** GET a JSON endpoint of the Accounts API, as the caller's address and (when asked) with its Authorization. */
async function upstream(path: string, context: ToolContext, { auth = false, allow = [404] }: { auth?: boolean; allow?: number[] } = {}): Promise<Upstream> {
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "silicon-accounts-mcp" };
  if (context.forwardedFor) headers["X-Forwarded-For"] = context.forwardedFor;
  if (auth && context.authorization) headers.Authorization = context.authorization;
  let response: Response;
  try {
    response = await fetch(`${apiUrl()}${path}`, { headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "did not answer within 10 seconds" : "could not be reached";
    return { ok: false, status: 0, result: toolError("upstream_unreachable", `Silicon Accounts ${reason}.`, "Try again in a moment.") };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status === 429) {
    const after = response.headers.get("retry-after");
    return { ok: false, status: 429, result: toolError("rate_limited", "Silicon Accounts is limiting requests from you right now.", after ? `Wait ${after} seconds, then try again.` : "Wait a little, then try again.") };
  }
  if (!response.ok && !allow.includes(response.status)) {
    const error = (body as { error?: { code?: string; message?: string; hint?: string } } | null)?.error;
    return { ok: false, status: response.status, result: toolError(error?.code ?? "upstream_error", error?.message ?? `Silicon Accounts answered ${response.status}.`, error?.hint ?? "Try again in a moment.") };
  }
  return { ok: true, status: response.status, body };
}

const ID_INPUT = { type: "string", maxLength: 64, description: "The full ID with its prefix: a Carbon's c:id (c:ada) or a Silicon's si:id (si:scout)." } as const;
const isAccountId = (value: string) => /^(c|si):/i.test(value);
const isUuid = (value: string) => /^[A-Za-z0-9]{3,12}$/.test(value);

/** Fills the commands with what the Silicon told us, leaving the placeholders it did not. */
function filled(command: string, id: string | null, custodian: string | null): string {
  let out = command;
  if (id) out = out.replaceAll("si:{your-id}", id);
  if (custodian) out = out.replaceAll("{your-carbon-email@example.com}", custodian);
  return out;
}

export const TOOLS: Tool[] = [
  {
    definition: {
      name: "check_id_available",
      title: "Check a Carbon or Silicon ID",
      description: "Check whether a Silicon Accounts ID can be taken: a Carbon's c:id or a Silicon's si:id, with its prefix (si:head_of_growth). Says why when it cannot, and suggests free IDs close to it. Use it before creating a Silicon account.",
      inputSchema: { type: "object", properties: { id: ID_INPUT }, required: ["id"], additionalProperties: false },
      annotations: { title: "Check a Carbon or Silicon ID", ...READ_ONLY },
    },
    async call(args, context) {
      const value = stringArg(args, "id", { required: true, max: 64 });
      if (isToolResult(value)) return value;
      const answer = await upstream(`/v1/ids/available?${new URLSearchParams({ id: (value ?? "").trim() })}`, context);
      if (!answer.ok) return answer.result;
      return toolResult(answer.body);
    },
  },
  {
    definition: {
      name: "lookup_account",
      title: "Look up an account",
      description: "An account's public identity (uuid, kind, c:id or si:id, status, and a Silicon's custodian) by its c:id, si:id or uuid. Reads as you: send your Authorization header with the MCP request (an app's Basic app_id:secret, or the bearer access token `silicon-accounts login` gives a Carbon or Silicon). Without one it says whether the ID is held, and how to look it up.",
      inputSchema: {
        type: "object",
        properties: { account: { type: "string", maxLength: 64, description: "A c:id or si:id with its prefix (si:scout), or a uuid (k3Q)." } },
        required: ["account"],
        additionalProperties: false,
      },
      annotations: { title: "Look up an account", ...READ_ONLY },
    },
    async call(args, context) {
      const value = stringArg(args, "account", { required: true, max: 64 });
      if (isToolResult(value)) return value;
      const account = (value ?? "").trim();
      const byId = isAccountId(account);
      if (!byId && !isUuid(account)) return toolError("invalid_account", `"${account.slice(0, 64)}" is neither an ID nor a uuid.`, "Pass a c:id or si:id with its prefix (si:scout), or a uuid of 3 to 12 letters and digits.");
      const path = byId ? `/v1/accounts/by-id/${encodeURIComponent(account.toLowerCase())}` : `/v1/accounts/${encodeURIComponent(account)}`;
      if (!context.authorization) {
        const how = "Send an Authorization header with the MCP request: an app's Basic base64(app_id:app_secret), or the bearer access token a Carbon or Silicon gets from `silicon-accounts login`. Or run `silicon-accounts lookup <id>` while signed in.";
        if (!byId) return toolResult({ account, found: null, identity: null, needs: "authorization", message: `Looking up a uuid needs credentials. ${how}` });
        const answer = await upstream(`/v1/ids/available?${new URLSearchParams({ id: account })}`, context);
        if (!answer.ok) return answer.result;
        const availability = answer.body as { id?: string; available?: boolean; reason?: string | null } | null;
        const held = availability?.available === false && availability.reason !== "invalid";
        return toolResult({
          account: availability?.id ?? account,
          found: held ? "held" : availability?.reason === "invalid" ? "invalid" : "not_held",
          identity: null,
          needs: "authorization",
          message: held
            ? `${availability?.id ?? account} is held by an account (or reserved for 10 days after its owner changed it). The public identity needs credentials. ${how}`
            : availability?.reason === "invalid"
              ? `${account} is not a valid ID.`
              : `No account holds ${availability?.id ?? account} right now.`,
        });
      }
      const answer = await upstream(path, context, { auth: true });
      if (!answer.ok) return answer.result;
      if (answer.status === 404) {
        const error = (answer.body as { error?: { code?: string; message?: string; hint?: string } } | null)?.error;
        return toolError(error?.code ?? "account_not_found", error?.message ?? `No account is ${account}.`, error?.hint ?? "Check the ID or uuid.");
      }
      return toolResult(answer.body);
    },
  },
  {
    definition: {
      name: "get_capabilities",
      title: "What this server supports",
      description: "What this Silicon Accounts deployment supports: API versions, how to authenticate (bearer tokens, app credentials, STK, OAuth), sign-in methods, event streaming, subscriptions, webhooks and limits. Pass require (comma-separated capability names) to ask whether this server supports all of them.",
      inputSchema: {
        type: "object",
        properties: { require: { type: "string", maxLength: 300, description: "Capability names that must be supported, comma-separated (event_stream,subscriptions)." } },
        additionalProperties: false,
      },
      annotations: { title: "What this server supports", ...READ_ONLY },
    },
    async call(args, context) {
      const require = stringArg(args, "require", { max: 300 });
      if (isToolResult(require)) return require;
      const query = require?.trim() ? `?${new URLSearchParams({ require: require.trim() })}` : "";
      const answer = await upstream(`/v1/capabilities${query}`, context, { allow: [404, 422] });
      if (!answer.ok) return answer.result;
      if (answer.status !== 404) return toolResult(answer.body);
      // A server from before /v1/capabilities: its meta says what it is.
      const meta = await upstream("/v1/meta", context);
      if (!meta.ok) return meta.result;
      return toolResult({ source: "/v1/meta", note: "This server has no /v1/capabilities yet; this is its meta.", meta: meta.body });
    },
  },
  {
    definition: {
      name: "get_openid_configuration",
      title: "OpenID Connect discovery",
      description: "The OpenID Connect discovery document of Silicon Accounts: issuer, authorization, token, userinfo, revocation and introspection endpoints, JWKS, grants and scopes.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "OpenID Connect discovery", ...READ_ONLY },
    },
    async call(_args, context) {
      const answer = await upstream("/.well-known/openid-configuration", context, { allow: [] });
      if (!answer.ok) return answer.result;
      return toolResult(answer.body);
    },
  },
  {
    definition: {
      name: "how_to_create_silicon_account",
      title: "How a Silicon makes its account",
      description: "The exact steps and commands for an agent (a Silicon) to make its own Silicon Accounts account and sign into apps without a browser. Give your si:id and your Carbon's c:id or email to get the commands filled in (and your si:id checked).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", maxLength: 64, description: "The si:id you want, such as si:scout." },
          custodian: { type: "string", maxLength: 254, description: "Your Carbon's c:id or email, who becomes your custodian." },
        },
        additionalProperties: false,
      },
      annotations: { title: "How a Silicon makes its account", ...LOCAL },
    },
    async call(args, context) {
      const id = stringArg(args, "id", { max: 64 });
      if (isToolResult(id)) return id;
      const custodian = stringArg(args, "custodian", { max: 254 });
      if (isToolResult(custodian)) return custodian;
      const wanted = id?.trim() ? (id.trim().toLowerCase().startsWith("si:") ? id.trim().toLowerCase() : `si:${id.trim().toLowerCase()}`) : null;
      const guide = siliconAccountSteps();
      const steps = guide.steps.map(step => ({ ...step, command: filled(step.command, wanted, custodian?.trim() || null) }));
      let availability: unknown = null;
      if (wanted) {
        const answer = await upstream(`/v1/ids/available?${new URLSearchParams({ id: wanted })}`, context);
        availability = answer.ok ? answer.body : null;
      }
      const result = { ...guide, steps, ...(wanted ? { id: wanted, availability } : {}) };
      const text = [
        guide.summary,
        "",
        ...steps.flatMap(step => [`${step.step}. ${step.title}`, step.detail, "", "```sh", step.command, "```", ""]),
        guide.alternative,
        wanted && availability ? `\n${(availability as { message?: string }).message ?? ""}` : "",
        `\nMore: ${guide.more.docs}`,
      ].join("\n");
      return toolResult(result, text.trim());
    },
  },
  {
    definition: {
      name: "docs_link",
      title: "Find the docs for a topic",
      description: `Where the Silicon Accounts docs on the developer site answer a topic, with the page's address and its Markdown. Topics: ${Object.keys(DOCS_TOPICS).join(", ")}. Building an app or adding sign-in to one is all there.`,
      inputSchema: {
        type: "object",
        properties: { topic: { type: "string", maxLength: 100, description: `One of: ${Object.keys(DOCS_TOPICS).join(", ")}. Free words are matched to the closest topic.` } },
        required: ["topic"],
        additionalProperties: false,
      },
      annotations: { title: "Find the docs for a topic", ...LOCAL },
    },
    async call(args) {
      const value = stringArg(args, "topic", { required: true, max: 100 });
      if (isToolResult(value)) return value;
      const topic = matchTopic(value ?? "");
      const base = await developerUrl();
      const entry = DOCS_TOPICS[topic];
      return toolResult({
        topic,
        title: entry.title,
        url: `${base}${entry.path}`,
        markdown_url: `${base}${entry.path}.md`,
        all_docs: `${base}/docs/accounts`,
        llms_txt: `${base}/llms.txt`,
        topics: Object.keys(DOCS_TOPICS),
      });
    },
  },
];

export const SERVER = {
  name: "silicon-accounts",
  title: "Silicon Accounts",
  version: "1.0.0",
  instructions: [
    "Silicon Accounts gives every Carbon (a person) and every Silicon (an agent) one account for every app in the Silicon ecosystem.",
    "If you are a Silicon without an account, call how_to_create_silicon_account with the si:id you want and your Carbon's c:id or email, then run the commands it gives you: it takes one command and your Carbon's one-time OK.",
    "Use check_id_available before taking an ID, lookup_account to read an account's public identity (send your Authorization header), get_capabilities and get_openid_configuration to see what the API offers, and docs_link to find the developer docs for a topic.",
    `Every tool only reads. To act, use the silicon-accounts CLI or the Accounts API (${CANONICAL_ORIGIN}/openapi.json). Building an app lives on ${LINKS.developers}.`,
    `The commands: install with \`${SILICON_COMMANDS.install.split("\n").join(" ")}\`, then \`${SILICON_COMMANDS.create}\`.`,
  ].join(" "),
};
