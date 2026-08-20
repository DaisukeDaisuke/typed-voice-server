import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { QuickTunnelProcess } from "./server/quick-tunnel.mjs";
import { SandboxWorkerClient } from "./server/sandbox-worker-client.mjs";
import { restrictedNodeArgs } from "./server/node-permission.mjs";
import {
  currentWorkerAccessToken,
  millisecondsUntilWorkerTokenRotation,
} from "./server/worker-access-token.mjs";

function assertSupportedNodeVersion() {
  const [majorText, minorText] = String(process.versions.node ?? "").split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  const supported = (major === 22 && Number.isSafeInteger(minor) && minor >= 13)
    || major === 23
    || major === 24;
  if (!supported) throw new Error(`Node.js 22.13 through 24.x is required; current=${process.versions.node}`);
}

assertSupportedNodeVersion();

const projectRoot = dirname(fileURLToPath(import.meta.url));
const serverDirectory = join(projectRoot, "server");
const workerDirectory = join(projectRoot, "worker");
const adminDirectory = join(projectRoot, "admin");
const webDirectory = join(projectRoot, "web");
const dataDirectory = join(projectRoot, "data");
const WORKER_PAGE_URL = "https://daisukedaisuke.github.io/typed-voice/worker.html";

const storageWorkerPath = join(serverDirectory, "storage-worker.mjs");
const adminWorkerPath = join(adminDirectory, "admin-http-worker.mjs");
const trustedWorkerPath = join(workerDirectory, "trusted-worker-http-worker.mjs");
const remoteWorkerPath = join(workerDirectory, "remote-http-worker.mjs");

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "0" },
    "admin-port": { type: "string", default: "0" },
    "remote-port": { type: "string", default: "0" },
    profile: { type: "string" },
    "public-origin": { type: "string" },
    "worker-public-origin": { type: "string" },
    "admin-public-origin": { type: "string" },
    "open-worker": { type: "string" },
    "open-admin": { type: "string" },
    "no-quick-tunnel": { type: "boolean", default: false },
    cloudflared: { type: "string" },
    codex: { type: "string" },
  },
  strict: true,
  allowPositionals: false,
});

const requestedHost = String(parsed.values.host).toLowerCase();
if (!["127.0.0.1", "localhost", "::1"].includes(requestedHost)) {
  throw new Error("--host is restricted to loopback; public listeners live inside Codex sandboxes");
}

function parsePort(value, label) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error(`${label} must be 0..65535`);
  return port;
}

function parseBooleanOption(value, label, defaultValue = false) {
  if (value === undefined) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${label} must be true or false`);
}

const requestedPorts = Object.freeze({
  worker: parsePort(parsed.values.port, "--port"),
  admin: parsePort(parsed.values["admin-port"], "--admin-port"),
  remote: parsePort(parsed.values["remote-port"], "--remote-port"),
});

const requestedTunnelExposure = Object.freeze({
  worker: parseBooleanOption(parsed.values["open-worker"], "--open-worker", false),
  admin: parseBooleanOption(parsed.values["open-admin"], "--open-admin", false),
  remote: true,
});

const requestedProfile = parsed.values.profile === undefined ? null : String(parsed.values.profile);
if (requestedProfile !== null && !["fp32", "fp16", "mobile-int8", "mobile-int4"].includes(requestedProfile)) {
  throw new Error("--profile is not supported");
}

const linuxDirectTestBackend = process.platform !== "win32"
  && process.env.TYPED_VOICE_LINUX_DIRECT_TEST === "1";

const ANSI = Object.freeze({
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  dim: "\x1b[2m",
});

function consoleLine(color, label, value) {
  process.stdout.write(`${color}${label}${ANSI.reset} ${value}\n`);
}

function safeLogText(value, maxBytes = 16 * 1024) {
  let text = String(value ?? "").replace(/\r\n?/gu, "\n");
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "?");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  return `${bytes.subarray(0, maxBytes).toString("utf8")}…`;
}

function writeSandboxLog(label, value) {
  const text = safeLogText(value);
  const lines = text.split("\n");
  for (const line of lines) {
    if (line) process.stderr.write(`[${label}] ${line}\n`);
  }
}

function terminalHyperlink(url, label = url) {
  const target = String(url);
  const text = String(label);
  if (!process.stdout.isTTY || process.env.TERM === "dumb") return target;
  return `\x1b]8;;${target}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function sandboxFailure(name, error) {
  writeSandboxLog(name, error instanceof Error ? error.stack ?? error.message : String(error));
  if (!shuttingDown) void shutdown(1);
}

