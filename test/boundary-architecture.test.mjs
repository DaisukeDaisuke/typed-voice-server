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
  assert.match(main, /setTimeout\(resolvePromise, 2_000\)[\s\S]*?serverReady = true;\s*printReadyTree\(\);/u);
  assert.match(main, /serverReady = true;\s*printReadyTree\(\);/u);
  assert.match(main, /async function refreshWorkerSessionToken\(\)[\s\S]*?printReadyTree\(\);/u);
  assert.match(main, /async function resetWorkerAccess\(\)[\s\S]*?printReadyTree\(\);/u);
  assert.doesNotMatch(main, /\[quick tunnel /u);
  assert.doesNotMatch(main, /\[public WSS\]/u);
  assert.match(main, /onLog\(\{ stream, text \}\) \{\s*writeSandboxLog\(`cloudflared:\$\{role\}:\$\{stream\}`, text\);/u);
});

test("clean shutdown is reachable from Ctrl+C and non-empty terminal input and tears down process trees", async () => {
  const [main, tunnel, launcher, tree] = await Promise.all([
    source("server-main.mjs"),
    source("server/quick-tunnel.mjs"),
    source("server/codex-sandbox-launcher.mjs"),
    source("server/process-tree.mjs"),
  ]);
  assert.match(main, /process\.stdin\.on\("data", acceptShutdownInput\)/u);
  assert.match(main, /if \(!line\.trim\(\)\) continue;[\s\S]*?shutdown\(0, "stdin"\)/u);
  assert.match(main, /process\.on\("SIGINT"[\s\S]*?shutdown\(0, "Ctrl\+C"\)/u);
  assert.match(main, /Promise\.allSettled\(activeTunnels\.map\(\(tunnel\) => tunnel\.stop\(\)\)\)/u);
  assert.match(tunnel, /terminateProcessTree\(child/u);
  assert.match(launcher, /terminateProcessTree\(child/u);
  assert.match(tree, /\["\/PID", String\(pid\), "\/T", "\/F"\]/u);
});

test("public workers deny-read data while storage uses the restricted elevated backend", async () => {
  const main = await source("server-main.mjs");
  assert.match(main, /sandboxConfig\("storage-worker"[\s\S]*?sandbox:\s*"elevated"/u);
  assert.doesNotMatch(main, /sandboxConfig\("storage-worker"[\s\S]*?fullDiskRead:\s*true/u);
  assert.equal((main.match(/denyRead:\s*\[dataDirectory\]/gu) ?? []).length, 3);
});

test("sandbox worker RPC opens fd 0/1 directly instead of process stdio wrappers", async () => {
  const [stdio, storage, admin, worker, remote] = await Promise.all([
    source("server/stdio-peer.mjs"),
    source("server/storage-worker.mjs"),
    source("admin/admin-http-worker.mjs"),
    source("worker/trusted-worker-http-worker.mjs"),
    source("worker/remote-http-worker.mjs"),
  ]);
  assert.match(stdio, /createReadStream\(null, \{ fd: 0, autoClose: false \}\)/u);
  assert.match(stdio, /createWriteStream\(null, \{ fd: 1, autoClose: false \}\)/u);
  for (const entrypoint of [storage, admin, worker, remote]) {
    assert.match(entrypoint, /createFdStdioPeer\(/u);
    assert.doesNotMatch(entrypoint, /new StdioPeer\(process\.stdin, process\.stdout/u);
  }
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
});

test("startup does not assume sibling loopback TCP is blocked by the Codex sandbox", async () => {
  const [main, admin, worker, remote] = await Promise.all([
    source("server-main.mjs"),
    source("admin/admin-http-worker.mjs"),
    source("worker/trusted-worker-http-worker.mjs"),
    source("worker/remote-http-worker.mjs"),
  ]);
  for (const sourceText of [main, admin, worker, remote]) {
    assert.doesNotMatch(sourceText, /assert-loopback-denied|assertLoopbackConnectDenied|assertPublicWorkerIsolation/u);
  }
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

test("trusted worker runtime does not depend on server-bundled browser assets", async () => {
  const [main, worker, http, build, docker] = await Promise.all([
    source("server-main.mjs"),
    source("worker/trusted-worker-http-worker.mjs"),
    source("server/orchestrator-http.mjs"),
    source(".github/workflows/build.yml"),
    source("docker.mjs"),
  ]);
  assert.doesNotMatch(main, /engineDirectory|engineSourceDirectory/u);
  assert.doesNotMatch(worker, /engineRoot|builtEngineRoot|sourceEngineRoot/u);
  assert.doesNotMatch(http, /engineRoot|serveEngineAsset/u);
  assert.doesNotMatch(build, /typed-voice\/dist|typed-voice-server\/engine/u);
  assert.doesNotMatch(docker, /engine\/index\.html/u);
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
