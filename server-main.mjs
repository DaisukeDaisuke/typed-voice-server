import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { BrowserWorkerPool } from "./server/engine-pool.mjs";
import { HistoryStore } from "./server/history-store.mjs";
import { OrchestratorHttpServer } from "./server/orchestrator-http.mjs";
import { encodeEncryptedPairingText, writeEncryptedPairingFile, removeEncryptedPairingFile } from "./server/pairing-file.mjs";
import { QuickTunnelProcess } from "./server/quick-tunnel.mjs";
import { RemoteClientHub } from "./server/remote-hub.mjs";
import { ServerSettingsStore } from "./server/settings-store.mjs";
import {
  currentWorkerAccessToken,
  millisecondsUntilWorkerTokenRotation,
  verifyWorkerAccessToken,
} from "./server/worker-access-token.mjs";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const webDirectory = join(projectRoot, "web");
const engineDirectory = join(projectRoot, "engine");
const historyDirectory = join(projectRoot, "data", "history");
const settingsPath = join(projectRoot, "data", "settings.json");
const adminSessionTokenPath = join(projectRoot, "data", "admin", "session-token.txt");
const workerSessionTokenPath = join(projectRoot, "data", "worker", "session-token.txt");
const workerResetTokenPath = join(projectRoot, "data", "worker", "reset-token.txt");
const serverPortPath = join(projectRoot, "data", "server", "listen-port.txt");
const pairingFilePath = join(projectRoot, "data", "pairing", "typed-voice-server.tvrkey");

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "0" },
    profile: { type: "string" },
    "public-origin": { type: "string" },
    "no-quick-tunnel": { type: "boolean", default: false },
    cloudflared: { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

const host = String(parsed.values.host);
const port = Number(parsed.values.port);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("--port must be 0..65535");
let listenPort = null;
const requestedProfile = parsed.values.profile === undefined ? null : String(parsed.values.profile);
if (requestedProfile !== null && !["fp32", "fp16", "mobile-int8", "mobile-int4"].includes(requestedProfile)) throw new Error("--profile is not supported");

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

function terminalHyperlink(url, label = url) {
  const target = String(url);
  const text = String(label);
  if (!process.stdout.isTTY || process.env.TERM === "dumb") return target;
  return `\x1b]8;;${target}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function browserOrigin() {
  if (acceptedPublicOrigin) return `${acceptedPublicOrigin}/`;
  const configured = parsed.values["public-origin"];
  if (configured) {
    const url = new URL(String(configured));
    url.pathname = "/";
    url.search = "";
    url.hash = "";
    return url.href;
  }
  if (!Number.isSafeInteger(listenPort) || listenPort < 1) return null;
  const browserHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const normalizedHost = browserHost.includes(":") && !browserHost.startsWith("[") ? `[${browserHost}]` : browserHost;
  return `http://${normalizedHost}:${listenPort}/`;
}

function loginUrl(pathname, token) {
  const origin = browserOrigin();
  if (!origin) return null;
  const url = new URL(pathname, origin);
  url.hash = String(token);
  return url.href;
}

function printWorkerLoginUrl(token) {
  const url = loginUrl("worker/login", token);
  if (!url) return;
  consoleLine(ANSI.cyan, "[worker login]", terminalHyperlink(url, url));
}

function printAdminLoginUrl() {
  const url = loginUrl("admin/login", adminSessionToken);
  if (!url) return;
  consoleLine(ANSI.magenta, "[admin login]", terminalHyperlink(url, url));
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

async function writeSessionToken(path, token) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => {});
  return realpath(path);
}

async function writeRawSecretToken(path, token) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, token, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600).catch(() => {});
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => {});
  return realpath(path);
}

async function removeSessionToken(path) {
  await rm(path, { force: true }).catch(() => {});
  await rm(`${path}.tmp`, { force: true }).catch(() => {});
}

function createAdminSessionToken() {
  return createHash("sha256").update(randomBytes(32)).digest("hex");
}

const state = {
  overall: "準備中",
  tunnel: "公開URL待機中",
  engine: "Worker待機中",
  model: "待機中",
  clients: 0,
  runningJobs: 0,
  queuedJobs: 0,
  engineSlots: [],
  sessions: [],
  pairingEndpoint: null,
  pairingReady: false,
  modelProfile: requestedProfile ?? "fp16",
  clientBans: [],
};

