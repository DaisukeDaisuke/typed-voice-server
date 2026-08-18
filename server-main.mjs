import { createHash, randomBytes, randomInt } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { ChromeEnginePool, findChrome } from "./server/chrome-pool.mjs";
import { WorkerControlServer } from "./server/control-server.mjs";
import { SandboxedMcpClient } from "./server/sandbox-mcp-client.mjs";
import { CodexSandboxProcess } from "./server/codex-sandbox-launcher.mjs";
import { AdminSandboxClient } from "./server/admin-sandbox-client.mjs";
import { HistoryStore } from "./server/history-store.mjs";
import { probeAdminWebSocket, probeRemoteEndpoint } from "./server/connectivity-probe.mjs";
import { writeEncryptedPairingFile, removeEncryptedPairingFile } from "./server/pairing-file.mjs";
import { ServerSettingsStore } from "./server/settings-store.mjs";
import { ProcessTreeWatchdog } from "./server/process-tree-watchdog.mjs";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const workerDirectory = join(projectRoot, "worker");
const workerEntry = join(workerDirectory, "websocket-worker.mjs");
const adminDirectory = join(projectRoot, "admin");
const adminEntry = join(adminDirectory, "admin-worker.mjs");
const webDirectory = join(projectRoot, "web");
const engineDirectory = join(projectRoot, "engine");
const historyDirectory = join(projectRoot, "data", "history");
const chromeProfileDirectory = join(projectRoot, "data", "chrome-profile");
const settingsPath = join(projectRoot, "data", "settings.json");
const pairingFilePath = join(projectRoot, "data", "pairing", "typed-voice-server.tvrkey");

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    multi: { type: "string", default: "1" },
    profile: { type: "string" },
    "engine-url": { type: "string" },
    chrome: { type: "string" },
    codex: { type: "string" },
    cloudflared: { type: "string" },
    "no-open-ui": { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});

const multi = Number(parsed.values.multi);
if (!Number.isSafeInteger(multi) || multi < 1 || multi > 8) throw new Error("--multi must be an integer from 1 to 8");
const requestedProfile = parsed.values.profile === undefined ? null : String(parsed.values.profile);
if (requestedProfile !== null && !["fp32", "fp16", "mobile-int8", "mobile-int4"].includes(requestedProfile)) throw new Error("--profile is not supported");

function findOnPath(configured, names, label) {
  if (configured) return resolve(configured);
  if (process.platform !== "win32") throw new Error(`${label} must be supplied explicitly on this platform`);
  for (const name of names) {
    const result = spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) continue;
    const path = result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
    if (path) return path;
  }
  throw new Error(`${label} was not found on PATH`);
}

function pairingChecksum(endpoint, authKey, encryptionKey) {
  return createHash("sha256")
    .update(Buffer.from("typed-voice-remote-qr/v1\n", "utf8"))
    .update(Buffer.from(endpoint, "utf8"))
    .update(Buffer.from([0]))
    .update(authKey)
    .update(encryptionKey)
    .digest()
    .subarray(0, 16);
}

function buildPairing(endpoint, authKey, encryptionKey) {
  return {
    v: 1,
    u: endpoint,
    a: authKey.toString("base64url"),
    e: encryptionKey.toString("base64url"),
    c: pairingChecksum(endpoint, authKey, encryptionKey).toString("base64url"),
  };
}

const state = {
  overall: "準備中",
  tunnel: "待機中",
  chrome: "待機中",
  webmcp: "待機中",
  model: "待機中",
  control: "待機中",
  adminWorker: "待機中",
  publicWorker: "待機中",
  clients: 0,
  runningJobs: 0,
  queuedJobs: 0,
  engineSlots: [],
  sessions: [],
  pairingEndpoint: null,
  pairingReady: false,
  modelProfile: requestedProfile ?? "fp16",
};