function sandboxConfig(name, script, { read = [], write = [], denyRead = [], sandbox = "elevated", fullDiskRead = false } = {}) {
  return {
    name,
    backend: linuxDirectTestBackend ? "direct-test" : "codex",
    command: process.execPath,
    args: restrictedNodeArgs(script, { readRoots: read, writeRoots: write }),
    cwd: dirname(script),
    sandbox,
    fullDiskRead,
    codexExecutable: parsed.values.codex === undefined ? undefined : String(parsed.values.codex),
    allowedDirectories: write,
    sandboxReadOnlyDirectories: read,
    sandboxDeniedDirectories: denyRead,
  };
}

function originCapability(role) {
  return `tv-${role}-${randomBytes(24).toString("hex")}.invalid`;
}

function normalizeHttpsOrigin(value, label) {
  const url = new URL(String(value));
  if (url.protocol !== "https:") throw new Error(`${label} must use https`);
  if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
}

const ports = { admin: null, worker: null, remote: null };
const publicOrigins = { admin: null, worker: null, remote: null };
const capabilityHosts = Object.freeze({
  admin: originCapability("admin"),
  worker: originCapability("worker"),
  remote: originCapability("remote"),
});

function configuredPublicOrigin(role) {
  if (role === "admin") return parsed.values["admin-public-origin"];
  if (role === "worker") return parsed.values["worker-public-origin"];
  if (role === "remote") return parsed.values["public-origin"];
  throw new Error(`unsupported public role: ${role}`);
}

function quickTunnelEnabledFor(role) {
  return !parsed.values["no-quick-tunnel"]
    && configuredPublicOrigin(role) === undefined
    && Boolean(requestedTunnelExposure[role]);
}

function listenerCapabilityHost(role) {
  return quickTunnelEnabledFor(role) ? capabilityHosts[role] : null;
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

let workerStatus = { engines: [], queued: 0, running: 0, profile: state.modelProfile };
let pairingPayload = null;
let pairingFileResolvedPath = null;
let workerSessionTokenResolvedPath = null;

let storageWorker = null;
let adminWorker = null;
let trustedWorker = null;
let remoteWorker = null;
const tunnels = new Map();
const historySubscriptions = new Map();
let workerTokenTimer = null;
let workerResetPromise = null;
let shuttingDown = false;
let shutdownPromise = null;
let serverReady = false;
let shutdownInputBuffer = "";

const authKey = randomBytes(32);
const encryptionKey = randomBytes(32);
const adminSessionToken = randomBytes(32).toString("hex");
const workerResetToken = randomBytes(64).toString("hex");
let workerAccessSecret = randomBytes(64);
let clientBanSalt = null;

function sanitizeDataPath(value) {
  const candidate = String(value ?? "");
  if (!candidate || /[\u0000-\u001f\u007f]/u.test(candidate)) throw new Error("invalid storage path");
  const windows = win32.isAbsolute(dataDirectory) || win32.isAbsolute(candidate);
  const absolute = windows ? win32.isAbsolute(candidate) : isAbsolute(candidate);
  if (!absolute) throw new Error("storage path must be absolute");
  const rel = windows ? win32.relative(dataDirectory, candidate) : relative(dataDirectory, candidate);
  const separator = windows ? win32.sep : sep;
  if (rel === ".." || rel.startsWith(`..${separator}`) || (windows ? win32.isAbsolute(rel) : isAbsolute(rel))) {
    throw new Error("storage path escapes data root");
  }
  return candidate;
}

function validConversationId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(String(value ?? ""));
}

function sanitizeClientBans(value) {
  if (!Array.isArray(value) || value.length > 10000) throw new Error("invalid client ban list");
  const result = [];
  const seen = new Set();
  for (const entry of value) {
    const hash = String(entry ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(hash)) throw new Error("invalid client ban hash");
    if (!seen.has(hash)) {
      seen.add(hash);
      result.push(hash);
    }
  }
  return result;
}