let pairingPayload = null;
let pairingFileResolvedPath = null;
let adminSessionTokenResolvedPath = null;
let workerSessionTokenResolvedPath = null;
let workerResetTokenResolvedPath = null;
let workerTokenTimer = null;
let workerResetPromise = null;
let settingsStore = null;
let historyStore = null;
let workerPool = null;
let remoteHub = null;
let httpServer = null;
let quickTunnel = null;
let shuttingDown = false;
let acceptedPublicOrigin = null;
const historySubscriptions = new Map();
const authKey = randomBytes(32);
const encryptionKey = randomBytes(32);
const adminSessionToken = createAdminSessionToken();
const workerResetToken = randomBytes(64).toString("hex");
let workerAccessSecret = randomBytes(64);

function adminSnapshot() {
  const poolStatus = workerPool?.status();
  return {
    ...state,
    runningJobs: Number(poolStatus?.running || 0),
    queuedJobs: Number(poolStatus?.queued || 0),
    engineSlots: Array.isArray(poolStatus?.engines) ? poolStatus.engines : state.engineSlots,
  };
}

function updateState(partial) {
  Object.assign(state, partial);
  httpServer?.broadcastState();
}

function recordHistory(entry) {
  void persistHistoryEvent(entry).catch((error) => {
    process.stderr.write(`[history] ${error instanceof Error ? error.message : String(error)}\n`);
  });
}

function scheduleWorkerTokenRefresh(delayMs) {
  clearTimeout(workerTokenTimer);
  workerTokenTimer = setTimeout(() => {
    void refreshWorkerSessionToken().catch((error) => {
      process.stderr.write(`[worker-token] ${error instanceof Error ? error.message : String(error)}\n`);
      if (!shuttingDown) scheduleWorkerTokenRefresh(1000);
    });
  }, delayMs);
  workerTokenTimer.unref?.();
}

async function refreshWorkerSessionToken() {
  const current = currentWorkerAccessToken(workerAccessSecret);
  workerSessionTokenResolvedPath = await writeSessionToken(workerSessionTokenPath, current.token);
  consoleLine(ANSI.yellow, "[worker session token file]", workerSessionTokenResolvedPath);
  consoleLine(ANSI.dim, "[worker token expires]", new Date(current.expiresAt).toISOString());
  printWorkerLoginUrl(current.token);
  if (shuttingDown) return;
  scheduleWorkerTokenRefresh(millisecondsUntilWorkerTokenRotation() + 25);
}

async function resetWorkerAccess() {
  if (workerResetPromise) return workerResetPromise;
  workerResetPromise = (async () => {
    const nextSecret = randomBytes(64);
    const current = currentWorkerAccessToken(nextSecret);
    const resolvedPath = await writeSessionToken(workerSessionTokenPath, current.token);
    workerAccessSecret = nextSecret;
    workerSessionTokenResolvedPath = resolvedPath;
    clearTimeout(workerTokenTimer);
    workerTokenTimer = null;
    workerPool?.disconnectAll(1008);
    consoleLine(ANSI.yellow, "[worker access reset]", new Date().toISOString());
    consoleLine(ANSI.yellow, "[worker session token file]", workerSessionTokenResolvedPath);
    consoleLine(ANSI.dim, "[worker token expires]", new Date(current.expiresAt).toISOString());
    printWorkerLoginUrl(current.token);
    if (!shuttingDown) scheduleWorkerTokenRefresh(millisecondsUntilWorkerTokenRotation() + 25);
  })();
  try {
    await workerResetPromise;
  } finally {
    workerResetPromise = null;
  }
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
    httpServer?.sendHistoryEvent(entry.conversationId, event, historyStore.getMetadata(entry.conversationId));
  }
}

async function setServerModelProfile(modelProfile) {
  const normalized = String(modelProfile ?? "");
  if (!["fp32", "fp16", "mobile-int8", "mobile-int4"].includes(normalized)) throw new Error("unsupported model profile");
  if (state.modelProfile === normalized) {
    await settingsStore?.setModelProfile(normalized);
    return;
  }
  await workerPool.reconfigure(normalized);
  remoteHub.setModelProfile(normalized);
  await settingsStore?.setModelProfile(normalized);
  updateState({ modelProfile: normalized, model: `選択: ${normalized}` });
}

