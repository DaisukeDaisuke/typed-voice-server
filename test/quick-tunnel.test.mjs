import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PassThrough } from "node:stream";
import { QuickTunnelProcess, buildQuickTunnelSandboxArgs, extractTryCloudflareUrl } from "../server/quick-tunnel.mjs";

test("trycloudflare URLをcloudflaredログから抽出する", () => {
  assert.equal(
    extractTryCloudflareUrl("INF +--------------------------------------+\nINF | https://amber-forest-123.trycloudflare.com |"),
    "https://amber-forest-123.trycloudflare.com",
  );
  assert.equal(extractTryCloudflareUrl("https://example.com"), null);
});

test("QuickTunnelProcessはCodex online workspace内のcloudflared stderrから分割URLを拾う", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  let command = null;
  let args = null;
  const tunnel = new QuickTunnelProcess({
    localOrigin: "http://127.0.0.1:19132",
    executable: "C:\\tools\\cloudflared.exe",
    codexExecutable: "C:\\tools\\codex.exe",
    cwd: "C:\\work\\typed-voice-server",
    platform: "win32",
    startupTimeoutMs: 1000,
    spawnSyncFn() {
      throw new Error("absolute executable paths must not invoke a finder");
    },
    spawnFn(executable, suppliedArgs) {
      command = executable;
      args = suppliedArgs;
      queueMicrotask(() => {
        child.stderr.write("INF Requesting new quick Tunnel on trycloudflare.com...\nINF https://quiet-");
        child.stderr.write("river-77.trycloudflare.com is ready\n");
      });
      return child;
    },
  });
  assert.equal(await tunnel.start(), "https://quiet-river-77.trycloudflare.com");
  assert.equal(command, "C:\\tools\\codex.exe");
  assert.deepEqual(args, buildQuickTunnelSandboxArgs({
    cloudflaredExecutable: "C:\\tools\\cloudflared.exe",
    localOrigin: "http://127.0.0.1:19132",
    cwd: "C:\\work\\typed-voice-server",
    platform: "win32",
  }));
  assert.ok(args.some((value) => value.includes("network={enabled=true}")));
  assert.ok(args.includes("--permission-profile"));
  assert.ok(args.includes("C:\\tools\\cloudflared.exe"));
});
