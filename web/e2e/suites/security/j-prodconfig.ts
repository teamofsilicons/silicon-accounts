/**
 * Production refuses unsafe configuration before it listens. The real accounts-api binary started with
 * ACCOUNTS_ENVIRONMENT=production and the DEV ONLY secrets from .env.example (or no secrets, or dev conveniences:
 * local delivery, the dev outbox, private webhooks, insecure cookies, an http public URL, non-contract TTLs) exits with
 * code 2 and names every offending variable and why, without printing the secrets themselves and without ever opening
 * its port. With real secrets it starts: production defaults to __Host- Secure cookies and HSTS, serves no dev outbox,
 * and a stray .env in its directory can't switch any of that back on (production never reads .env).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Journey } from "../../context";
import { tag } from "../../lib";
import { ROOT, brief, call, key32, listening, runBinary, sparePort, waitReady, Jar } from "./_helpers";

/** KEY=VALUE lines of a dotenv file (quotes removed). */
function dotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]!] = match[2]!.replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");
  }
  return out;
}

export const journey: Journey = {
  name: "security-prod-config",
  title: "production refuses dev secrets: accounts-api with ACCOUNTS_ENVIRONMENT=production and the .env.example secrets (as written, or the same keys written differently: another keyring version, a PEM, padded or standard base64), no secrets, or dev conveniences exits 2 naming every variable, prints no secret and never listens; with real secrets it starts with __Host- Secure cookies, HSTS, no dev outbox, and ignores a stray .env",
  engines: ["chromium"],
  async run(ctx) {
    const { env, results } = ctx;
    const port = sparePort(env, 8);
    const dev = dotenv(join(ROOT, ".env.example"));
    const credentials = JSON.parse(readFileSync(join(ROOT, "testkit/dev-credentials.json"), "utf8")) as { messaging: { postmark: { server_token: string } } };
    const devPepper = dev.ACCOUNTS_TOKEN_PEPPER ?? "";
    const devKeyring = dev.ACCOUNTS_ENCRYPTION_KEYRING ?? "";
    const devJwt = dev.ACCOUNTS_JWT_PRIVATE_KEY ?? "";
    results.check("the DEV ONLY secrets are read from .env.example", devPepper.length > 40 && devKeyring.startsWith("{") && devJwt.length > 40, `pepper ${devPepper.length} chars, keyring ${devKeyring.length}, jwt ${devJwt.length}`);
    const publicUrl = "https://account.security-e2e.test";
    const base = {
      ACCOUNTS_ENVIRONMENT: "production",
      ACCOUNTS_BIND_ADDR: `127.0.0.1:${port}`,
      ACCOUNTS_DATABASE_URL: env.db,
      ACCOUNTS_PUBLIC_URL: publicUrl,
      ACCOUNTS_DELIVERY: "providers",
      ACCOUNTS_POSTMARK_SERVER_TOKEN: credentials.messaging.postmark.server_token,
      ACCOUNTS_POSTMARK_API_URL: `${env.messaging}/postmark`,
      ACCOUNTS_WORKER_ENABLED: "false",
      ACCOUNTS_TELEMETRY_ENABLED: "false",
    };

    /** Runs the binary until it exits (it must, within 20 s) and reports what it said. */
    const refuse = async (label: string, vars: Record<string, string>, expected: Array<[string, RegExp]>, secrets: string[] = []) => {
      const started = Date.now();
      const server = runBinary(env, "accounts-api", vars);
      const code = await Promise.race([server.exited, new Promise<"running">(done => setTimeout(() => done("running"), 20_000))]);
      const opened = await listening(port);
      if (code === "running") await server.stop();
      const output = server.output();
      results.metric(`${label}: refused after`, Date.now() - started);
      const missing = expected.filter(([variable, why]) => !output.split("\n").some(line => line.includes(variable) && why.test(line))).map(([variable]) => variable);
      const printed = secrets.filter(secret => secret && output.includes(secret));
      results.check(
        `production with ${label}: exits with code 2 before listening, and names ${expected.map(([variable]) => variable.replace("ACCOUNTS_", "")).join(", ")}`,
        code === 2 && missing.length === 0 && !opened && /can't start/.test(output),
        `exit ${code}, port ${opened ? "OPEN" : "never opened"}${missing.length ? `, not named: ${missing.join(", ")}` : ""}; ${output.split("\n").find(line => /can't start/.test(line)) ?? output.slice(0, 160)}`,
      );
      if (secrets.length) results.check(`…and the refusal (${label}) never prints the secret values it refuses`, printed.length === 0, printed.length ? `${printed.length} secret value(s) printed` : `${output.length} bytes of output, none of the ${secrets.length} values`);
      return output;
    };

    // 1. The .env.example secrets.
    await refuse(
      "the DEV ONLY secrets from .env.example",
      { ...base, ACCOUNTS_TOKEN_PEPPER: devPepper, ACCOUNTS_ENCRYPTION_KEYRING: devKeyring, ACCOUNTS_JWT_PRIVATE_KEY: devJwt, ACCOUNTS_JWT_KEY_ID: "dev-1" },
      [
        ["ACCOUNTS_TOKEN_PEPPER", /DEV ONLY/],
        ["ACCOUNTS_ENCRYPTION_KEYRING", /DEV ONLY/],
        ["ACCOUNTS_JWT_PRIVATE_KEY", /DEV ONLY/],
      ],
      [devPepper, devJwt, JSON.parse(devKeyring)["1"] as string],
    );

    // 2. No secrets at all.
    await refuse("no secrets", { ...base }, [
      ["ACCOUNTS_TOKEN_PEPPER", /required in production/],
      ["ACCOUNTS_ENCRYPTION_KEYRING", /required in production/],
      ["ACCOUNTS_JWT_PRIVATE_KEY", /required in production/],
    ]);

    // 3. Real secrets, but every development convenience switched on.
    const pepper = key32();
    const keyring = JSON.stringify({ "3": key32() });
    const jwt = key32();
    const real = { ...base, ACCOUNTS_TOKEN_PEPPER: pepper, ACCOUNTS_ENCRYPTION_KEYRING: keyring, ACCOUNTS_ENCRYPTION_CURRENT_VERSION: "3", ACCOUNTS_JWT_PRIVATE_KEY: jwt, ACCOUNTS_JWT_KEY_ID: `sec-${tag()}` };
    await refuse(
      "dev conveniences (local delivery, dev outbox, private webhooks, insecure cookies, http URL, short OTP/long token TTLs)",
      { ...real, ACCOUNTS_DELIVERY: "local", ACCOUNTS_EXPOSE_DEV_OUTBOX: "true", ACCOUNTS_WEBHOOK_ALLOW_PRIVATE: "true", ACCOUNTS_COOKIE_SECURE: "false", ACCOUNTS_PUBLIC_URL: "http://account.security-e2e.test", ACCOUNTS_OTP_TTL_SECONDS: "60", ACCOUNTS_ACCESS_TOKEN_TTL_SECONDS: "86400" },
      [
        ["ACCOUNTS_DELIVERY", /local/],
        ["ACCOUNTS_EXPOSE_DEV_OUTBOX", /production/],
        ["ACCOUNTS_WEBHOOK_ALLOW_PRIVATE", /SSRF/],
        ["ACCOUNTS_COOKIE_SECURE", /true in production/],
        ["ACCOUNTS_PUBLIC_URL", /https/],
        ["ACCOUNTS_OTP_TTL_SECONDS", /contract value/],
        ["ACCOUNTS_ACCESS_TOKEN_TTL_SECONDS", /contract value/],
      ],
      [pepper, jwt],
    );

    // 3b. The DEV ONLY keys in disguise: the same key material, written differently. The service decodes its keys
    //     leniently (base64url with or without padding, or standard base64), so the check must compare what they decode
    //     to, not the text.
    const devKey = (JSON.parse(devKeyring) as Record<string, string>)["1"] ?? "";
    const devSeedPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(devJwt, "base64url")]).toString("base64")}\n-----END PRIVATE KEY-----\n`;
    await refuse(
      "the DEV ONLY encryption key under another keyring version (next to a real current key) and the DEV ONLY JWT seed as a PKCS#8 PEM",
      { ...real, ACCOUNTS_ENCRYPTION_KEYRING: JSON.stringify({ "7": key32(), "1": devKey }), ACCOUNTS_ENCRYPTION_CURRENT_VERSION: "7", ACCOUNTS_JWT_PRIVATE_KEY: devSeedPem },
      [
        ["ACCOUNTS_ENCRYPTION_KEYRING", /DEV ONLY/],
        ["ACCOUNTS_JWT_PRIVATE_KEY", /DEV ONLY/],
      ],
      [devKey, devJwt],
    );
    const standard = devPepper.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(devPepper.length / 4) * 4, "=");
    const disguisedPeppers: Array<[string, string]> = [
      ["padded base64url (a trailing =)", devPepper.padEnd(Math.ceil(devPepper.length / 4) * 4, "=")],
      ["standard base64 (+ / and =)", standard],
    ];
    for (const [label, pepperText] of disguisedPeppers) {
      const sameKey = Buffer.from(pepperText.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "base64url").equals(Buffer.from(devPepper, "base64url"));
      const started = Date.now();
      const server = runBinary(env, "accounts-api", { ...real, ACCOUNTS_TOKEN_PEPPER: pepperText });
      const outcome = await Promise.race([
        server.exited.then(code => `exit ${code}`),
        waitReady(`http://127.0.0.1:${port}/readyz`, server, 20_000).then(ms => `STARTED (ready after ${ms} ms)`, () => "neither exited nor became ready within 20 s"),
      ]);
      await server.stop();
      const output = server.output();
      results.metric(`the DEV ONLY pepper as ${label}: decided after`, Date.now() - started);
      const named = output.split("\n").some(line => line.includes("ACCOUNTS_TOKEN_PEPPER") && /DEV ONLY/.test(line));
      results.check(`production with the DEV ONLY token pepper written as ${label} (the same 32 bytes) exits with code 2 naming ACCOUNTS_TOKEN_PEPPER as the DEV ONLY value`, sameKey && outcome === "exit 2" && named, `${sameKey ? "decodes to the dev pepper's bytes" : "NOT the same bytes (test bug)"}; ${outcome}${named ? "" : "; ACCOUNTS_TOKEN_PEPPER not named"}${output.includes(devPepper) || output.includes(pepperText) ? "; the pepper was PRINTED" : ""}`);
    }

    // 4. Real secrets and safe settings: it starts. A stray .env in its directory is ignored in production.
    const dir = mkdtempSync(join(tmpdir(), "sa-sec-prod-"));
    writeFileSync(join(dir, ".env"), ["ACCOUNTS_EXPOSE_DEV_OUTBOX=true", "ACCOUNTS_WEBHOOK_ALLOW_PRIVATE=true", "ACCOUNTS_COOKIE_SECURE=false", `ACCOUNTS_TOKEN_PEPPER=${devPepper}`, "ACCOUNTS_ENVIRONMENT=development", ""].join("\n"));
    const server = runBinary(env, "accounts-api", real, { cwd: dir });
    try {
      const readyMs = await waitReady(`http://127.0.0.1:${port}/readyz`, server, 60_000);
      results.metric("production accounts-api ready after", readyMs);
      const meta = await call<{ environment?: string; public_url?: string }>(`http://127.0.0.1:${port}/v1/meta`);
      const outbox = await call(`http://127.0.0.1:${port}/v1/dev/outbox`);
      const flowJar = new Jar();
      const flow = await call(`http://127.0.0.1:${port}/v1/flows`, { json: { app_id: "briefcase", redirect_uri: `${env.apps}/briefcase/callback`, state: "s" }, jar: flowJar, origin: publicUrl });
      const cookie = flowJar.last("__Host-sa_flow");
      results.check("with real secrets and safe settings production starts and reports environment production", meta.body.environment === "production" && meta.body.public_url === publicUrl, JSON.stringify(meta.body).slice(0, 160));
      results.check("…a stray .env next to it (dev outbox, private webhooks, insecure cookies, the dev pepper, development) changes nothing: no dev outbox (404), __Host- Secure cookies, HSTS", outbox.status === 404 && flow.status === 201 && !!cookie?.attributes.has("secure") && /max-age=/.test(meta.headers.get("strict-transport-security") ?? ""), `outbox ${brief(outbox)}; flow ${flow.status} cookie ${cookie?.line.replace(/=[^;]{12}[^;]*/, "=…") ?? "none"}; HSTS ${meta.headers.get("strict-transport-security") ?? "none"}`);
      results.check("…and its output never contains its secrets", ![pepper, jwt, JSON.parse(keyring)["3"] as string].some(secret => server.output().includes(secret)), `${server.output().length} bytes scanned`);
    } finally {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
};