async function setClientBan(clientHash, banned) {
  const normalized = String(clientHash ?? "").toLowerCase();
  await settingsStore.setClientBanned(normalized, Boolean(banned));
  if (banned) remoteHub.disconnectClientHash(normalized);
  updateState({ clientBans: settingsStore.clientBans });
  return { clientHash: normalized, banned: Boolean(banned) };
}

async function setPublicOrigin(value) {
  const url = new URL(String(value));
  if (url.protocol !== "https:") throw new Error("public origin must use https");
  if (url.username || url.password) throw new Error("public origin must not contain credentials");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  acceptedPublicOrigin = url.origin;
  const publicUrl = new URL("remote", url);
  publicUrl.protocol = "wss:";
  if (pairingPayload?.u === publicUrl.href) return pairingPayload;
  const pairing = buildPairing(publicUrl.href, authKey, encryptionKey);
  const pairingQr = encodeEncryptedPairingText(pairing, randomBytes(12));
  const resolvedPairingFilePath = await writeEncryptedPairingFile(pairingFilePath, pairing, { randomBytes });
  pairingPayload = { ...pairing, q: pairingQr };
  pairingFileResolvedPath = resolvedPairingFilePath;
  updateState({
    overall: workerPool.status().engines.some((worker) => worker.info?.ready) ? "接続できます" : "Worker待機中",
    tunnel: `公開: ${url.hostname}`,
    pairingEndpoint: publicUrl.hostname,
    pairingReady: true,
  });
  httpServer?.broadcastPairing();
  consoleLine(ANSI.yellow, "[public WSS]", publicUrl.href);
  consoleLine(ANSI.green, "[pairing file]", pairingFileResolvedPath);
  printAdminLoginUrl();
  printWorkerLoginUrl(currentWorkerAccessToken(workerAccessSecret).token);
  return pairingPayload;
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  updateState({ overall: "停止中" });
  await quickTunnel?.stop().catch(() => {});
  quickTunnel = null;
  await remoteHub?.close().catch(() => {});
  remoteHub = null;
  await workerPool?.close().catch(() => {});
  workerPool = null;
  await httpServer?.close().catch(() => {});
  httpServer = null;
  await historyStore?.flush().catch(() => {});
  historyStore = null;
  historySubscriptions.clear();
  await removeEncryptedPairingFile(pairingFilePath);
  pairingFileResolvedPath = null;
  await removeSessionToken(adminSessionTokenPath);
  adminSessionTokenResolvedPath = null;
  clearTimeout(workerTokenTimer);
  workerTokenTimer = null;
  await removeSessionToken(workerSessionTokenPath);
  workerSessionTokenResolvedPath = null;
  await removeSessionToken(workerResetTokenPath);
  workerResetTokenResolvedPath = null;
  await removeSessionToken(serverPortPath);
  process.exitCode = exitCode;
}

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

