/**
 * The SSRF guard of a production server. A second accounts-api runs with ACCOUNTS_ENVIRONMENT=production (real
 * secrets, its own database seeded with the fake apps under those secrets, its worker on) next to the stack. Setting a
 * webhook (an app's, or a self-created Silicon's, which anyone may attempt) refuses http, local host names, every
 * private/reserved literal IP in any spelling and URLs with credentials or fragments, and accepts a public https URL.
 * At delivery time the guard holds again: a private webhook stored before (the seeded http fake app) and a host name
 * that only resolves to loopback are never contacted, the delivery records why without naming addresses, and the fake
 * app on this machine receives nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Journey } from "../../context";
import { sleep, tag } from "../../lib";
import { ROOT, appCredentials, brief, call, dropDatabase, errorOf, freshDatabase, key32, runBinary, sparePort, stackEnvFile, waitReady } from "./_helpers";

interface Delivery {
  id: string;
  event_id: string;
  type: string;
  status: string;
  attempts: number;
  last_error: string | null;
  delivered_at: string | null;
}

export const journey: Journey = {
  name: "security-ssrf",
  title: "SSRF guard in production (a production accounts-api on its own seeded database): webhook URLs that are http, local, private/reserved in any IP spelling, or carry credentials are refused when set (apps and self-created Silicons), a public https URL is accepted; at delivery a stored private URL and a name resolving to loopback are never contacted",
  engines: ["chromium"],
  timeoutMs: 600_000,
  async run(ctx) {
    const { env, results } = ctx;
    const port = sparePort(env, 7);
    const url = `http://127.0.0.1:${port}`;
    const publicUrl = "https://account.security-e2e.test";
    const credentials = JSON.parse(readFileSync(join(ROOT, "testkit/dev-credentials.json"), "utf8")) as { messaging: { postmark: { server_token: string }; twilio: { account_sid: string; auth_token: string; messaging_service_sid: string } } };
    const secrets = {
      ACCOUNTS_TOKEN_PEPPER: key32(),
      ACCOUNTS_ENCRYPTION_KEYRING: JSON.stringify({ "5": key32() }),
      ACCOUNTS_ENCRYPTION_CURRENT_VERSION: "5",
      ACCOUNTS_JWT_PRIVATE_KEY: key32(),
      ACCOUNTS_JWT_KEY_ID: `ssrf-${tag()}`,
      ACCOUNTS_PUBLIC_URL: publicUrl,
      ACCOUNTS_TELEMETRY_ENABLED: "false",
    };
    const db = await freshDatabase(env, "sec_prod");
    let server: ReturnType<typeof runBinary> | null = null;
    try {
      // The production database: migrated, and seeded with the same fake apps under the production secrets (seeding
      // runs outside production: the fake apps' webhooks are this machine's http fake app server).
      const migrate = runBinary(env, "accounts-migrate", { ACCOUNTS_DATABASE_URL: db });
      const migrated = await migrate.exited;
      const appsFile = stackEnvFile(env) ? join(ROOT, ".dev/run", String(env.base), "fake-apps.json") : join(ROOT, "testkit/fake-apps.json");
      const seed = runBinary(env, "accounts-seed", { ...secrets, ACCOUNTS_ENVIRONMENT: "test", ACCOUNTS_DATABASE_URL: db, ACCOUNTS_WEBHOOK_ALLOW_PRIVATE: "true" }, { args: ["--fake-apps", appsFile] });
      const seeded = await seed.exited;
      results.check("a separate database is migrated and seeded with the fake apps under the production secrets", migrated === 0 && seeded === 0, `migrate ${migrated}, seed ${seeded}${seeded ? `: ${seed.output().slice(-300)}` : ""}`);

      server = runBinary(env, "accounts-api", {
        ...secrets,
        ACCOUNTS_ENVIRONMENT: "production",
        ACCOUNTS_DATABASE_URL: db,
        ACCOUNTS_BIND_ADDR: `127.0.0.1:${port}`,
        ACCOUNTS_DELIVERY: "providers",
        ACCOUNTS_POSTMARK_SERVER_TOKEN: credentials.messaging.postmark.server_token,
        ACCOUNTS_POSTMARK_API_URL: `${env.messaging}/postmark`,
        ACCOUNTS_TWILIO_API_URL: `${env.messaging}/twilio`,
        ACCOUNTS_TWILIO_ACCOUNT_SID: credentials.messaging.twilio.account_sid,
        ACCOUNTS_TWILIO_AUTH_TOKEN: credentials.messaging.twilio.auth_token,
        ACCOUNTS_TWILIO_MESSAGING_SERVICE_SID: credentials.messaging.twilio.messaging_service_sid,
        ACCOUNTS_WORKER_ENABLED: "true",
      });
      const readyMs = await waitReady(`${url}/readyz`, server);
      results.metric("production accounts-api ready after", readyMs);
      const meta = await call<{ environment?: string }>(`${url}/v1/meta`);
      results.check("the production server is up (environment production, ACCOUNTS_WEBHOOK_ALLOW_PRIVATE left at its production default)", meta.body.environment === "production", JSON.stringify(meta.body).slice(0, 120));

      // 1. Setting an app's webhook.
      const setHook = (target: string, app = "briefcase") => call<{ url?: string; secret?: string }>(`${url}/v1/apps/${app}/webhook`, { method: "PUT", json: { url: target }, basic: appCredentials(app), headers: { "idempotency-key": `sec-${tag()}${tag()}` } });
      const refused: Array<[string, string]> = [
        ["http to this machine's fake app", `${env.apps}/briefcase/webhooks`],
        ["plain http to a public host", "http://hooks.example.com/silicon-accounts"],
        ["https://localhost", "https://localhost/hook"],
        ["a .localhost name", "https://app.localhost/hook"],
        ["a .internal name (cloud metadata)", "https://metadata.google.internal/computeMetadata/v1/"],
        ["127.0.0.1", "https://127.0.0.1/hook"],
        ["127.1 (short form)", "https://127.1/hook"],
        ["2130706433 (decimal 127.0.0.1)", "https://2130706433/hook"],
        ["0x7f.0.0.1 (hex)", "https://0x7f.0.0.1/hook"],
        ["0177.0.0.1 (octal)", "https://0177.0.0.1/hook"],
        ["0.0.0.0", "https://0.0.0.0/hook"],
        ["10.0.0.1", "https://10.0.0.1/hook"],
        ["172.16.5.4", "https://172.16.5.4/hook"],
        ["192.168.1.10", "https://192.168.1.10/hook"],
        ["169.254.169.254 (cloud metadata)", "https://169.254.169.254/latest/meta-data/"],
        ["100.64.0.1 (carrier-grade NAT)", "https://100.64.0.1/hook"],
        ["198.18.0.1 (benchmarking)", "https://198.18.0.1/hook"],
        ["[::1]", "https://[::1]/hook"],
        ["[::ffff:127.0.0.1] (IPv4-mapped)", "https://[::ffff:127.0.0.1]/hook"],
        ["[::ffff:a9fe:a9fe] (mapped metadata)", "https://[::ffff:a9fe:a9fe]/hook"],
        ["[64:ff9b::a9fe:a9fe] (NAT64 metadata)", "https://[64:ff9b::a9fe:a9fe]/hook"],
        ["[fd00::1] (unique local)", "https://[fd00::1]/hook"],
        ["[fe80::1] (link local)", "https://[fe80::1]/hook"],
        ["credentials in the URL", "https://user:pass@hooks.example.com/hook"],
        ["a #fragment", "https://hooks.example.com/hook#x"],
        ["ftp://", "ftp://hooks.example.com/hook"],
        ["file://", "file:///etc/passwd"],
      ];
      const accepted: string[] = [];
      for (const [label, target] of refused) {
        const reply = await setHook(target);
        const fields = (errorOf(reply).details?.fields ?? {}) as Record<string, unknown>;
        if (reply.status !== 422 || !fields.url) accepted.push(`${label}: ${brief(reply)}`);
      }
      results.check(`an app's webhook refuses ${refused.length} URLs when set (422 with details.fields.url): http, localhost/.localhost/.internal names, loopback/private/link-local/reserved IPs in every spelling (short, decimal, hex, octal, IPv4-mapped, NAT64), IPv6 ULA/link-local, credentials, fragments, other schemes`, accepted.length === 0, accepted.join(" | ") || refused.map(([label]) => label).join(", "));
      // The same local names written as fully qualified names (a trailing dot) are the same hosts.
      const dotted: string[] = [];
      for (const target of ["https://localhost./hook", "https://app.localhost./hook", "https://metadata.google.internal./computeMetadata/v1/"]) {
        const reply = await setHook(target);
        if (reply.status !== 422) dotted.push(`${target} → ${brief(reply)}`);
      }
      results.check("local host names written with a trailing dot (localhost., app.localhost., metadata.google.internal.) are refused when set, like the same names without it", dotted.length === 0, dotted.join(" | ") || "all 422");
      const trailingDot = { status: dotted.some(line => line.startsWith("https://localhost./")) ? 200 : 422 };
      const publicHook = await setHook("https://hooks.example.com/silicon-accounts");
      results.check("control: a public https webhook URL is accepted (200, a whsec_ secret)", publicHook.status === 200 && (publicHook.body.secret ?? "").startsWith("whsec_"), brief(publicHook));

      // 2. Self-created Silicons (a public endpoint: anyone may try to make the service call a URL).
      const selfCreate = (target: string) => call(`${url}/v1/silicons`, { json: { id: `si:ssrf-${tag()}${tag()}`.slice(0, 33), display_name: "SSRF", custodian: "c:saket", webhook_url: target }, headers: { "idempotency-key": `sec-${tag()}${tag()}` } });
      const siliconTargets = [`${env.apps}/briefcase/webhooks`, "https://169.254.169.254/latest/meta-data/", "https://[::ffff:10.0.0.1]/hook", "https://localhost/hook"];
      const siliconAccepted: string[] = [];
      for (const target of siliconTargets) {
        const reply = await selfCreate(target);
        const fields = (errorOf(reply).details?.fields ?? {}) as Record<string, unknown>;
        if (reply.status !== 422 || !(fields.webhook_url ?? fields.url)) siliconAccepted.push(`${target}: ${brief(reply)}`);
      }
      results.check(`a self-created Silicon's webhook (public POST /v1/silicons) refuses ${siliconTargets.length} private targets (422 on webhook_url)`, siliconAccepted.length === 0, siliconAccepted.join(" | ") || "all refused");

      // 3. Delivery time. The worker of the production server must never contact a private address.
      const deliveries = async (app: string) => ((await call<{ items?: Delivery[] }>(`${url}/v1/apps/${app}/webhook/deliveries?limit=50`, { basic: appCredentials(app) })).body.items ?? []);
      const waitAttempted = async (app: string, eventId: string): Promise<Delivery | null> => {
        for (let waited = 0; waited < 60; waited++) {
          const found = (await deliveries(app)).find(item => item.event_id === eventId);
          if (found && (found.attempts > 0 || found.last_error || found.status !== "pending")) return found;
          await sleep(500);
        }
        return (await deliveries(app)).find(item => item.event_id === eventId) ?? null;
      };
      const fakeAppEvents = async (app: string) => (await call(`${env.apps}/${app}/_events?include_rejected=1`)).text;

      // (a) dm's webhook was stored (seeded) as http://127.0.0.1:<fake apps>/dm/webhooks before this server's guard.
      const dmTest = await call<{ event_id?: string }>(`${url}/v1/apps/dm/webhook/test`, { method: "POST", basic: appCredentials("dm") });
      const dmEvent = dmTest.body.event_id ?? "";
      const dmDelivery = dmEvent ? await waitAttempted("dm", dmEvent) : null;
      const dmSeen = dmEvent && (await fakeAppEvents("dm")).includes(dmEvent);
      results.check("a private webhook stored before (dm's seeded http://127.0.0.1 URL) is never contacted: its delivery is refused by the guard and the fake app receives nothing", dmTest.status >= 200 && dmTest.status < 300 && !!dmDelivery && !dmDelivery.delivered_at && dmDelivery.status !== "delivered" && /SSRF|https|private|public/i.test(dmDelivery.last_error ?? "") && !dmSeen, `${brief(dmTest)}; delivery ${dmDelivery ? `${dmDelivery.status}, ${dmDelivery.attempts} attempts, "${dmDelivery.last_error}"` : "never attempted"}; fake dm got it: ${dmSeen ? "YES" : "no"}`);

      // (b) A host name that resolves only to loopback at delivery time (DNS-time guard): accepted when set if the
      // set-time check misses it, but never contacted.
      const loopbackName = trailingDot.status === 200 ? "https://localhost./hook" : null;
      if (!loopbackName) results.check("(note) the DNS-time guard is not exercised here: no loopback-only name got past the set-time check", true);
      if (loopbackName) {
        // The public URL set above replaced it: set the loopback name again and send a ping to it.
        await setHook(loopbackName);
        const ping = await call<{ event_id?: string }>(`${url}/v1/apps/briefcase/webhook/test`, { method: "POST", basic: appCredentials("briefcase") });
        const delivery = ping.body.event_id ? await waitAttempted("briefcase", ping.body.event_id) : null;
        results.check("…but a webhook host name that resolves only to loopback is never contacted at delivery (the DNS-time guard), and the recorded error names no address", !!delivery && !delivery.delivered_at && /no public address/.test(delivery.last_error ?? "") && !/127\.0\.0\.1|::1/.test(delivery.last_error ?? ""), `ping ${ping.status}; delivery ${delivery ? `${delivery.status}, ${delivery.attempts} attempts, "${delivery.last_error}"` : "never attempted"}`);
      }
      const leakedLog = [secrets.ACCOUNTS_TOKEN_PEPPER, secrets.ACCOUNTS_JWT_PRIVATE_KEY, publicHook.body.secret ?? "~"].filter(secret => server!.output().includes(secret));
      results.check("the production server's own output never contains its secrets or the webhook secret it issued", leakedLog.length === 0, `${server.output().length} bytes scanned`);
    } finally {
      await server?.stop();
      await dropDatabase(env, db);
    }
  },
};