let pairingPayload = null;
let workerClient = null;
let tunnelProcess = null;
let pool = null;
let controlServer = null;
let adminClient = null;
let historyStore = null;
let settingsStore = null;
let pairingFileResolvedPath = null;
const processWatchdog = new ProcessTreeWatchdog();
const historySubscriptions = new Map();
let shuttingDown = false;

const ANSI = Object.freeze({
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  dim: "\x1b[2m",
});

function consoleLine(color, label, value) {
  process.stdout.write(`${color}${label}${ANSI.reset} ${value}\n`);
}

function updateState(partial) {
  Object.assign(state, partial);
  pushAdmin({ type: "state", state: adminSnapshot() });
}

function recordHistory(entry) {
  void persistHistoryEvent(entry).catch((error) => {
    process.stderr.write(`[history] ${error instanceof Error ? error.message : String(error)}\n`);
  });
}

async function persistHistoryEvent(entry) {
  if (!historyStore || !entry?.conversationId) return;
  let event;
  if (entry.phase === "request") {
    event = await historyStore.recordRequest({
      conversationId: entry.conversationId,
      requestId: entry.requestId,
      text: entry.text,
      at: entry.at,
    });
  } else if (entry.phase === "result") {
    event = await historyStore.recordResult({
      conversationId: entry.conversationId,
      requestId: entry.requestId,
      ok: entry.ok,
      cancelled: entry.cancelled,
      error: entry.error,
      durationMs: entry.durationMs,
      at: entry.at,
    });
  } else {
    return;
  }
  if ((historySubscriptions.get(entry.conversationId) ?? 0) > 0) {
    pushAdmin({
      type: "history-event",
      conversationId: entry.conversationId,
      event,
      metadata: historyStore.getMetadata(entry.conversationId),
    });
  }
}