try {
  await removeEncryptedPairingFile(pairingFilePath);
  await removeSessionToken(adminSessionTokenPath);
  await removeSessionToken(workerSessionTokenPath);
  await removeSessionToken(workerResetTokenPath);
  await removeSessionToken(serverPortPath);
  settingsStore = await new ServerSettingsStore(settingsPath).open();
  state.modelProfile = requestedProfile ?? settingsStore.modelProfile;
  state.clientBans = settingsStore.clientBans;
  if (requestedProfile) await settingsStore.setModelProfile(requestedProfile);
  historyStore = await new HistoryStore(historyDirectory).open();
  adminSessionTokenResolvedPath = await writeSessionToken(adminSessionTokenPath, adminSessionToken);
  workerResetTokenResolvedPath = await writeRawSecretToken(workerResetTokenPath, workerResetToken);
  await refreshWorkerSessionToken();

  workerPool = new BrowserWorkerPool({
    profile: state.modelProfile,
    onState(partial) {
      updateState(partial);
      remoteHub?.broadcastWorkerStatus();
      const hasReadyWorker = workerPool.status().engines.some((worker) => worker.info?.ready);
      if (hasReadyWorker && state.pairingReady) updateState({ overall: "接続できます" });
      else if (hasReadyWorker) updateState({ overall: "公開URL待機中" });
      else updateState({ overall: "Worker待機中" });
    },
    onDiagnostic({ index, message }) {
      process.stderr.write(`[worker:${index}] ${String(message).replace(/[\r\n]+/g, " ")}\n`);
    },
  });

  remoteHub = new RemoteClientHub({
    pool: workerPool,
    authKey,
    encryptionKey,
    modelProfile: state.modelProfile,
    clientBanSalt: Buffer.from(settingsStore.clientBanSalt, "base64url"),
    isClientBanned(clientHash) {
      return settingsStore.isClientBanned(clientHash);
    },
    onStatus(status) {
      updateState({
        clients: Number(status.authenticatedClients || 0),
        sessions: Array.isArray(status.sessions) ? status.sessions : [],
      });
    },
    onHistory: recordHistory,
  });

  httpServer = new OrchestratorHttpServer({
    host,
    port,
    sessionToken: adminSessionToken,
    webRoot: webDirectory,
    engineRoot: engineDirectory,
    workerPool,
    remoteHub,
    stateProvider: adminSnapshot,
    pairingProvider: () => pairingPayload,
    onDisconnect(connectionId) {
      remoteHub.disconnect(connectionId);
    },
    onHistoryGet(conversationId) {
      return historyStore.getContent(conversationId, { limit: 5000 });
    },
    onHistorySubscribe(conversationId) {
      historySubscriptions.set(conversationId, (historySubscriptions.get(conversationId) ?? 0) + 1);
    },
    onHistoryUnsubscribe(conversationId) {
      const next = (historySubscriptions.get(conversationId) ?? 0) - 1;
      if (next > 0) historySubscriptions.set(conversationId, next);
      else historySubscriptions.delete(conversationId);
    },
    onModelSet: setServerModelProfile,
    onClientBanSet: setClientBan,
    onPublicOrigin: setPublicOrigin,
    onDiagnostic(message) {
      process.stderr.write(`[http] ${String(message).replace(/[\r\n]+/g, " ")}\n`);
    },
    publicOriginProvider() {
      return acceptedPublicOrigin;
    },
    workerResetToken,
    onWorkerReset: resetWorkerAccess,
    workerTokenValidator(token) {
      return verifyWorkerAccessToken(workerAccessSecret, token);
    },
  });
  const address = await httpServer.start();
  listenPort = address.port;
  const serverPortResolvedPath = await writeRawSecretToken(serverPortPath, String(address.port));
  updateState({ overall: "Worker待機中", engine: "Worker待機中", model: `選択: ${state.modelProfile}` });

  consoleLine(ANSI.green, "[server]", `${address.address}:${address.port}`);
  consoleLine(ANSI.dim, "[listen port file]", serverPortResolvedPath);
  consoleLine(ANSI.cyan, "[worker]", `/worker/`);
  consoleLine(ANSI.magenta, "[remote]", `/remote`);
  consoleLine(ANSI.yellow, "[admin session token file]", adminSessionTokenResolvedPath);
  consoleLine(ANSI.yellow, "[worker reset token file]", workerResetTokenResolvedPath);
  consoleLine(ANSI.dim, "[worker reset endpoint]", `POST http://127.0.0.1:${address.port}/worker/reset`);
  printAdminLoginUrl();
  printWorkerLoginUrl(currentWorkerAccessToken(workerAccessSecret).token);

  if (parsed.values["public-origin"]) {
    await setPublicOrigin(parsed.values["public-origin"]);
  } else if (!parsed.values["no-quick-tunnel"]) {
    updateState({ tunnel: "Quick Tunnel起動中", overall: "公開URL待機中" });
    quickTunnel = new QuickTunnelProcess({
      localOrigin: `http://127.0.0.1:${address.port}`,
      executable: parsed.values.cloudflared === undefined ? undefined : String(parsed.values.cloudflared),
      onLog({ stream, text }) {
        const normalized = String(text).replace(/\r\n/g, "\n");
        process.stderr.write(`[cloudflared:${stream}] ${normalized}`);
      },
    });
    const quickTunnelOrigin = await quickTunnel.start();
    consoleLine(ANSI.cyan, "[quick tunnel]", quickTunnelOrigin);
    await setPublicOrigin(quickTunnelOrigin);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  await shutdown(1);
}