function sanitizeStoredSettings(value) {
  if (!value || typeof value !== "object") throw new Error("invalid stored settings");
  const modelProfile = String(value.modelProfile ?? "");
  if (!["fp32", "fp16", "mobile-int8", "mobile-int4"].includes(modelProfile)) throw new Error("invalid stored model profile");
  const clientBanSalt = String(value.clientBanSalt ?? "");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(clientBanSalt) || Buffer.from(clientBanSalt, "base64url").length !== 32) {
    throw new Error("invalid client ban salt");
  }
  return { modelProfile, clientBanSalt, clientBans: sanitizeClientBans(value.clientBans) };
}

function expectedPairingChecksum(endpoint) {
  return createHash("sha256")
    .update(Buffer.from("typed-voice-remote-qr/v1\n", "utf8"))
    .update(Buffer.from(endpoint, "utf8"))
    .update(Buffer.from([0]))
    .update(authKey)
    .update(encryptionKey)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
}

function sanitizePairing(value, expectedEndpoint) {
  if (!value || typeof value !== "object" || value.v !== 1) throw new Error("invalid pairing payload");
  const endpoint = String(value.u ?? "");
  if (endpoint !== expectedEndpoint) throw new Error("pairing endpoint mismatch");
  const checksum = String(value.c ?? "");
  if (checksum !== expectedPairingChecksum(endpoint)) throw new Error("pairing checksum mismatch");
  const q = String(value.q ?? "");
  if (!/^tvrkey1:[A-Za-z0-9_-]{32,4096}$/u.test(q)) throw new Error("invalid pairing QR payload");
  return { v: 1, u: endpoint, c: checksum, q };
}

function sanitizeWorkerStatus(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.engines) || value.engines.length > 64) {
    throw new Error("invalid worker status");
  }
  const profile = String(value.profile ?? "");
  if (!["fp32", "fp16", "mobile-int8", "mobile-int4"].includes(profile)) throw new Error("invalid worker status profile");
  const running = Number(value.running ?? 0);
  const queued = Number(value.queued ?? 0);
  if (!Number.isSafeInteger(running) || running < 0 || running > 64) throw new Error("invalid running worker count");
  if (!Number.isSafeInteger(queued) || queued < 0 || queued > 100000) throw new Error("invalid queued worker count");
  const engines = value.engines.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("invalid worker status entry");
    const index = Number(entry.index);
    if (!Number.isSafeInteger(index) || index < 0 || index > 63) throw new Error("invalid worker index");
    let info = null;
    if (entry.info != null) {
      if (typeof entry.info !== "object") throw new Error("invalid worker info");
      const infoProfile = String(entry.info.profile ?? profile);
      if (!["fp32", "fp16", "mobile-int8", "mobile-int4"].includes(infoProfile)) throw new Error("invalid worker info profile");
      const sampleRate = entry.info.sampleRate == null ? null : Number(entry.info.sampleRate);
      if (sampleRate !== null && (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000)) throw new Error("invalid worker sample rate");
      info = {
        ready: Boolean(entry.info.ready),
        profile: infoProfile,
        backend: entry.info.backend == null ? null : String(entry.info.backend).slice(0, 128),
        sampleRate,
        error: entry.info.error == null ? null : String(entry.info.error).slice(0, 1024),
      };
    }
    return {
      index,
      busy: Boolean(entry.busy),
      connected: Boolean(entry.connected),
      authenticated: Boolean(entry.authenticated),
      info,
      connectedAt: Number.isSafeInteger(Number(entry.connectedAt)) ? Number(entry.connectedAt) : null,
      lastPongAt: entry.lastPongAt == null ? null : (Number.isSafeInteger(Number(entry.lastPongAt)) ? Number(entry.lastPongAt) : null),
    };
  });
  return { engines, running, queued, profile };
}

function sanitizeRemoteStatus(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.sessions) || value.sessions.length > 256) {
    throw new Error("invalid remote status");
  }
  const authenticatedClients = Number(value.authenticatedClients ?? 0);
  if (!Number.isSafeInteger(authenticatedClients) || authenticatedClients < 0 || authenticatedClients > 256) throw new Error("invalid remote client count");
  const sessions = value.sessions.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("invalid remote session");
    const connectionId = String(entry.connectionId ?? "").toLowerCase();
    if (!/^[0-9a-f]{16}$/u.test(connectionId)) throw new Error("invalid remote connection id");
    const conversationId = entry.conversationId == null ? null : String(entry.conversationId);
    if (conversationId !== null && !validConversationId(conversationId)) throw new Error("invalid remote conversation id");
    const clientHash = String(entry.clientHash ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(clientHash)) throw new Error("invalid remote client hash");
    return {
      connectionId,
      conversationId,
      connectedAt: Number.isSafeInteger(Number(entry.connectedAt)) ? Number(entry.connectedAt) : null,
      lastSeenAt: Number.isSafeInteger(Number(entry.lastSeenAt)) ? Number(entry.lastSeenAt) : null,
      requests: Math.max(0, Math.min(1000000, Number(entry.requests) || 0)),
      pending: Math.max(0, Math.min(100000, Number(entry.pending) || 0)),
      clientHash,
    };
  });
  return { authenticatedClients, sessions };
}

