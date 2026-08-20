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
const MAX_SYNC_TEXT_BYTES = MAX_TEXT_BYTES * 2 + 1024;
const MAX_AUTHENTICATED_CLIENTS = 64;
const MAX_PENDING_PER_CLIENT = 3;
const MAX_TOTAL_PENDING = MAX_AUTHENTICATED_CLIENTS * MAX_PENDING_PER_CLIENT;
const REQUEST_BURST_WINDOW_MS = 10_000;
const MAX_REQUESTS_PER_BURST_WINDOW = 64;
const AUDIO_CHUNK_BYTES = 64 * 1024;
const WORKER_STATUS_INTERVAL_MS = 5_000;
const TRUSTED_WORKER_HELLO = 1;
const MODEL_PROFILES = new Set(["fp32", "fp16", "mobile-int8", "mobile-int4"]);
const CLIENT_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]{0,9}$/i;

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
    onWorkerConnection = null,
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
    this.onWorkerConnection = typeof onWorkerConnection === "function" ? onWorkerConnection : null;
    this.clients = new Set();
    this.pending = new Map();
    this.pendingByClientToken = new Map();
    this.pendingByDeliveryId = new Map();
    this.workerStatusTimer = null;
    this.closed = false;
  }

  handleUpgrade(request, socket, head) {
    if (this.closed) throw new Error("remote hub is closed");
    const ws = acceptWebSocketUpgrade(request, socket, head, { path: "/remote", maxMessageBytes: 1024 * 1024 });
    if (!this.onWorkerConnection) {
      this.#attachClient(ws);
      return;
    }
    const timer = setTimeout(() => ws.close(1008), AUTH_DEADLINE_MS);
    ws.onClose = () => clearTimeout(timer);
    ws.onMessage = (payload) => {
      clearTimeout(timer);
      const first = Buffer.from(payload);
      if (first[0] === Opcode.HELLO_CLIENT) {
        this.#attachClient(ws, first);
        return;
      }
      if (first[0] === TRUSTED_WORKER_HELLO) {
        this.onWorkerConnection(ws, first);
        return;
      }
      ws.close(1008);
    };
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
      this.#detachPending(entry, { cancelSynthesis: true });
      this.#recordResult(entry, { ok: false, cancelled: true, error: "SERVER_SHUTDOWN" });
    }
    this.#emitStatus();
  }

  #attachClient(ws, firstPayload = null) {
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
      clientInstanceId: null,
      authTimer: null,
      heartbeatTimer: null,
      pongTimer: null,
      pendingPing: null,
      replacedBy: null,
      requestWindowStartedAt: Date.now(),
      requestWindowCount: 0,
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
    if (firstPayload) {
      try {
        this.#handleClientMessage(client, firstPayload);
      } catch {
        ws.close(1008);
      }
    }
  }

  async #dropClient(client) {
    if (!this.clients.delete(client)) return;
    clearTimeout(client.authTimer);
    clearTimeout(client.heartbeatTimer);
    clearTimeout(client.pongTimer);
    client.authenticated = false;
    if (client.replacedBy) {
      this.#emitStatus();
      return;
    }
    if (this.closed) {
      const owned = [...this.pending].filter(([, entry]) => entry.client === client);
      for (const [, entry] of owned) {
        this.#detachPending(entry, { cancelSynthesis: true });
        this.#recordResult(entry, { ok: false, cancelled: true, error: "SERVER_SHUTDOWN" });
      }
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
      client.clientInstanceId = auth.clientInstanceId ?? null;
      if (this.isClientBanned(client.clientHash)) {
        client.ws.close(1008);
        return;
      }
      const sameAuthenticatedClient = [...this.clients].some((candidate) => (
        candidate !== client
        && candidate.authenticated
        && client.clientInstanceId
        && candidate.clientInstanceId === client.clientInstanceId
      ));
      const authenticatedCount = [...this.clients].filter((candidate) => candidate.authenticated).length;
      if (!sameAuthenticatedClient && authenticatedCount >= MAX_AUTHENTICATED_CLIENTS) {
        client.ws.close(1013);
        return;
      }
      clearTimeout(client.authTimer);
      client.authTimer = null;
      client.authenticated = true;
      client.stage = "ready";
      this.#takeOverAuthenticatedClient(client);
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
      this.#acceptText(client, frame, null);
      return;
    }
    if (frame.op === Opcode.TEXT_SYNC) {
      this.#acceptSyncText(client, frame);
      return;
    }
    if (frame.op === Opcode.CANCEL) {
      this.#acceptCancel(client, frame.id);
      return;
    }
    throw new Error("unsupported client opcode");
  }

  #acceptSyncText(client, frame) {
    if (frame.payload.length < 1 || frame.payload.length > MAX_SYNC_TEXT_BYTES) throw new Error("invalid sync text length");
    if (!this.#consumeRequestBudget(client)) return;
    const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload));
    const clientToken = String(request?.clientToken ?? "");
    if (!CLIENT_TOKEN_PATTERN.test(clientToken)) throw new Error("invalid client token");
    const text = String(request?.text ?? "");
    if (Buffer.byteLength(text, "utf8") < 1 || Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) throw new Error("invalid text length");
    const resumeKey = `${client.clientInstanceId}:${clientToken}`;
    const existing = this.pendingByClientToken.get(resumeKey);
    if (existing) {
      if (existing.text !== text
        || existing.conversationId !== client.conversationId
        || existing.modelProfile !== this.modelProfile) {
        throw new Error("resume query mismatch");
      }
      this.pendingByDeliveryId.delete(existing.deliveryId.toString());
      existing.client = client;
      existing.deliveryId = frame.id;
      this.pendingByDeliveryId.set(existing.deliveryId.toString(), existing);
      return;
    }
    this.#acceptText(client, frame, { text, clientToken, resumeKey, budgetConsumed: true });
  }

  #acceptText(client, frame, sync = null) {
    if (!sync?.budgetConsumed && !this.#consumeRequestBudget(client)) return;
    if (!sync && (frame.payload.length < 1 || frame.payload.length > MAX_TEXT_BYTES)) throw new Error("invalid text length");
    const text = sync?.text ?? new TextDecoder("utf-8", { fatal: true }).decode(frame.payload);
    if (!text.trim()) throw new Error("empty text");
    const ownedPending = [...this.pending.values()].filter((entry) => entry.client === client).length;
    if (ownedPending >= MAX_PENDING_PER_CLIENT) {
      client.ws.close(1008);
      return;
    }
    const id = frame.id.toString();
    if (this.pending.has(id)) throw new Error("duplicate request id");
    client.requests += 1;
    if (this.pending.size >= MAX_TOTAL_PENDING) {
      client.ws.close(1008);
      return;
    }
    const entry = {
      id,
      rawId: frame.id,
      deliveryId: frame.id,
      text,
      client,
      conversationId: client.conversationId,
      modelProfile: this.modelProfile,
      clientToken: sync?.clientToken ?? null,
      resumeKey: sync?.resumeKey ?? null,
      startedAt: Date.now(),
    };
    this.pending.set(id, entry);
    if (entry.resumeKey) this.pendingByClientToken.set(entry.resumeKey, entry);
    this.pendingByDeliveryId.set(entry.deliveryId.toString(), entry);
    this.onHistory({
      phase: "request",
      conversationId: entry.conversationId,
      requestId: id,
      text,
      at: entry.startedAt,
    });
    this.#emitStatus();
    void this.pool.synthesize(id, text).then((audio) => {
      if (this.pending.get(id) !== entry) return;
      try {
        const owner = entry.client;
        if (owner.authenticated && !owner.ws.closed) this.#sendAudio(owner, entry.deliveryId, audio.sampleRate, audio.sampleCount, audio.audio);
        this.#detachPending(entry, { cancelSynthesis: false });
        this.#recordResult(entry, { ok: true });
        this.#emitStatus();
      } catch (error) {
        this.#detachPending(entry, { cancelSynthesis: false });
        const owner = entry.client;
        if (owner.authenticated && !owner.ws.closed) {
          this.#sendEncrypted(owner, {
            op: Opcode.ERROR,
            id: entry.deliveryId,
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
      this.#detachPending(entry, { cancelSynthesis: false });
      const cancelled = error?.name === "AbortError";
      const owner = entry.client;
      if (owner.authenticated && !owner.ws.closed) {
        this.#sendEncrypted(owner, {
          op: Opcode.ERROR,
          id: entry.deliveryId,
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
    const deliveryId = rawId.toString();
    const entry = this.pendingByDeliveryId.get(deliveryId);
    if (!entry || entry.client !== client) return;
    this.#detachPending(entry, { cancelSynthesis: true });
    this.#sendEncrypted(client, { op: Opcode.ERROR, id: rawId, payload: errorPayload(6, "CANCELLED") });
    this.#recordResult(entry, { ok: false, cancelled: true, error: "CANCELLED" });
    this.#emitStatus();
  }

  #takeOverAuthenticatedClient(client) {
    if (!client.clientInstanceId) return;
    const previousClients = [...this.clients].filter((candidate) => (
      candidate !== client
      && candidate.authenticated
      && candidate.clientInstanceId === client.clientInstanceId
    ));
    if (!previousClients.length) return;
    previousClients.sort((left, right) => right.lastSeenAt - left.lastSeenAt);
    if (!client.conversationId) client.conversationId = previousClients[0].conversationId;
    for (const previous of previousClients) {
      previous.replacedBy = client;
      previous.authenticated = false;
      previous.stage = "replaced";
      previous.ws.close(1000);
    }
  }

  #consumeRequestBudget(client, now = Date.now()) {
    if (now - client.requestWindowStartedAt >= REQUEST_BURST_WINDOW_MS) {
      client.requestWindowStartedAt = now;
      client.requestWindowCount = 0;
    }
    client.requestWindowCount += 1;
    if (client.requestWindowCount <= MAX_REQUESTS_PER_BURST_WINDOW) return true;
    client.ws.close(1008);
    return false;
  }

  #detachPending(entry, { cancelSynthesis }) {
    if (this.pending.get(entry.id) === entry) this.pending.delete(entry.id);
    if (entry.resumeKey && this.pendingByClientToken.get(entry.resumeKey) === entry) {
      this.pendingByClientToken.delete(entry.resumeKey);
    }
    if (this.pendingByDeliveryId.get(entry.deliveryId.toString()) === entry) {
      this.pendingByDeliveryId.delete(entry.deliveryId.toString());
    }
    if (cancelSynthesis) void this.pool.cancel(entry.id).catch(() => {});
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
