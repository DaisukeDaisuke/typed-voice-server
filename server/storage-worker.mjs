import { createHash, randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HistoryStore } from "./history-store.mjs";
import { encodeEncryptedPairingText, writeEncryptedPairingFile, removeEncryptedPairingFile } from "./pairing-file.mjs";
import { writePrivateFileAtomic } from "./private-file.mjs";
import { ServerSettingsStore } from "./settings-store.mjs";
import { createFdStdioPeer } from "./stdio-peer.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const historyDirectory = join(projectRoot, "data", "history");
const settingsPath = join(projectRoot, "data", "settings.json");
const adminSessionTokenPath = join(projectRoot, "data", "admin", "session-token.txt");
const workerSessionTokenPath = join(projectRoot, "data", "worker", "session-token.txt");
const workerResetTokenPath = join(projectRoot, "data", "worker", "reset-token.txt");
const serverPortPath = join(projectRoot, "data", "server", "listen-port.txt");
const pairingFilePath = join(projectRoot, "data", "pairing", "typed-voice-server.tvrkey");
const MAX_CLIENT_BANS = 10_000;
const MAX_HISTORY_RESPONSE_BYTES = 1_500_000;

let settingsStore = null;
let historyStore = null;

function validateHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") throw new Error("history entry is required");
  const conversationId = String(entry.conversationId ?? "");
  const requestId = String(entry.requestId ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(conversationId)) throw new Error("invalid history conversation id");
  if (!/^[0-9]{1,20}$/u.test(requestId)) throw new Error("invalid history request id");
  const at = Number(entry.at);
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("invalid history timestamp");
  if (entry.phase === "request") {
    const text = String(entry.text ?? "");
    if (!text.trim() || Buffer.byteLength(text, "utf8") > 16 * 1024) throw new Error("invalid history request text");
    return { phase: "request", conversationId, requestId, text, at };
  }
  if (entry.phase === "result") {
    const durationMs = Number(entry.durationMs ?? 0);
    if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 24 * 60 * 60 * 1000) throw new Error("invalid history duration");
    const error = entry.error == null ? null : String(entry.error).slice(0, 1024);
    return {
      phase: "result",
      conversationId,
      requestId,
      ok: Boolean(entry.ok),
      cancelled: Boolean(entry.cancelled),
      error,
      durationMs,
      at,
    };
  }
  throw new Error("unsupported history phase");
}

function decodeKey(value, label) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(text)) throw new Error(`${label} must be a 32-byte base64url key`);
  const key = Buffer.from(text, "base64url");
  if (key.length !== 32) throw new Error(`${label} must decode to 32 bytes`);
  return key;
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
  const url = new URL(String(endpoint));
  if (url.protocol !== "wss:" || url.pathname !== "/remote") throw new Error("pairing endpoint must be wss /remote");
  const pairing = {
    v: 1,
    u: url.href,
    a: authKey.toString("base64url"),
    e: encryptionKey.toString("base64url"),
    c: pairingChecksum(url.href, authKey, encryptionKey).toString("base64url"),
  };
  return pairing;
}

async function writePrivate(path, data, encoding = "utf8") {
  return writePrivateFileAtomic(path, data, { encoding });
}

async function removePrivate(path) {
  await rm(path, { force: true }).catch(() => {});
  await rm(`${path}.tmp`, { force: true }).catch(() => {});
}

async function ensureOpen() {
  if (!settingsStore) settingsStore = await new ServerSettingsStore(settingsPath).open();
  if (!historyStore) historyStore = await new HistoryStore(historyDirectory).open();
}

function boundedHistoryContent(content) {
  const result = {
    metadata: content?.metadata ?? null,
    events: Array.isArray(content?.events) ? content.events : [],
    totalEvents: Number(content?.totalEvents ?? 0),
    truncated: false,
  };
  while (result.events.length > 0 && Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_HISTORY_RESPONSE_BYTES) {
    result.events.splice(0, Math.max(1, Math.floor(result.events.length / 4)));
    result.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_HISTORY_RESPONSE_BYTES) throw new Error("history metadata exceeds response limit");
  if (result.events.length < result.totalEvents) result.truncated = true;
  return result;
}

