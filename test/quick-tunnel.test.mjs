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
  let options = null;
  const tunnel = new QuickTunnelProcess({
    localOrigin: "http://127.0.0.1:19132",
    executable: "C:\\tools\\cloudflared.exe",
    codexExecutable: "C:\\tools\\codex.exe",
    cwd: "C:\\work\\typed-voice-server",
    platform: "win32",
    startupTimeoutMs: 1000,
    canonicalExecutableFn(path) { return path; },
    spawnSyncFn() {
      throw new Error("absolute executable paths must not invoke a finder");
    },
    spawnFn(executable, suppliedArgs, suppliedOptions) {
      command = executable;
      args = suppliedArgs;
      options = suppliedOptions;
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
  assert.equal(args.some((value) => String(value).includes("C:\\work\\typed-voice-server")), false);
  assert.equal(options.cwd, "C:\\tools");
});

test("Quick Tunnelはport固有のorigin Host capabilityをcloudflared側で固定する", () => {
  const args = buildQuickTunnelSandboxArgs({
    cloudflaredExecutable: "C:\\tools\\cloudflared.exe",
    localOrigin: "http://127.0.0.1:49152",
    originHostHeader: "tv-worker-0123456789abcdef.invalid",
    cwd: "C:\\work\\typed-voice-server",
    platform: "win32",
  });
  const index = args.indexOf("--http-host-header");
  assert.notEqual(index, -1);
  assert.equal(args[index + 1], "tv-worker-0123456789abcdef.invalid");
});
