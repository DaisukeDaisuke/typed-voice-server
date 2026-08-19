import {
  AUTH_DEADLINE_MS,
  AudioFlags,
  AudioFormat,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  ModelProfileCode,
  Opcode,
  acceptClientHello,
  decryptFrame,
  encryptFrame,
  randomId,
  readClientAuth,
} from "../worker/protocol.mjs";
import { acceptWebSocketUpgrade } from "../worker/websocket.mjs";

const MAX_TEXT_BYTES = 16 * 1024;
const AUDIO_CHUNK_BYTES = 64 * 1024;
const WORKER_STATUS_INTERVAL_MS = 5_000;
const MODEL_PROFILES = new Set(["fp32", "fp16", "mobile-int8", "mobile-int4"]);

function errorPayload(code, message) {
  const text = Buffer.from(String(message ?? ""), "utf8");
  const result = Buffer.allocUnsafe(2 + text.length);
  result.writeUInt16BE(code, 0);
  text.copy(result, 2);
  return result;
}

function float32ToPcm16(floatBytes, sampleCount) {
  if (floatBytes.length !== sampleCount * 4) throw new Error("float32 audio length mismatch");
  const result = Buffer.allocUnsafe(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.max(-1, Math.min(1, floatBytes.readFloatLE(index * 4)));
    const value = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    result.writeInt16LE(value, index * 2);
  }
  return result;
}

function validateKey(key, label) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error(`${label} must be 32 bytes`);
  return key;
}

function validateProfile(value) {
  const profile = String(value ?? "");
  if (!MODEL_PROFILES.has(profile)) throw new Error("invalid model profile");
  return profile;
}

export class RemoteClientHub {
  constructor({
    pool,
    authKey,
    encryptionKey,
    modelProfile = "fp16",
    clientBanSalt,
    isClientBanned = () => false,
    onStatus = () => {},
    onHistory = () => {},
  }) {
    if (!pool || typeof pool.synthesize !== "function") throw new Error("worker pool is required");
    this.pool = pool;
    this.authKey = validateKey(authKey, "authKey");
    this.encryptionKey = validateKey(encryptionKey, "encryptionKey");
    this.modelProfile = validateProfile(modelProfile);
    this.clientBanSalt = validateKey(clientBanSalt, "clientBanSalt");
    this.isClientBanned = isClientBanned;
    this.onStatus = onStatus;
    this.onHistory = onHistory;
    this.clients = new Set();
    this.pending = new Map();
    this.workerStatusTimer = null;
    this.closed = false;
  }

  handleUpgrade(request, socket, head) {
    if (this.closed) throw new Error("remote hub is closed");
    const ws = acceptWebSocketUpgrade(request, socket, head, { path: "/remote", maxMessageBytes: 1024 * 1024 });
    this.#attachClient(ws);
  }

  status() {
    let authenticatedClients = 0;
    for (const client of this.clients) if (client.authenticated) authenticatedClients += 1;
    return {
      clients: this.clients.size,
      authenticatedClients,
      pendingRequests: this.pending.size,
      sessions: [...this.clients]
        .filter((client) => client.authenticated)
        .map((client) => ({
          connectionId: client.connectionId,
          conversationId: client.conversationId,
          connectedAt: client.connectedAt,
          lastSeenAt: client.lastSeenAt,
          requests: client.requests,
          pending: [...this.pending.values()].filter((entry) => entry.client === client).length,
          clientHash: client.clientHash,
        })),
    };
  }

  setModelProfile(modelProfile) {
    this.modelProfile = validateProfile(modelProfile);
    for (const client of this.clients) if (client.authenticated) this.#sendServerConfig(client);
    return { modelProfile: this.modelProfile };
  }

  broadcastWorkerStatus() {
    if (this.closed) return;
    const status = this.#workerStatus();
    for (const client of this.clients) if (client.authenticated) this.#sendWorkerStatus(client, status);
    this.#scheduleWorkerStatus(status);
  }

