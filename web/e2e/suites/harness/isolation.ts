/**
 * The harness checks itself: what every other suite relies on when many stacks run side by side (scripts/e2e-all.sh,
 * or one scripts/e2e.sh per suite at the same time). Fast (a few seconds) and touching nothing other suites use.
 */
import type { Journey } from "../../context";
import { api, json, newContext, randomIp, signInOnSite, sql, tag } from "../../lib";

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export const journey: Journey = {
  name: "harness-isolation",
  title: "the harness itself: this stack's site build reaches this stack's API and database, photos come from its mock Iris, nothing leaves the machine, and every browser context and journey reaches the API from its own address",
  async run(ctx) {
    const { env, results, browser } = ctx;

    // The site is this stack's own build: its /v1 proxy reaches this stack's accounts-api (each stack's public URL is
    // its own site, so another stack's API would answer with another URL).
    const viaSite = await json<{ public_url?: string }>(`${env.site}/v1/meta`);
    const direct = await json<{ public_url?: string }>(`${env.api}/v1/meta`);
    results.check("the site's /v1 reaches this stack's accounts-api", viaSite.body.public_url === env.site && direct.body.public_url === env.site, `site → ${viaSite.body.public_url}, api → ${direct.body.public_url}`);
    const [[database] = []] = await sql(env, "select current_database()");
    results.check("sql() reaches the stack's own database", !!database && env.db.endsWith(`/${database}`), String(database));
    const page0 = await fetch(`${env.site}/sign-in`);
    const csp = page0.headers.get("content-security-policy") ?? "";
    results.check("the site's CSP lets pages show this stack's mock Iris photos", csp.includes(new URL(env.iris).origin), csp.match(/img-src[^;]*/)?.[0] ?? csp);

    // A browser context with an address of its own signs up with an email code: the code counts against that address.
    const ip = randomIp();
    const context = await newContext(browser, { forwardedFor: ip });
    const page = await context.newPage();
    results.watch(page, "harness");
    const hosts = new Set<string>();
    page.on("request", request => {
      if (!request.url().startsWith("data:") && !request.url().startsWith("blob:")) hosts.add(new URL(request.url()).host);
    });
    const email = `harness.${tag()}@example.test`;
    await signInOnSite(env, page, email);
    const counted = await sql(env, `select bucket, count from rate_limits where bucket in ('otp_send:ip:${ip}', 'otp_send:ip:127.0.0.1')`);
    const count = (bucket: string) => Number(counted.find(([name]) => name === bucket)?.[1] ?? 0);
    results.check("a browser context's code request counts against its own address, not 127.0.0.1", count(`otp_send:ip:${ip}`) === 1, JSON.stringify(counted));
    const drawn = await json<{ items?: Array<{ referer: string | null; id: string }> }>(`${env.iris}/_requests`);
    results.check("its profile photos came from this stack's mock Iris", !!drawn.body.items?.some(item => item.referer?.startsWith(env.site)), `${drawn.body.items?.length ?? 0} photos drawn`);
    const away = [...hosts].filter(host => !LOCAL.test(host));
    results.check("no request of the page left this machine", away.length === 0, away.join(", ") || [...hosts].join(", "));
    await context.close();

    // The journey's own address for direct API calls (lib.ts api()).
    const answer = await api<{ available?: boolean }>(ctx, `/v1/ids/available?id=c:harness-${tag()}`);
    const [[hits] = []] = await sql(env, `select count from rate_limits where bucket = 'ids_available:ip:${ctx.ip}'`);
    results.check("api() calls reach accounts-api from the journey's own address", answer.status === 200 && Number(hits) >= 1, `${answer.status}, ${hits ?? 0} hit(s) for ${ctx.ip}`);
  },
};