function adminSnapshot() {
  return {
    ...state,
    runningJobs: Number(workerStatus.running || 0),
    queuedJobs: Number(workerStatus.queued || 0),
    engineSlots: Array.isArray(workerStatus.engines) ? workerStatus.engines : state.engineSlots,
  };
}

function localOrigin(role) {
  const port = ports[role];
  return Number.isSafeInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : null;
}

function browserOrigin(role) {
  return publicOrigins[role] ?? localOrigin(role);
}

function loginUrl(role, pathname, token) {
  const origin = browserOrigin(role);
  if (!origin) return null;
  const url = new URL(pathname, `${origin}/`);
  url.hash = String(token);
  return url.href;
}

function roleUrl(role, pathname) {
  const origin = browserOrigin(role);
  return origin ? new URL(pathname, `${origin}/`).href : null;
}

function readyTreeLine(branch, color, label, value) {
  process.stdout.write(`${color}${branch}${ANSI.reset} ${ANSI.bold}${color}${label}${ANSI.reset}: ${color}${value}${ANSI.reset}\n`);
}

function readyUrl(role, url) {
  if (!url) return null;
  const disabled = !publicOrigins[role]
    && !quickTunnelEnabledFor(role)
    && configuredPublicOrigin(role) === undefined;
  const suffix = disabled ? ` ${ANSI.yellow}(tunnel disabled)${ANSI.reset}` : "";
  return `${terminalHyperlink(url, url)}${suffix}`;
}

function printReadyTree() {
  if (!serverReady || shuttingDown) return;
  const workerToken = currentWorkerAccessToken(workerAccessSecret).token;
  const workerUrl = loginUrl("worker", "worker/login", workerToken);
  const workerLogin = roleUrl("worker", "worker/login");
  const remoteUrl = browserOrigin("remote");
  const adminUrl = loginUrl("admin", "admin/login", adminSessionToken);
  const publicWss = pairingPayload?.u ? String(pairingPayload.u) : null;
  const rows = [
    [ANSI.cyan, "Worker URL", readyUrl("worker", workerUrl)],
    [ANSI.green, "Remote URL", readyUrl("remote", remoteUrl)],
    [ANSI.green, "Public WSS", publicWss ? terminalHyperlink(publicWss, publicWss) : null],
    [ANSI.magenta, "Admin URL", readyUrl("admin", adminUrl)],
    [ANSI.cyan, "Worker Login", readyUrl("worker", workerLogin)],
    [ANSI.yellow, "worker session token file", workerSessionTokenResolvedPath],
    [ANSI.yellow, "Remote Login Key", pairingFileResolvedPath],
    ...(process.stdin.isTTY ? [[ANSI.yellow, "Shutdown", "type anything + Enter (recommended), or Ctrl+C"]] : []),
  ].filter(([, , value]) => value);
  process.stdout.write(`\n${ANSI.bold}${ANSI.green}server is ready!${ANSI.reset}\n`);
  rows.forEach(([color, label, value], index) => {
    readyTreeLine(index === rows.length - 1 ? "└──" : "├──", color, label, value);
  });
}

function pushAdminState() {
  if (!adminWorker || shuttingDown) return;
  void adminWorker.request("set-state", { state: adminSnapshot() }).catch((error) => sandboxFailure("admin-stdio", error));
}

function updateState(partial) {
  Object.assign(state, partial);
  pushAdminState();
}

function recomputeOverall() {
  const workers = Array.isArray(workerStatus.engines) ? workerStatus.engines : [];
  const hasReadyWorker = workers.some((worker) => worker?.connected && worker?.info?.ready);
  if (!hasReadyWorker) updateState({ overall: "Worker待機中" });
  else if (!state.pairingReady) updateState({ overall: "公開URL待機中" });
  else updateState({ overall: "接続できます" });
}

