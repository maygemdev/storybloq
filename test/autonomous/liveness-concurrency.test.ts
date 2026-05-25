import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fork, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const describePosix = process.platform === "win32" ? describe.skip : describe;

const HERE = dirname(fileURLToPath(import.meta.url));

// Helper is written into the per-test tmpDir (not alongside this test file)
// so it is auto-cleaned with the rest of the scratch directory in afterEach.
// The previous approach wrote __liveness-concurrency-helper.mjs next to the
// test and never removed it, polluting the source tree / git status.
function writeHelper(targetPath: string) {
  const livenessPath = join(HERE, "../../src/autonomous/liveness.ts").replace(/\\/g, "/");
  const helper = `
import { spawnAliveSidecar } from "${livenessPath}";
import { writeFileSync } from "node:fs";
const [tDir, resultPath, mode, holdMs] = process.argv.slice(2);
(async () => {
  if (mode === "spawn") {
    const start = Date.now();
    const pid = spawnAliveSidecar(tDir, 500);
    const elapsedMs = Date.now() - start;
    writeFileSync(resultPath, JSON.stringify({ pid, at: Date.now(), elapsedMs }));
  } else if (mode === "hold-lock") {
    const { __testing } = await import("${livenessPath}");
    const handle = __testing.acquireSpawnLock(tDir);
    writeFileSync(resultPath + ".ready", "1");
    await new Promise((r) => setTimeout(r, Number(holdMs || 5000)));
    if (handle) __testing.releaseSpawnLock(handle);
    writeFileSync(resultPath, JSON.stringify({ ok: true }));
  }
})().catch((e) => {
  writeFileSync(resultPath, JSON.stringify({ error: String(e) }));
});
`;
  writeFileSync(targetPath, helper);
}

