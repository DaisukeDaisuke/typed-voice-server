import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { terminateProcessTree } from "../server/process-tree.mjs";

test("Windows cleanup uses taskkill /T /F for the entire Codex child tree", async () => {
  const child = new EventEmitter();
  child.pid = 4321;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;

  const calls = [];
  await terminateProcessTree(child, {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    timeoutMs: 20,
    spawnFn(executable, args, options) {
      calls.push({ executable, args, options });
      const killer = new EventEmitter();
      killer.kill = () => true;
      queueMicrotask(() => killer.emit("exit", 0, null));
      return killer;
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, "C:\\Windows\\System32\\taskkill.exe");
  assert.deepEqual(calls[0].args, ["/PID", "4321", "/T", "/F"]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
});