function scheduleWorkerTokenRefresh(delayMs) {
  clearTimeout(workerTokenTimer);
  workerTokenTimer = setTimeout(() => {
    void refreshWorkerSessionToken().catch((error) => sandboxFailure("worker-token", error));
  }, delayMs);
  workerTokenTimer.unref?.();
}

async function refreshWorkerSessionToken() {
  const current = currentWorkerAccessToken(workerAccessSecret);
  workerSessionTokenResolvedPath = sanitizeDataPath(await storageWorker.request("write-worker-token", { token: current.token }));
  printReadyTree();
  if (!shuttingDown) scheduleWorkerTokenRefresh(millisecondsUntilWorkerTokenRotation() + 25);
}

async function resetWorkerAccess() {
  if (workerResetPromise) return workerResetPromise;
  workerResetPromise = (async () => {
    const nextSecret = randomBytes(64);
    const current = currentWorkerAccessToken(nextSecret);
    const resolvedPath = sanitizeDataPath(await storageWorker.request("write-worker-token", { token: current.token }));
    workerAccessSecret = nextSecret;
    workerSessionTokenResolvedPath = resolvedPath;
    clearTimeout(workerTokenTimer);
    workerTokenTimer = null;
    consoleLine(ANSI.yellow, "[worker access reset]", new Date().toISOString());
    printReadyTree();
    if (!shuttingDown) scheduleWorkerTokenRefresh(millisecondsUntilWorkerTokenRotation() + 25);
    return { workerAccessSecret: nextSecret.toString("base64url") };
  })();
  try {
    return await workerResetPromise;
  } finally {
    workerResetPromise = null;
  }
}

async function persistHistory(entry) {
  if (!entry?.conversationId) return;
  const stored = await storageWorker.request("history-record", { entry });
  if ((historySubscriptions.get(entry.conversationId) ?? 0) > 0 && adminWorker) {
    await adminWorker.request("history-event", {
      conversationId: entry.conversationId,
      event: stored.event,
      metadata: stored.metadata,
    });
  }
}

async function setServerModelProfile(modelProfile) {
  const normalized = String(modelProfile ?? "");
  if (!["fp32", "fp16", "mobile-int8", "mobile-int4"].includes(normalized)) throw new Error("unsupported model profile");
  if (state.modelProfile !== normalized) {
    workerStatus = sanitizeWorkerStatus(await trustedWorker.request("set-profile", { modelProfile: normalized }));
    await remoteWorker.request("set-model", { modelProfile: normalized });
  }
  await storageWorker.request("set-model", { modelProfile: normalized });
  updateState({
    modelProfile: normalized,
    model: `選択: ${normalized}`,
    runningJobs: Number(workerStatus.running || 0),
    queuedJobs: Number(workerStatus.queued || 0),
    engineSlots: Array.isArray(workerStatus.engines) ? workerStatus.engines : [],
  });
}

async function setClientBan(clientHash, banned) {
  const result = await storageWorker.request("set-client-ban", { clientHash, banned: Boolean(banned) });
  const resultHash = String(result?.clientHash ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(resultHash) || resultHash !== String(clientHash ?? "").toLowerCase()) throw new Error("storage client ban response mismatch");
  state.clientBans = sanitizeClientBans(result.clientBans);
  await remoteWorker.request("set-client-bans", { clientBans: state.clientBans });
  updateState({ clientBans: state.clientBans });
  return { clientHash: resultHash, banned: Boolean(result.banned) };
}

async function setRolePublicOrigin(role, value) {
  const origin = normalizeHttpsOrigin(value, `${role} public origin`);
  publicOrigins[role] = origin;
  if (role === "admin") {
    await adminWorker.request("set-public-origin", { origin });
  } else if (role === "worker") {
    await trustedWorker.request("set-public-origin", { origin });
  } else if (role === "remote") {
    const publicUrl = new URL("remote", `${origin}/`);
    publicUrl.protocol = "wss:";
    const stored = await storageWorker.request("write-pairing", {
      endpoint: publicUrl.href,
      authKey: authKey.toString("base64url"),
      encryptionKey: encryptionKey.toString("base64url"),
    });
    pairingPayload = sanitizePairing(stored.pairing, publicUrl.href);
    pairingFileResolvedPath = sanitizeDataPath(stored.path);
    if (trustedWorker) await trustedWorker.request("set-worker-server-url", { url: publicUrl.href });
    updateState({
      pairingReady: true,
      pairingEndpoint: publicUrl.hostname,
    });
    if (adminWorker) await adminWorker.request("set-pairing", { pairing: pairingPayload });
  }
  const readyOrigins = Object.entries(publicOrigins)
    .filter(([, item]) => item)
    .map(([name, item]) => `${name}=${new URL(item).hostname}`)
    .join(" ");
  updateState({ tunnel: readyOrigins ? `公開: ${readyOrigins}` : "公開URL待機中" });
  recomputeOverall();
  return origin;
}

