import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ProcessTreeWatchdog } from "../server/process-tree-watchdog.mjs";

const fixturePath = fileURLToPath(import.meta.url);
const fixtureMode = process.argv.includes("--watchdog-fixture");
const treeRootMode = process.argv.includes("--tree-root");

function firstLine(stream, timeoutMs = 10_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    const timeout = setTimeout(() => rejectPromise(new Error("fixture did not report its PIDs")), timeoutMs);
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      resolvePromise(buffer.slice(0, newline));
    });
    stream.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`process ${pid} survived watchdog cleanup`);
}

async function runTreeRoot() {
  const leaf = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  leaf.unref();
  process.stdout.write(`${leaf.pid}\n`);
  setTimeout(() => process.exit(0), 1500);
}

async function runWatchdogFixture() {
  const watchdog = new ProcessTreeWatchdog();
  await watchdog.start();
  const treeRoot = spawn(process.execPath, [fixturePath, "--tree-root"], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  watchdog.track(treeRoot.pid);
  const leafPid = Number(await firstLine(treeRoot.stdout));
  await new Promise((resolvePromise) => treeRoot.once("exit", resolvePromise));
  process.stdout.write(`${JSON.stringify({ treeRootPid: treeRoot.pid, leafPid })}\n`);
  setInterval(() => {}, 1000);
}

if (treeRootMode) {
  await runTreeRoot();
} else if (fixtureMode) {
  await runWatchdogFixture();
} else {
  test("orchestratorの強制終了時にwatchdogが子孫process treeを停止する", {
    skip: process.platform !== "win32",
    timeout: 30_000,
  }, async () => {
    const fixture = spawn(process.execPath, [fixturePath, "--watchdog-fixture"], {
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    let treeRootPid = null;
    let leafPid = null;
    try {
      const reported = JSON.parse(await firstLine(fixture.stdout));
      treeRootPid = Number(reported.treeRootPid);
      leafPid = Number(reported.leafPid);
      assert.equal(processExists(treeRootPid), false);
      assert.equal(processExists(leafPid), true);
      process.kill(fixture.pid, "SIGKILL");
      await waitForExit(leafPid);
      assert.equal(processExists(treeRootPid), false);
      assert.equal(processExists(leafPid), false);
    } finally {
      if (processExists(fixture.pid)) process.kill(fixture.pid, "SIGKILL");
      if (treeRootPid && processExists(treeRootPid)) process.kill(treeRootPid, "SIGKILL");
      if (leafPid && processExists(leafPid)) process.kill(leafPid, "SIGKILL");
    }
  });
}