function openUi(chromePath, admin) {
  if (parsed.values["no-open-ui"]) return;
  const adminUrl = new URL(admin.url);
  adminUrl.hash = admin.token;
  const child = spawn(chromePath, ["--new-window", adminUrl.href], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function adminSnapshot() {
  const poolStatus = pool?.status();
  return {
    ...state,
    runningJobs: Number(poolStatus?.running || 0),
    queuedJobs: Number(poolStatus?.queued || 0),
  };
}

function pushAdmin(message) {
  if (!adminClient) return;
  try {
    adminClient.send(message);
  } catch {}
}

async function startAdminSandbox({ codexPath, adminPort }) {
  const token = randomBytes(32).toString("base64url");
  const client = new AdminSandboxClient({
    name: "typed-voice-admin-worker",
    command: process.execPath,
    args: [adminEntry, `--port=${adminPort}`],
    cwd: adminDirectory,
    sandbox: "elevated",
    allowLocalBinding: true,
    codexExecutable: codexPath,
    allowedDirectories: [],
    allowedFiles: [],
    sandboxReadOnlyDirectories: [adminDirectory, webDirectory, workerDirectory, engineDirectory],
    processTracker: processWatchdog,
  }, {
    onDisconnect(connectionId) {
      controlServer?.disconnect(connectionId);
    },
    onSnapshotRequest() {
      client.send({ type: "snapshot", state: adminSnapshot(), pairing: pairingPayload });
    },
    onHistoryGet(requestId, conversationId) {
      void (async () => {
        try {
          const content = await historyStore.getContent(conversationId, { limit: 5000 });
          client.send({ type: "history-response", requestId, conversationId, ok: true, ...content });
        } catch (error) {
          client.send({
            type: "history-response",
            requestId,
            conversationId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    },
    onHistorySubscribe(conversationId) {
      historySubscriptions.set(conversationId, (historySubscriptions.get(conversationId) ?? 0) + 1);
    },
    onHistoryUnsubscribe(conversationId) {
      const next = (historySubscriptions.get(conversationId) ?? 0) - 1;
      if (next > 0) historySubscriptions.set(conversationId, next);
      else historySubscriptions.delete(conversationId);
    },
    onDebugEval(requestId, slot, expression) {
      void Promise.resolve().then(() => {
        if (!pool) throw new Error("Chrome engine pool is not ready");
        return pool.debugEvaluate(Number(slot), expression);
      }).then((result) => {
        client.send({ type: "debug-response", requestId, ok: true, slot: Number(slot), result });
      }).catch((error) => {
        client.send({
          type: "debug-response",
          requestId,
          ok: false,
          slot: Number(slot),
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    onModelSet(requestId, modelProfile) {
      void setServerModelProfile(modelProfile).then(() => {
        client.send({ type: "model-response", requestId, ok: true, modelProfile });
      }).catch((error) => {
        client.send({
          type: "model-response",
          requestId,
          ok: false,
          modelProfile,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    onStderr: (chunk) => process.stderr.write(`[admin-worker] ${chunk}`),
    onExit: (code, signal) => updateState({ adminWorker: `停止 (${signal ?? code ?? "unknown"})` }),
    onFailure: (error) => updateState({ adminWorker: `失敗: ${error.message}` }),
  });
  let port;
  try {
    port = await client.start();
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  if (port !== adminPort) throw new Error(`admin worker listened on unexpected port ${port}`);
  client.send({ type: "init", token, state: adminSnapshot(), pairing: pairingPayload });
  updateState({ adminWorker: `起動済み 127.0.0.1:${port}` });
  return { client, url: `http://127.0.0.1:${port}/`, token };
}

async function startAdminSandboxWithStablePort({ codexPath }) {
  let adminPort = settingsStore.adminPort;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!adminPort) {
      adminPort = randomInt(49152, 65536);
      await settingsStore.setAdminPort(adminPort);
    }
    try {
      return await startAdminSandbox({ codexPath, adminPort });
    } catch (error) {
      if (error?.code !== "EADDRINUSE" && error?.code !== "EACCES") throw error;
      adminPort = randomInt(49152, 65536);
      await settingsStore.setAdminPort(adminPort);
    }
  }
  throw new Error("no persistent high localhost port was available for the admin/engine origin");
}

function engineUrlForProfile(adminUrl, modelProfile) {
  const url = new URL(parsed.values["engine-url"] || "engine/server-engine.html", adminUrl);
  url.searchParams.set("profile", modelProfile);
  return url;
}

async function setServerModelProfile(modelProfile) {
  const normalized = String(modelProfile ?? "");
  if (!["fp32", "fp16", "mobile-int8", "mobile-int4"].includes(normalized)) throw new Error("unsupported model profile");
  if (state.modelProfile === normalized) {
    await settingsStore?.setModelProfile(normalized);
    return;
  }
  if (!pool || !workerClient || !adminClient) {
    if (pool && state.adminUrl) pool.engineUrl = engineUrlForProfile(state.adminUrl, normalized).href;
    await settingsStore?.setModelProfile(normalized);
    updateState({ modelProfile: normalized, model: `起動時に使用: ${normalized}` });
    return;
  }
  updateState({ model: `切り替え中: ${normalized}` });
  const adminBase = state.adminUrl;
  if (!adminBase) throw new Error("admin URL is unavailable");
  const previous = state.modelProfile;
  await pool.reconfigure(engineUrlForProfile(adminBase, normalized).href);
  try {
    await workerClient.callTool("set_config", { modelProfile: normalized });
  } catch (error) {
    await pool.reconfigure(engineUrlForProfile(adminBase, previous).href).catch(() => {});
    throw error;
  }
  await settingsStore?.setModelProfile(normalized);
  updateState({ modelProfile: normalized, model: `準備済み ${multi}/${multi}` });
}

async function startTunnel({ codexPath, cloudflaredPath, publicPort }) {
  let resolveUrl;
  let rejectUrl;
  const urlPromise = new Promise((resolvePromise, rejectPromise) => {
    resolveUrl = resolvePromise;
    rejectUrl = rejectPromise;
  });
  let output = "";
  const acceptOutput = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-32_768);
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match) resolveUrl(match[0]);
  };
  const processWrapper = new CodexSandboxProcess({
    name: "typed-voice-cloudflared",
    command: cloudflaredPath,
    args: ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${publicPort}`],
    cwd: dirname(cloudflaredPath),
    sandbox: "onlineworkspace",
    codexExecutable: codexPath,
    allowedDirectories: [],
    allowedFiles: [],
    sandboxReadOnlyDirectories: [],
    isBundled: false,
    processTracker: processWatchdog,
  }, {
    onStdout: acceptOutput,
    onStderr: acceptOutput,
    onExit: (code, signal) => {
      updateState({ tunnel: `停止 (${signal ?? code ?? "unknown"})` });
      rejectUrl(new Error(`cloudflared exited before publishing the tunnel (${signal ?? code ?? "unknown"})`));
    },
    onFailure: (error) => {
      updateState({ tunnel: `失敗: ${error.message}` });
      rejectUrl(error);
    },
  });
  await processWrapper.start();
  const timeout = setTimeout(() => rejectUrl(new Error("cloudflared did not publish a Quick Tunnel URL within 30 seconds")), 30_000);
  try {
    const httpsUrl = await urlPromise;
    return { process: processWrapper, httpsUrl };
  } finally { clearTimeout(timeout); }
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  updateState({ overall: "停止中" });
  await tunnelProcess?.close().catch(() => {});
  tunnelProcess = null;
  if (workerClient) await workerClient.callTool("stop", {}).catch(() => {});
  await workerClient?.close().catch(() => {});
  workerClient = null;
  await controlServer?.close().catch(() => {});
  controlServer = null;
  await pool?.close().catch(() => {});
  pool = null;
  await historyStore?.flush().catch(() => {});
  historyStore = null;
  await removeEncryptedPairingFile(pairingFilePath);
  pairingFileResolvedPath = null;
  historySubscriptions.clear();
  await adminClient?.close().catch(() => {});
  adminClient = null;
  await processWatchdog.close().catch(() => {});
  process.exitCode = exitCode;
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

try {
  await processWatchdog.start();
  const [chromePath, codexPath, cloudflaredPath] = await Promise.all([
    findChrome(parsed.values.chrome),
    Promise.resolve(findOnPath(parsed.values.codex, ["codex.cmd", "codex.exe", "codex"], "Codex")),
    Promise.resolve(findOnPath(parsed.values.cloudflared, ["cloudflared.exe", "cloudflared"], "cloudflared")),
  ]);
  await removeEncryptedPairingFile(pairingFilePath);
  settingsStore = await new ServerSettingsStore(settingsPath).open();
  state.modelProfile = requestedProfile ?? settingsStore.modelProfile;
  if (requestedProfile) await settingsStore.setModelProfile(requestedProfile);
  historyStore = await new HistoryStore(historyDirectory).open();
  const admin = await startAdminSandboxWithStablePort({ codexPath });
  adminClient = admin.client;
  state.adminUrl = admin.url;
  const adminFullUrl = `${admin.url}#${admin.token}`;
  consoleLine(ANSI.cyan, "[admin]", adminFullUrl);
  openUi(chromePath, admin);

  const engineBaseUrl = engineUrlForProfile(admin.url, state.modelProfile);

  const controlKey = randomBytes(32);
  const authKey = randomBytes(32);
  const encryptionKey = randomBytes(32);

  pool = new ChromeEnginePool({
    count: multi,
    chromePath,
    engineUrl: engineBaseUrl.href,
    profileDir: chromeProfileDirectory,
    onState: updateState,
    onDiagnostic({ index, message }) {
      process.stderr.write(`[engine:${index}] ${String(message).replace(/[\r\n]+/g, " ")}\n`);
    },
    processTracker: processWatchdog,
  });
  controlServer = new WorkerControlServer({
    key: controlKey,
    pool,
    onHistory: recordHistory,
    onState: updateState,
    onWorkerStatus(workerStatus) {
      updateState({
        clients: Number(workerStatus?.authenticatedClients || 0),
        sessions: Array.isArray(workerStatus?.sessions) ? workerStatus.sessions : [],
      });
    },
  });
  const controlPort = await controlServer.start();
  updateState({ control: `待機中 127.0.0.1:${controlPort}` });
  consoleLine(ANSI.dim, "[control]", `127.0.0.1:${controlPort}`);

  workerClient = new SandboxedMcpClient({
    name: "typed-voice-websocket-worker",
    command: process.execPath,
    args: [workerEntry],
    cwd: workerDirectory,
    sandbox: "elevated",
    allowLocalBinding: true,
    codexExecutable: codexPath,
    allowedDirectories: [],
    allowedFiles: [],
    sandboxReadOnlyDirectories: [workerDirectory],
    isBundled: false,
    processTracker: processWatchdog,
  }, {
    onStderr: (chunk) => process.stderr.write(`[worker] ${chunk}`),
    onExit: (code, signal) => updateState({ publicWorker: `停止 (${signal ?? code ?? "unknown"})` }),
    onFailure: (error) => updateState({ publicWorker: `失敗: ${error.message}` }),
  });
  await workerClient.start();
  const workerStatus = await workerClient.callTool("start", {
    controlPort,
    controlKey: controlKey.toString("base64url"),
    authKey: authKey.toString("base64url"),
    encryptionKey: encryptionKey.toString("base64url"),
    modelProfile: state.modelProfile,
  });
  if (!workerStatus?.running || !workerStatus.publicPort) throw new Error("sandbox worker did not start its public listener");
  updateState({ publicWorker: `起動済み 127.0.0.1:${workerStatus.publicPort}` });
  consoleLine(ANSI.magenta, "[public-worker]", `127.0.0.1:${workerStatus.publicPort}`);

  await pool.start();
  for (const slot of pool.status().engines) {
    consoleLine(ANSI.cyan, `[engine:${slot.index}]`, `${slot.info?.profile ?? state.modelProfile} / ${slot.info?.backend ?? "ready"}`);
  }

  updateState({ tunnel: "起動中" });
  const tunnel = await startTunnel({ codexPath, cloudflaredPath, publicPort: workerStatus.publicPort });
  tunnelProcess = tunnel.process;
  const publicUrl = new URL(tunnel.httpsUrl);
  publicUrl.protocol = "wss:";
  publicUrl.pathname = "/remote";
  publicUrl.search = "";
  publicUrl.hash = "";
  const pairing = buildPairing(publicUrl.href, authKey, encryptionKey);
  pairingPayload = pairing;
  pairingFileResolvedPath = await writeEncryptedPairingFile(pairingFilePath, pairing, { randomBytes });
  updateState({
    overall: "疎通確認中",
    tunnel: "暗号化通信を確認中",
    pairingEndpoint: publicUrl.hostname,
    pairingReady: false,
  });
  pushAdmin({ type: "pairing", pairing });
  consoleLine(ANSI.yellow, "[tunnel]", publicUrl.href);
  await probeAdminWebSocket({ adminUrl: admin.url, token: admin.token });
  await probeRemoteEndpoint({
    endpoint: publicUrl.href,
    authKey,
    encryptionKey,
    expectedModelProfile: state.modelProfile,
  });
  updateState({
    overall: "接続できます",
    tunnel: "接続済み・暗号化疎通確認済み",
    pairingReady: true,
  });
  consoleLine(ANSI.green, "[ready]", "admin/public worker/Chrome WebMCP/model/Quick Tunnel/AES-GCM synthesis probe PASS");
  consoleLine(ANSI.green, "[admin URL]", adminFullUrl);
  consoleLine(ANSI.green, "[WSS URL]", publicUrl.href);
  consoleLine(ANSI.green, "[pairing file]", pairingFileResolvedPath);
} catch (error) {
  updateState({ overall: "起動失敗" });
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  await shutdown(1);
}