async function startTunnel(role) {
  const origin = localOrigin(role);
  if (!origin) throw new Error(`${role} listener is not ready`);
  const tunnel = new QuickTunnelProcess({
    localOrigin: origin,
    originHostHeader: listenerCapabilityHost(role),
    executable: parsed.values.cloudflared === undefined ? undefined : String(parsed.values.cloudflared),
    onLog({ stream, text }) {
      writeSandboxLog(`cloudflared:${role}:${stream}`, text);
    },
  });
  tunnels.set(role, tunnel);
  const publicOrigin = await tunnel.start();
  return setRolePublicOrigin(role, publicOrigin);
}

async function startStorageWorker() {
  storageWorker = new SandboxWorkerClient(sandboxConfig("storage-worker", storageWorkerPath, {
    read: [serverDirectory],
    write: [dataDirectory],
    sandbox: "elevated",
  }), {
    onStderr: (chunk) => writeSandboxLog("storage", chunk),
    onExit: (code, signal) => sandboxFailure("storage", new Error(`exited (${signal ?? code ?? "unknown"})`)),
    onFailure: (error) => sandboxFailure("storage", error),
  });
  await storageWorker.start();
  await storageWorker.request("remove-runtime-files");
  const stored = sanitizeStoredSettings(await storageWorker.request("open"));
  clientBanSalt = stored.clientBanSalt;
  state.modelProfile = requestedProfile ?? stored.modelProfile;
  state.clientBans = stored.clientBans;
  if (requestedProfile) await storageWorker.request("set-model", { modelProfile: requestedProfile });
  sanitizeDataPath(await storageWorker.request("write-admin-token", { token: adminSessionToken }));
  sanitizeDataPath(await storageWorker.request("write-worker-reset-token", { token: workerResetToken }));
  await refreshWorkerSessionToken();
}

async function startTrustedWorker() {
  trustedWorker = new SandboxWorkerClient(sandboxConfig("trusted-worker-http", trustedWorkerPath, {
    read: [workerDirectory, serverDirectory],
    denyRead: [dataDirectory],
  }), {
    onRequest(method) {
      if (method === "worker-reset") return resetWorkerAccess();
      throw new Error(`unsupported trusted-worker parent request: ${method}`);
    },
    onEvent(type, payload) {
      if (type === "worker-proxy-send" || type === "worker-proxy-close") {
        remoteWorker?.event(type, payload);
        return;
      }
      if (type === "worker-state") {
        workerStatus = sanitizeWorkerStatus(payload?.status);
        const ready = workerStatus.engines.filter((worker) => worker.authenticated && worker.connected && worker.info?.ready).length;
        updateState({
          engine: workerStatus.engines.length ? `Trusted Worker ${ready}/${workerStatus.engines.length} 準備済み` : "Trusted Worker待機中",
          model: `選択: ${workerStatus.profile}`,
          runningJobs: Number(workerStatus.running || 0),
          queuedJobs: Number(workerStatus.queued || 0),
          engineSlots: workerStatus.engines,
        });
        remoteWorker?.event("worker-status", { status: workerStatus });
        recomputeOverall();
        return;
      }
      if (["synth-start", "synth-chunk", "synth-end", "synth-error"].includes(type)) {
        remoteWorker?.event(type, payload);
        return;
      }
      if (type === "diagnostic") writeSandboxLog("worker-http", payload?.message);
    },
    onStderr: (chunk) => writeSandboxLog("worker-http", chunk),
    onExit: (code, signal) => sandboxFailure("worker-http", new Error(`exited (${signal ?? code ?? "unknown"})`)),
    onFailure: (error) => sandboxFailure("worker-http", error),
  });
  await trustedWorker.start();
  const started = await trustedWorker.request("start", {
    port: requestedPorts.worker,
    originCapabilityHost: listenerCapabilityHost("worker"),
    modelProfile: state.modelProfile,
    workerAccessSecret: workerAccessSecret.toString("base64url"),
    workerResetToken,
    workerPageUrl: WORKER_PAGE_URL,
  });
  ports.worker = Number(started?.address?.port);
  workerStatus = sanitizeWorkerStatus(started?.status);
  sanitizeDataPath(await storageWorker.request("write-worker-port", { port: ports.worker }));
}