async function handleRequest(method, params) {
  if (method === "open") {
    await ensureOpen();
    if (settingsStore.clientBans.length > MAX_CLIENT_BANS) throw new Error("client ban list exceeds storage limit");
    return {
      modelProfile: settingsStore.modelProfile,
      clientBanSalt: settingsStore.clientBanSalt,
      clientBans: settingsStore.clientBans,
    };
  }
  if (method === "set-model") {
    await ensureOpen();
    return settingsStore.setModelProfile(params?.modelProfile);
  }
  if (method === "set-client-ban") {
    await ensureOpen();
    const normalized = String(params?.clientHash ?? "").toLowerCase();
    if (Boolean(params?.banned) && !settingsStore.isClientBanned(normalized) && settingsStore.clientBans.length >= MAX_CLIENT_BANS) {
      throw new Error("client ban list limit reached");
    }
    const banned = await settingsStore.setClientBanned(params?.clientHash, Boolean(params?.banned));
    return { clientHash: String(params?.clientHash ?? "").toLowerCase(), banned, clientBans: settingsStore.clientBans };
  }
  if (method === "history-get") {
    await ensureOpen();
    return boundedHistoryContent(await historyStore.getContent(params?.conversationId, { limit: 5000 }));
  }
  if (method === "history-record") {
    await ensureOpen();
    const entry = validateHistoryEntry(params?.entry);
    if (entry.phase === "request") {
      const event = await historyStore.recordRequest({
        conversationId: entry.conversationId,
        requestId: entry.requestId,
        text: entry.text,
        at: entry.at,
      });
      return { event, metadata: historyStore.getMetadata(entry.conversationId) };
    }
    if (entry.phase === "result") {
      const event = await historyStore.recordResult({
        conversationId: entry.conversationId,
        requestId: entry.requestId,
        ok: entry.ok,
        cancelled: entry.cancelled,
        error: entry.error,
        durationMs: entry.durationMs,
        at: entry.at,
      });
      return { event, metadata: historyStore.getMetadata(entry.conversationId) };
    }
    throw new Error("unsupported history phase");
  }
  if (method === "flush") {
    await historyStore?.flush();
    return true;
  }
  if (method === "write-admin-token") {
    const token = String(params?.token ?? "");
    if (!/^[0-9a-f]{64}$/u.test(token)) throw new Error("admin token must be 64 lowercase hex characters");
    return writePrivate(adminSessionTokenPath, `${token}\n`);
  }
  if (method === "write-worker-token") {
    const token = String(params?.token ?? "");
    if (!/^[0-9a-f]{128}$/u.test(token)) throw new Error("worker token must be 128 lowercase hex characters");
    return writePrivate(workerSessionTokenPath, `${token}\n`);
  }
  if (method === "write-worker-reset-token") {
    const token = String(params?.token ?? "");
    if (!/^[0-9a-f]{128}$/u.test(token)) throw new Error("worker reset token must be 128 lowercase hex characters");
    return writePrivate(workerResetTokenPath, token);
  }
  if (method === "write-worker-port") {
    const port = Number(params?.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("worker port must be 1..65535");
    return writePrivate(serverPortPath, String(port));
  }
  if (method === "write-pairing") {
    const authKey = decodeKey(params?.authKey, "authKey");
    const encryptionKey = decodeKey(params?.encryptionKey, "encryptionKey");
    const pairing = buildPairing(params?.endpoint, authKey, encryptionKey);
    const q = encodeEncryptedPairingText(pairing, randomBytes(12));
    const path = await writeEncryptedPairingFile(pairingFilePath, pairing, { randomBytes });
    return { pairing: { v: pairing.v, u: pairing.u, c: pairing.c, q }, path };
  }
  if (method === "remove-runtime-files") {
    await removeEncryptedPairingFile(pairingFilePath);
    await Promise.all([
      removePrivate(adminSessionTokenPath),
      removePrivate(workerSessionTokenPath),
      removePrivate(workerResetTokenPath),
      removePrivate(serverPortPath),
    ]);
    return true;
  }
  if (method === "remove-pairing") {
    await removeEncryptedPairingFile(pairingFilePath);
    return true;
  }
  throw new Error(`unsupported storage request: ${method}`);
}

createFdStdioPeer({ onRequest: handleRequest });