describePosix("TEST-T-283 liveness concurrency", () => {
  let tmpDir: string;
  let tDir: string;
  let helperPath: string;
  const spawnedPids: number[] = [];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "t283-c-"));
    tDir = join(tmpDir, "telemetry");
    mkdirSync(tDir, { recursive: true });
    helperPath = join(tmpDir, "helper.mjs");
    writeHelper(helperPath);
  });

  afterEach(async () => {
    const pids = spawnedPids.splice(0);
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
    }
    // Grace period for graceful exit.
    await new Promise((r) => setTimeout(r, 200));
    // Escalate to SIGKILL for any survivors so tests never leak sidecars into
    // neighbouring runs. Probe with signal 0 first to skip already-dead pids.
    for (const pid of pids) {
      try { process.kill(pid, 0); } catch { continue; }
      try { process.kill(pid, "SIGKILL"); } catch { /* gone or not ours */ }
    }
    // Short tail wait for kernel to reap before rmSync.
    await new Promise((r) => setTimeout(r, 50));
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Test 19 -- C -- parallel spawns (5 processes) exactly one winner
  it("#19 5 parallel spawners: exactly one non-null PID, one live sentinel", async () => {
    const results: { pid: number | null }[] = [];
    const children = [] as any[];
    for (let i = 0; i < 5; i++) {
      const resultPath = join(tmpDir, `result.${i}.json`);
      const child = fork(helperPath, [tDir, resultPath, "spawn"], { stdio: "ignore", execArgv: ["--import", "tsx"] });
      child.on("error", () => { /* surface via exit/timeout */ });
      children.push({ child, resultPath });
    }
    await Promise.all(children.map(({ child }) => new Promise((r) => child.once("exit", r))));

    for (const { resultPath } of children) {
      const raw = readFileSync(resultPath, "utf-8");
      results.push(JSON.parse(raw));
    }
    const nonNull = results.filter((r) => r.pid !== null);
    expect(nonNull.length).toBe(1);
    const winner = nonNull[0].pid!;
    spawnedPids.push(winner);
    expect(Number(readFileSync(join(tDir, "sidecar.pid"), "utf-8").trim())).toBe(winner);
    let alive = true;
    try { process.kill(winner, 0); } catch { alive = false; }
    expect(alive).toBe(true);
    const psOut = execSync("ps -ef", { encoding: "utf-8" });
    const sentinelLines = psOut.split("\n").filter((l) => l.includes("CLAUDESTORY_SIDECAR_V1") && l.includes(tDir));
    expect(sentinelLines.length).toBe(1);
  }, 20_000);

  // Test 20 -- C -- live-owner inviolate
  it("#20 B waits at least ~ACQUIRE_DEADLINE_MS while A holds lock", async () => {
    const holderResult = join(tmpDir, "holder.json");
    const holder = fork(helperPath, [tDir, holderResult, "hold-lock", "5000"], { stdio: "ignore", execArgv: ["--import", "tsx"] });
    holder.on("error", () => { /* surface via exit/timeout */ });

    // Wait for holder to mark ready
    for (let i = 0; i < 50; i++) {
      if (existsSync(holderResult + ".ready")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(holderResult + ".ready")).toBe(true);

    const bResult = join(tmpDir, "b.json");
    const b = fork(helperPath, [tDir, bResult, "spawn"], { stdio: "ignore", execArgv: ["--import", "tsx"] });
    b.on("error", () => { /* surface via exit/timeout */ });
    await new Promise((r) => b.once("exit", r));

    const bOut = JSON.parse(readFileSync(bResult, "utf-8"));
    expect(bOut.pid).toBeNull();
    // Assert on inner-process elapsed time (measured around spawnAliveSidecar
    // inside the helper) rather than wall-clock around fork(). This excludes
    // fork/tsx cold-start variance, which can be 500ms-1s+ on loaded CI.
    expect(bOut.elapsedMs).toBeGreaterThanOrEqual(1800); // ACQUIRE_DEADLINE_MS * 0.9
    expect(bOut.elapsedMs).toBeLessThanOrEqual(4000);    // ACQUIRE_DEADLINE_MS * 2

    try { holder.kill("SIGTERM"); } catch { /* gone */ }
    await new Promise((r) => holder.once("exit", r));
  }, 15_000);

  // Test 21 -- C -- dead-owner recovery
  it("#21 stale lock with dead pid -> broken, spawn proceeds", async () => {
    writeFileSync(
      join(tDir, "sidecar.lock"),
      JSON.stringify({ pid: 999999, token: "x", acquiredAt: Date.now() - 10_000 })
    );
    const resultPath = join(tmpDir, "r.json");
    const child = fork(helperPath, [tDir, resultPath, "spawn"], { stdio: "ignore", execArgv: ["--import", "tsx"] });
    child.on("error", () => { /* surface via exit/timeout */ });
    await new Promise((r) => child.once("exit", r));
    const out = JSON.parse(readFileSync(resultPath, "utf-8"));
    expect(out.pid).toBeGreaterThan(0);
    spawnedPids.push(out.pid);
    expect(existsSync(join(tDir, "sidecar.pid"))).toBe(true);
  }, 15_000);

  // Test 22 -- C -- live non-owner within staleness floor
  it("#22 live non-owner pid within staleness floor -> spawn returns null within deadline", async () => {
    // use our own pid (live), recent acquiredAt
    writeFileSync(
      join(tDir, "sidecar.lock"),
      JSON.stringify({ pid: process.pid, token: "x", acquiredAt: Date.now() - 1_000 })
    );
    const resultPath = join(tmpDir, "r.json");
    const child = fork(helperPath, [tDir, resultPath, "spawn"], { stdio: "ignore", execArgv: ["--import", "tsx"] });
    child.on("error", () => { /* surface via exit/timeout */ });
    await new Promise((r) => child.once("exit", r));
    const out = JSON.parse(readFileSync(resultPath, "utf-8"));
    expect(out.pid).toBeNull();
    // Inner-process timing excludes fork/tsx cold-start.
    expect(out.elapsedMs).toBeGreaterThanOrEqual(1800);
    expect(out.elapsedMs).toBeLessThanOrEqual(4500);
    expect(existsSync(join(tDir, "sidecar.pid"))).toBe(false);
  }, 15_000);

  // Test 23 -- C -- 3 forks racing a pre-seeded stale lock
  it("#23 3 forks race to break SAME stale lock -> single winner", async () => {
    writeFileSync(
      join(tDir, "sidecar.lock"),
      JSON.stringify({ pid: 999999, token: "x", acquiredAt: Date.now() - 10_000 })
    );
    const results: any[] = [];
    const children: any[] = [];
    for (let i = 0; i < 3; i++) {
      const p = join(tmpDir, `r.${i}.json`);
      const c = fork(helperPath, [tDir, p, "spawn"], { stdio: "ignore", execArgv: ["--import", "tsx"] });
      c.on("error", () => { /* surface via exit/timeout */ });
      children.push({ c, p });
    }
    await Promise.all(children.map(({ c }) => new Promise((r) => c.once("exit", r))));
    for (const { p } of children) results.push(JSON.parse(readFileSync(p, "utf-8")));
    const nonNull = results.filter((r) => r.pid !== null);
    expect(nonNull.length).toBe(1);
    spawnedPids.push(nonNull[0].pid);
    const psOut = execSync("ps -ef", { encoding: "utf-8" });
    const sentinelLines = psOut.split("\n").filter((l) => l.includes("CLAUDESTORY_SIDECAR_V1") && l.includes(tDir));
    expect(sentinelLines.length).toBe(1);
  }, 20_000);
});