async function startRemoteWorker() {
  remoteWorker = new SandboxWorkerClient(sandboxConfig("remote-http", remoteWorkerPath, {
    read: [workerDirectory, serverDirectory],
    denyRead: [dataDirectory],
  }), {
    onEvent(type, payload) {
      if (["worker-proxy-open", "worker-proxy-message", "worker-proxy-remote-close"].includes(type)) {
        trustedWorker.event(type, payload);
        return;
      }
      if (type === "synth-request") {
        trustedWorker.event("synthesize", payload);
        return;
      }
      if (type === "synth-cancel") {
        trustedWorker.event("cancel", payload);
        return;
      }
      if (type === "remote-status") {
        const status = sanitizeRemoteStatus(payload?.status);
        updateState({
          clients: status.authenticatedClients,
          sessions: status.sessions,
        });
        return;
      }
      if (type === "history") {
        void persistHistory(payload?.entry).catch((error) => writeSandboxLog("history", error?.message ?? error));
      }
    },
    onStderr: (chunk) => writeSandboxLog("remote-http", chunk),
    onExit: (code, signal) => sandboxFailure("remote-http", new Error(`exited (${signal ?? code ?? "unknown"})`)),
    onFailure: (error) => sandboxFailure("remote-http", error),
  });
  await remoteWorker.start();
  const address = await remoteWorker.request("start", {
    port: requestedPorts.remote,
    originCapabilityHost: listenerCapabilityHost("remote"),
    authKey: authKey.toString("base64url"),
    encryptionKey: encryptionKey.toString("base64url"),
    clientBanSalt,
    clientBans: state.clientBans,
    modelProfile: state.modelProfile,
    workerStatus,
  });
  ports.remote = Number(address?.port);
  remoteWorker.event("worker-status", { status: workerStatus });
}

async function startAdminWorker() {
  adminWorker = new SandboxWorkerClient(sandboxConfig("admin-http", adminWorkerPath, {
    read: [adminDirectory, serverDirectory, workerDirectory, webDirectory],
    denyRead: [dataDirectory],
  }), {
    onRequest(method, params) {
      if (method === "history-get") return storageWorker.request("history-get", params);
      if (method === "model-set") return setServerModelProfile(params?.modelProfile);
      if (method === "client-ban-set") return setClientBan(params?.clientHash, params?.banned);
      throw new Error(`unsupported admin parent request: ${method}`);
    },
    onEvent(type, payload) {
      if (type === "disconnect") {
        const connectionId = String(payload?.connectionId ?? "").toLowerCase();
        if (!/^[0-9a-f]{16}$/u.test(connectionId)) return;
        void remoteWorker.request("disconnect", { connectionId }).catch(() => {});
        return;
      }
      if (type === "history-subscribe") {
        const id = String(payload?.conversationId ?? "");
        if (!validConversationId(id)) return;
        historySubscriptions.set(id, (historySubscriptions.get(id) ?? 0) + 1);
        return;
      }
      if (type === "history-unsubscribe") {
        const id = String(payload?.conversationId ?? "");
        if (!validConversationId(id)) return;
        const next = (historySubscriptions.get(id) ?? 0) - 1;
        if (next > 0) historySubscriptions.set(id, next);
        else historySubscriptions.delete(id);
        return;
      }
      if (type === "diagnostic") writeSandboxLog("admin-http", payload?.message);
    },
    onStderr: (chunk) => writeSandboxLog("admin-http", chunk),
    onExit: (code, signal) => sandboxFailure("admin-http", new Error(`exited (${signal ?? code ?? "unknown"})`)),
    onFailure: (error) => sandboxFailure("admin-http", error),
  });
  await adminWorker.start();
  const address = await adminWorker.request("start", {
    port: requestedPorts.admin,
    originCapabilityHost: listenerCapabilityHost("admin"),
    sessionToken: adminSessionToken,
    state: adminSnapshot(),
    pairing: pairingPayload,
  });
  ports.admin = Number(address?.port);
}

