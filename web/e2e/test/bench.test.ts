/**
 * The harness's benchmark helpers (lib.ts withBenchSlot, waitForCalm, watchStalls), in a slot directory of their own.
 *
 *   web/node_modules/.bin/tsx --test web/e2e/test/*.test.ts
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FROZEN_STALL_MS, sleep, waitForCalm, watchStalls, withBenchSlot } from "../lib";

const freshSlot = () => join(mkdtempSync(join(tmpdir(), "e2e-bench-")), "e2e-bench");

/** A pid no process has (the highest pids are rarely in use; checked, not assumed). */
function deadPid(): number {
  for (let pid = 99_999; pid > 90_000; pid--) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("no free pid found");
}

describe("withBenchSlot", () => {
  it("takes a free slot, names its holder, and frees it afterwards", async () => {
    const dir = freshSlot();
    const seen = await withBenchSlot("9650 chromium latency", async slot => {
      assert.equal(slot.held, true);
      assert.equal(slot.heldBy, null);
      return readFileSync(join(dir, "owner"), "utf8").trim();
    }, { dir });
    assert.equal(seen, `${process.pid} 9650 chromium latency`);
    assert.equal(existsSync(dir), false);
  });

  it("frees the slot when the benchmark throws", async () => {
    const dir = freshSlot();
    await assert.rejects(withBenchSlot("thrower", async () => Promise.reject(new Error("boom")), { dir }), /boom/);
    assert.equal(existsSync(dir), false);
  });

  it("waits for the holder to finish, then holds the slot itself", async () => {
    const dir = freshSlot();
    const order: string[] = [];
    const first = withBenchSlot("9650 chromium latency", async () => {
      order.push("first starts");
      await sleep(1500);
      order.push("first ends");
    }, { dir });
    await sleep(100);
    const second = await withBenchSlot("9660 webkit latency", async slot => {
      order.push("second starts");
      return slot;
    }, { dir, waitMs: 20_000 });
    await first;
    assert.deepEqual(order, ["first starts", "first ends", "second starts"]);
    assert.equal(second.held, true);
    assert.ok(second.waitedMs >= 1000, `waited ${second.waitedMs} ms`);
    assert.equal(second.heldBy, `${process.pid} 9650 chromium latency`);
    assert.equal(existsSync(dir), false);
  });

  it("runs without the slot after waiting `waitMs`, and leaves the holder's slot alone", async () => {
    const dir = freshSlot();
    let release!: () => void;
    const first = withBenchSlot("holder", () => new Promise<void>(done => (release = done)), { dir });
    await sleep(50);
    const second = await withBenchSlot("waiter", async slot => slot, { dir, waitMs: 600 });
    assert.equal(second.held, false);
    assert.ok(second.waitedMs >= 600 && second.waitedMs < 3000, `waited ${second.waitedMs} ms`);
    assert.equal(readFileSync(join(dir, "owner"), "utf8").trim(), `${process.pid} holder`);
    release();
    await first;
    assert.equal(existsSync(dir), false);
  });

  it("takes over the slot of a holder that died", async () => {
    const dir = freshSlot();
    mkdirSync(dir);
    writeFileSync(join(dir, "owner"), `${deadPid()} 9650 chromium latency\n`);
    const slot = await withBenchSlot("heir", async held => held, { dir, waitMs: 5000 });
    assert.equal(slot.held, true);
    assert.ok(slot.waitedMs < 1000, `waited ${slot.waitedMs} ms`);
  });

  it("takes over a slot left without an owner for over 30 s, and gives a younger one time to name its owner", async () => {
    const young = freshSlot();
    mkdirSync(young);
    assert.equal((await withBenchSlot("waiter", async slot => slot, { dir: young, waitMs: 300 })).held, false);
    const orphan = freshSlot();
    mkdirSync(orphan);
    const minuteAgo = new Date(Date.now() - 60_000);
    utimesSync(orphan, minuteAgo, minuteAgo);
    assert.equal((await withBenchSlot("heir", async slot => slot, { dir: orphan, waitMs: 300 })).held, true);
  });
});

describe("waitForCalm", () => {
  it("answers at once with the load and the cores when it may not wait", async () => {
    const calm = await waitForCalm(0);
    assert.equal(calm.cores, availableParallelism());
    assert.equal(calm.calm, calm.load <= calm.cores);
    assert.ok(calm.waitedMs < 1000);
  });
});

/** Blocks this thread for `ms` (nothing else of the process runs meanwhile, as when the machine sleeps). */
const standStill = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

describe("watchStalls", () => {
  it("reads a process that keeps running as running, however long the wait", async () => {
    const watch = watchStalls(20);
    await sleep(400);
    const stall = watch.stop();
    assert.ok(stall < 200, `stall ${stall} ms`);
  });

  it("sees the time a process stood still, at the end of a run too", async () => {
    const watch = watchStalls(20);
    await sleep(60);
    standStill(700);
    await sleep(60);
    assert.ok(watch.stop() >= 650);
    const late = watchStalls(20);
    standStill(500);
    assert.ok(late.stop() >= 450, "a stall right before stop() counts");
  });

  it("sees a process that was stopped and continued (SIGSTOP, SIGCONT), as a sleeping machine leaves it", { skip: process.platform === "win32" }, async () => {
    // node itself with tsx's loader (the tsx command is a wrapper process: stopping it would not stop the script).
    const here = dirname(fileURLToPath(import.meta.url));
    const script = join(mkdtempSync(join(tmpdir(), "e2e-stall-")), "child.mts");
    writeFileSync(script, `import { watchStalls } from ${JSON.stringify(pathToFileURL(join(here, "../lib.ts")).href)};\nconst w = watchStalls(20);\nconsole.log("ready");\nsetTimeout(() => console.log("stall " + Math.round(w.stop())), 2000);\n`);
    const child = spawn(process.execPath, ["--import", "tsx", script], { cwd: join(here, "../.."), stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    for (let i = 0; i < 600 && !out.includes("ready"); i++) await sleep(50);
    assert.ok(out.includes("ready"), "the child started");
    await sleep(100);
    child.kill("SIGSTOP");
    await sleep(1200);
    child.kill("SIGCONT");
    await new Promise(done => child.on("exit", done));
    const stall = Number(/stall (\d+)/.exec(out)?.[1]);
    assert.ok(stall >= 1000 && stall < 5000, `stall ${stall} ms`);
  });

  it("calls seconds frozen, never the milliseconds of a loaded machine", () => {
    assert.ok(FROZEN_STALL_MS >= 5000);
  });
});