  disconnect(connectionId) {
    const normalized = String(connectionId ?? "").toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(normalized)) return false;
    const client = [...this.clients].find((entry) => entry.connectionId === normalized);
    if (!client) return false;
    client.ws.close(1008);
    return true;
  }

  disconnectClientHash(clientHash) {
    const normalized = String(clientHash ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalized)) return 0;
    let count = 0;
    for (const client of this.clients) {
      if (client.clientHash !== normalized) continue;
      count += 1;
      client.ws.close(1008);
    }
    return count;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.workerStatusTimer);
    this.workerStatusTimer = null;
    for (const client of [...this.clients]) client.ws.close(1001);
    this.clients.clear();
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id);
      await this.pool.cancel(id).catch(() => {});
      this.#recordResult(entry, { ok: false, cancelled: true, error: "SERVER_SHUTDOWN" });
    }
    this.#emitStatus();
  }

  #attachClient(ws) {
    const client = {
      ws,
      connectionId: randomId().toString(16).padStart(16, "0"),
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      conversationId: null,
      requests: 0,
      stage: "hello",
      session: null,
      authenticated: false,
      clientHash: null,
      authTimer: null,
      heartbeatTimer: null,
      pongTimer: null,
      pendingPing: null,
    };
    this.clients.add(client);
    this.#emitStatus();
    client.authTimer = setTimeout(() => ws.close(1008), AUTH_DEADLINE_MS);
    ws.onMessage = (payload) => {
      try {
        this.#handleClientMessage(client, payload);
      } catch {
        ws.close(1008);
      }
    };
    ws.onClose = () => void this.#dropClient(client);
  }

  async #dropClient(client) {
    if (!this.clients.delete(client)) return;
    clearTimeout(client.authTimer);
    clearTimeout(client.heartbeatTimer);
    clearTimeout(client.pongTimer);
    const owned = [...this.pending].filter(([, entry]) => entry.client === client);
    for (const [id] of owned) this.pending.delete(id);
    for (const [id, entry] of owned) {
      await this.pool.cancel(id).catch(() => {});
      this.#recordResult(entry, {
        ok: false,
        cancelled: true,
        error: this.closed ? "SERVER_SHUTDOWN" : "CLIENT_DISCONNECTED",
      });
    }
    this.#emitStatus();
  }

  #handleClientMessage(client, payload) {
    if (client.stage === "hello") {
      const accepted = acceptClientHello(payload, this.authKey, this.encryptionKey, { clientBanSalt: this.clientBanSalt });
      client.session = accepted.session;
      client.stage = "auth";
      client.ws.sendBinary(accepted.hello);
      return;
    }
    if (client.stage === "auth") {
      const auth = readClientAuth(payload, client.session);
      if (!auth.valid || !auth.clientHash) throw new Error("authentication failed");
      client.clientHash = auth.clientHash;
      if (this.isClientBanned(client.clientHash)) {
        client.ws.close(1008);
        return;
      }
      clearTimeout(client.authTimer);
      client.authTimer = null;
      client.authenticated = true;
      client.stage = "ready";
      this.#emitStatus();
      this.#sendServerConfig(client);
      const workerStatus = this.#workerStatus();
      this.#sendWorkerStatus(client, workerStatus);
      this.#scheduleWorkerStatus(workerStatus);
      this.#sendPing(client);
      return;
    }
    if (client.stage !== "ready") throw new Error("invalid client stage");
    const frame = decryptFrame(client.session, payload);
    client.lastSeenAt = Date.now();
    if (frame.op === Opcode.PONG) {
      if (client.pendingPing === null || frame.id !== client.pendingPing) throw new Error("unexpected pong");
      client.pendingPing = null;
      clearTimeout(client.pongTimer);
      client.pongTimer = null;
      client.heartbeatTimer = setTimeout(() => this.#sendPing(client), HEARTBEAT_INTERVAL_MS);
      return;
    }
    if (frame.op === Opcode.SESSION) {
      if (frame.id !== 0n || frame.payload.length < 1 || frame.payload.length > 128) throw new Error("invalid session frame");
      const conversationId = new TextDecoder("utf-8", { fatal: true }).decode(frame.payload).trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(conversationId)) throw new Error("invalid conversation id");
      client.conversationId = conversationId;
      this.#emitStatus();
      return;
    }
    if (frame.op === Opcode.TEXT) {
      this.#acceptText(client, frame);
      return;
    }
    if (frame.op === Opcode.CANCEL) {
      this.#acceptCancel(client, frame.id);
      return;
    }
    throw new Error("unsupported client opcode");
  }

  #acceptText(client, frame) {
    if (frame.payload.length < 1 || frame.payload.length > MAX_TEXT_BYTES) throw new Error("invalid text length");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(frame.payload);
    if (!text.trim()) throw new Error("empty text");
    const id = frame.id.toString();
    if (this.pending.has(id)) throw new Error("duplicate request id");
    const entry = {
      id,
      rawId: frame.id,
      text,
      client,
      conversationId: client.conversationId,
      startedAt: Date.now(),
    };
    client.requests += 1;
    this.pending.set(id, entry);
    this.onHistory({
      phase: "request",
      conversationId: entry.conversationId,
      requestId: id,
      text,
      at: entry.startedAt,
    });
    this.#emitStatus();
    void Promise.resolve().then(() => this.pool.synthesize(id, text)).then((audio) => {
      if (this.pending.get(id) !== entry) return;
      try {
        if (client.authenticated && !client.ws.closed) this.#sendAudio(client, frame.id, audio.sampleRate, audio.sampleCount, audio.audio);
        this.pending.delete(id);
        this.#recordResult(entry, { ok: true });
        this.#emitStatus();
      } catch (error) {
        this.pending.delete(id);
        if (client.authenticated && !client.ws.closed) {
          this.#sendEncrypted(client, {
            op: Opcode.ERROR,
            id: frame.id,
            payload: errorPayload(5, error instanceof Error ? error.message : String(error)),
          });
        }
        this.#recordResult(entry, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        this.#emitStatus();
      }
    }).catch((error) => {
      if (this.pending.get(id) !== entry) return;
      this.pending.delete(id);
      const cancelled = error?.name === "AbortError";
      if (client.authenticated && !client.ws.closed) {
        this.#sendEncrypted(client, {
          op: Opcode.ERROR,
          id: frame.id,
          payload: errorPayload(cancelled ? 6 : 5, error instanceof Error ? error.message : String(error)),
        });
      }
      this.#recordResult(entry, {
        ok: false,
        cancelled,
        error: error instanceof Error ? error.message : String(error),
      });
      this.#emitStatus();
    });
  }

  #acceptCancel(client, rawId) {
    const id = rawId.toString();
    const entry = this.pending.get(id);
    if (!entry || entry.client !== client) return;
    this.pending.delete(id);
    void this.pool.cancel(id).catch(() => {});
    this.#sendEncrypted(client, { op: Opcode.ERROR, id: rawId, payload: errorPayload(6, "CANCELLED") });
    this.#recordResult(entry, { ok: false, cancelled: true, error: "CANCELLED" });
    this.#emitStatus();
  }

  #recordResult(entry, { ok, cancelled = false, error = null }) {
    this.onHistory({
      phase: "result",
      conversationId: entry.conversationId,
      requestId: entry.id,
      ok,
      cancelled,
      error,
      durationMs: Date.now() - entry.startedAt,
      at: Date.now(),
    });
  }

  #sendPing(client) {
    if (!client.authenticated || client.ws.closed) return;
    const id = randomId();
    client.pendingPing = id;
    this.#sendEncrypted(client, { op: Opcode.PING, id });
    client.pongTimer = setTimeout(() => client.ws.close(1001), HEARTBEAT_TIMEOUT_MS);
  }

  #sendEncrypted(client, message) {
    client.ws.sendBinary(encryptFrame(client.session, message));
  }

  #sendServerConfig(client) {
    this.#sendEncrypted(client, {
      op: Opcode.SERVER_CONFIG,
      payload: Buffer.from([ModelProfileCode[this.modelProfile]]),
    });
  }

  #workerStatus() {
    const engines = this.pool.status()?.engines;
    const workers = Array.isArray(engines) ? engines : [];
    const connected = workers.filter((worker) => worker?.connected).length;
    const ready = workers.filter((worker) => worker?.connected && worker?.info?.ready).length;
    return {
      connected: Math.min(0xffff, connected),
      ready: Math.min(0xffff, ready),
    };
  }

  #sendWorkerStatus(client, status = this.#workerStatus()) {
    const payload = Buffer.allocUnsafe(4);
    payload.writeUInt16BE(status.connected, 0);
    payload.writeUInt16BE(status.ready, 2);
    this.#sendEncrypted(client, { op: Opcode.WORKER_STATUS, payload });
  }

  #scheduleWorkerStatus(status = this.#workerStatus()) {
    clearTimeout(this.workerStatusTimer);
    this.workerStatusTimer = null;
    if (this.closed || status.ready > 0) return;
    const hasAuthenticatedClient = [...this.clients].some((client) => client.authenticated);
    if (!hasAuthenticatedClient) return;
    this.workerStatusTimer = setTimeout(() => {
      this.workerStatusTimer = null;
      this.broadcastWorkerStatus();
    }, WORKER_STATUS_INTERVAL_MS);
    this.workerStatusTimer.unref?.();
  }

  #sendAudio(client, id, sampleRate, sampleCount, floatBytes) {
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error("invalid sample rate");
    if (!Number.isSafeInteger(sampleCount) || sampleCount < 0 || floatBytes.length !== sampleCount * 4) throw new Error("invalid sample count");
    const audio = client.session.audioFormat === AudioFormat.PCM16LE
      ? float32ToPcm16(floatBytes, sampleCount)
      : Buffer.from(floatBytes);
    const metadata = Buffer.allocUnsafe(10);
    metadata[0] = client.session.audioFormat;
    metadata[1] = 1;
    metadata.writeUInt32BE(sampleRate, 2);
    metadata.writeUInt32BE(sampleCount, 6);
    let offset = 0;
    const firstAudioBytes = Math.min(audio.length, AUDIO_CHUNK_BYTES - metadata.length);
    let flags = AudioFlags.START;
    if (firstAudioBytes === audio.length) flags |= AudioFlags.END;
    this.#sendEncrypted(client, {
      op: Opcode.AUDIO,
      flags,
      id,
      payload: Buffer.concat([metadata, audio.subarray(0, firstAudioBytes)]),
    });
    offset = firstAudioBytes;
    while (offset < audio.length) {
      const end = Math.min(audio.length, offset + AUDIO_CHUNK_BYTES);
      this.#sendEncrypted(client, {
        op: Opcode.AUDIO,
        flags: end === audio.length ? AudioFlags.END : 0,
        id,
        payload: audio.subarray(offset, end),
      });
      offset = end;
    }
  }

  #emitStatus() {
    this.onStatus(this.status());
  }
}