async function bestEffortWithin(promise, timeoutMs = 750) {
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve(promise).catch(() => {}),
      new Promise((resolvePromise) => { timer = setTimeout(resolvePromise, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stopShutdownInput() {
  if (!process.stdin.isTTY) return;
  process.stdin.off("data", acceptShutdownInput);
  process.stdin.pause();
}

async function shutdown(exitCode = 0, reason = "shutdown") {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    stopShutdownInput();
    clearTimeout(workerTokenTimer);
    workerTokenTimer = null;
    state.overall = "停止中";
    writeSandboxLog("shutdown", `${reason}: cleaning up tunnels and sandbox processes`);

    const activeTunnels = [...tunnels.values()];
    tunnels.clear();
    await Promise.allSettled(activeTunnels.map((tunnel) => tunnel.stop()));

    const httpWorkers = [adminWorker, remoteWorker, trustedWorker].filter(Boolean);
    await Promise.allSettled(httpWorkers.map((worker) => bestEffortWithin(worker.request("close"))));
    await Promise.allSettled(httpWorkers.map((worker) => worker.close()));
    adminWorker = null;
    remoteWorker = null;
    trustedWorker = null;
    historySubscriptions.clear();

    if (storageWorker) {
      await bestEffortWithin(storageWorker.request("flush"));
      await bestEffortWithin(storageWorker.request("remove-runtime-files"));
      await storageWorker.close().catch(() => {});
      storageWorker = null;
    }

    writeSandboxLog("shutdown", "cleanup complete");
    process.exitCode = exitCode;
  })();
  return shutdownPromise;
}

function acceptShutdownInput(chunk) {
  if (shuttingDown) return;
  shutdownInputBuffer += String(chunk);
  for (;;) {
    const newline = shutdownInputBuffer.search(/[\r\n]/u);
    if (newline < 0) {
      if (shutdownInputBuffer.length > 4096) shutdownInputBuffer = shutdownInputBuffer.slice(-4096);
      return;
    }
    const line = shutdownInputBuffer.slice(0, newline);
    shutdownInputBuffer = shutdownInputBuffer.slice(newline + 1).replace(/^\n/u, "");
    if (!line.trim()) continue;
    void shutdown(0, "stdin");
    return;
  }
}

if (process.stdin.isTTY) {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", acceptShutdownInput);
  process.stdin.resume();
}

process.on("SIGINT", () => {
  if (shuttingDown) {
    process.exit(130);
    return;
  }
  void shutdown(0, "Ctrl+C");
});
process.once("SIGTERM", () => void shutdown(0, "SIGTERM"));

if (linuxDirectTestBackend) {
  writeSandboxLog("security", "Linux direct-test backend enabled: workers run directly inside the outer container; Windows Codex sandbox guarantees are not being tested.");
}

let startupStage = "storage worker";
try {
  await startStorageWorker();
  startupStage = "trusted worker";
  await startTrustedWorker();
  startupStage = "remote worker";
  await startRemoteWorker();
  startupStage = "admin worker";
  await startAdminWorker();

  updateState({
    overall: "Worker待機中",
    engine: "Worker待機中",
    model: `選択: ${state.modelProfile}`,
  });

  if (parsed.values["admin-public-origin"]) await setRolePublicOrigin("admin", parsed.values["admin-public-origin"]);
  if (parsed.values["worker-public-origin"]) await setRolePublicOrigin("worker", parsed.values["worker-public-origin"]);
  if (parsed.values["public-origin"]) await setRolePublicOrigin("remote", parsed.values["public-origin"]);

  const tunnelRoles = ["worker", "remote", "admin"].filter((role) => quickTunnelEnabledFor(role) && !publicOrigins[role]);
  if (tunnelRoles.length > 0) {
    updateState({ tunnel: "Quick Tunnel起動中", overall: "公開URL待機中" });
    for (const role of tunnelRoles) await startTunnel(role);
  }

  if (!publicOrigins.remote && parsed.values["no-quick-tunnel"]) {
    updateState({ tunnel: "Quick Tunnel無効", pairingReady: false });
  }
  recomputeOverall();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  serverReady = true;
  printReadyTree();
} catch (error) {
  writeSandboxLog("startup", `stage=${startupStage}`);
  writeSandboxLog("startup", error instanceof Error ? error.stack ?? error.message : String(error));
  await shutdown(1);
}
