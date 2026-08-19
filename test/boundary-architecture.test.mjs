import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function source(path) {
  return readFile(resolve(root, path), "utf8");
}

test("host orchestrator remains a process broker without HTTP listeners or persistent file writes", async () => {
  const main = await source("server-main.mjs");
  assert.doesNotMatch(main, /from\s+["']node:(?:http|https|net|fs|fs\/promises)["']/u);
  assert.doesNotMatch(main, /\b(?:createServer|listen|writeFile|appendFile|mkdir|rename|rm)\s*\(/u);
  assert.doesNotMatch(main, /new\s+OrchestratorHttpServer\b/u);
  for (const worker of [
    "storage-worker.mjs",
    "admin-http-worker.mjs",
    "trusted-worker-http-worker.mjs",
    "remote-http-worker.mjs",
  ]) {
    assert.match(main, new RegExp(worker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  }
});

test("Codex child profiles never enable broad local binding", async () => {
  const files = await Promise.all([
    source("server/codex-sandbox-launcher.mjs"),
    source("server/quick-tunnel.mjs"),
    source("server-main.mjs"),
  ]);
  assert.equal(files.some((text) => text.includes("allow_local_binding")), false);
});

test("Admin and Trusted Worker Quick Tunnels are explicit opt-in while Remote remains default", async () => {
  const main = await source("server-main.mjs");
  assert.match(main, /"open-worker": \{ type: "string" \}/u);
  assert.match(main, /"open-admin": \{ type: "string" \}/u);
  assert.match(main, /worker:\s*parseBooleanOption\(parsed\.values\["open-worker"\], "--open-worker", false\)/u);
  assert.match(main, /admin:\s*parseBooleanOption\(parsed\.values\["open-admin"\], "--open-admin", false\)/u);
  assert.match(main, /remote:\s*true/u);
  assert.match(main, /\(tunnel disabled\)/u);
});

test("startup URLs are grouped into one colorful ready tree and worker token rotation reprints it", async () => {
  const main = await source("server-main.mjs");
  for (const label of [
    "server is ready!",
    "Worker URL",
    "Remote URL",
    "Public WSS",
    "Admin URL",
    "Worker Login",
    "worker session token file",
    "Remote Login Key",
  ]) {
    assert.match(main, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  }
  assert.match(main, /index === rows\.length - 1 \? "└──" : "├──"/u);
  assert.match(main, /serverReady = true;\s*printReadyTree\(\);/u);
  assert.match(main, /async function refreshWorkerSessionToken\(\)[\s\S]*?printReadyTree\(\);/u);
  assert.match(main, /async function resetWorkerAccess\(\)[\s\S]*?printReadyTree\(\);/u);
  assert.doesNotMatch(main, /\[quick tunnel /u);
  assert.doesNotMatch(main, /\[public WSS\]/u);
  assert.match(main, /onLog\(\{ stream, text \}\) \{\s*writeSandboxLog\(`cloudflared:\$\{role\}:\$\{stream\}`, text\);/u);
});

test("public workers deny-read data while storage uses the distinct unelevated identity", async () => {
  const main = await source("server-main.mjs");
  assert.match(main, /sandboxConfig\("storage-worker"[\s\S]*?sandbox:\s*"unelevated"/u);
  assert.doesNotMatch(main, /sandboxConfig\("storage-worker"[\s\S]*?fullDiskRead:\s*true/u);
  assert.equal((main.match(/denyRead:\s*\[dataDirectory\]/gu) ?? []).length, 3);
});

test("Linux direct-test backend is explicit and never replaces the Windows Codex boundary", async () => {
  const [main, client] = await Promise.all([
    source("server-main.mjs"),
    source("server/sandbox-worker-client.mjs"),
  ]);
  assert.match(main, /process\.platform !== "win32"[\s\S]*?TYPED_VOICE_LINUX_DIRECT_TEST === "1"/u);
  assert.match(main, /backend:\s*linuxDirectTestBackend \? "direct-test" : "codex"/u);
  assert.match(client, /config\.backend === "direct-test" \? DirectWorkerProcess : CodexSandboxProcess/u);
  assert.match(main, /Windows Codex sandbox guarantees are not being tested/u);
  assert.match(main, /sibling loopback isolation is not asserted/u);
});

test("startup fails closed unless every public HTTP worker is unable to connect to sibling ports", async () => {
  const main = await source("server-main.mjs");
  assert.match(main, /await assertPublicWorkerIsolation\(\);/u);
  assert.match(main, /client\.request\("assert-loopback-denied", \{ port: ports\[targetRole\] \}\)/u);
});

test("public HTTP roles are instantiated only inside dedicated sandbox worker entrypoints", async () => {
  const [main, admin, worker, remote] = await Promise.all([
    source("server-main.mjs"),
    source("admin/admin-http-worker.mjs"),
    source("worker/trusted-worker-http-worker.mjs"),
    source("worker/remote-http-worker.mjs"),
  ]);
  assert.doesNotMatch(main, /new\s+OrchestratorHttpServer/u);
  assert.match(admin, /roles:\s*\["admin"\]/u);
  assert.match(worker, /roles:\s*\["worker"\]/u);
  assert.match(remote, /roles:\s*\["remote"\]/u);
});

test("role listener implementation rejects non-loopback binds", async () => {
  const http = await source("server/orchestrator-http.mjs");
  assert.match(http, /HTTP role listener host must be loopback/u);
  assert.match(http, /host = "127\.0\.0\.1"/u);
});

test("trusted worker probes an allowed engine file instead of statting the engine directory", async () => {
  const worker = await source("worker/trusted-worker-http-worker.mjs");
  assert.match(worker, /existsSync\(join\(builtEngineRoot, "index\.html"\)\)/u);
  assert.doesNotMatch(worker, /existsSync\(builtEngineRoot\)/u);
});

test("storage worker exposes fixed operations instead of arbitrary path writes", async () => {
  const storage = await source("server/storage-worker.mjs");
  assert.match(storage, /const dataDirectory|data["'],\s*["']history/u);
  assert.doesNotMatch(storage, /params\?\.(?:path|filePath|destinationPath)/u);
  assert.doesNotMatch(storage, /writePrivate\([^\n]*params/u);
});

test("admin-facing pairing state never contains raw Remote authentication or encryption keys", async () => {
  const [main, storage] = await Promise.all([
    source("server-main.mjs"),
    source("server/storage-worker.mjs"),
  ]);
  assert.match(main, /return \{ v: 1, u: endpoint, c: checksum, q \}/u);
  assert.doesNotMatch(storage, /return \{ pairing: \{ \.\.\.pairing, q \}/u);
});
