import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { acceptWebSocketUpgrade } from "../worker/websocket.mjs";

const MODEL_PROFILES = new Set(["fp32", "fp16", "mobile-int8", "mobile-int4"]);
const PROTOCOL_LABEL = Buffer.from("typed-voice-volunteer-worker/v2", "utf8");
const MAX_WORKERS = 64;
const MAX_WORKER_MESSAGE_BYTES = 1024 * 1024;
const MAX_AUDIO_BYTES = 256 * 1024 * 1024;
const AUDIO_CHUNK_BYTES = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const PING_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 15_000;

export const EngineMessageType = Object.freeze({
  HELLO: 1,
  HELLO_ACK: 2,
  AUTH: 3,
  PING: 10,
  PONG: 11,
  CONFIG: 12,
  STATUS: 13,
  SYNTH: 14,
  CANCEL: 15,
  AUDIO_META: 16,
  AUDIO_CHUNK: 17,
  ERROR: 18,
});

function encodeJson(type, value) {
  return Buffer.concat([Buffer.from([type]), Buffer.from(JSON.stringify(value), "utf8")]);
}

function decodeJson(payload, expectedType) {
  if (!Buffer.isBuffer(payload) || payload.length < 2 || payload[0] !== expectedType) throw new Error("invalid worker message");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(1)));
}

function decodeBase64Url(value, bytes, label) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error(`${label} is not base64url`);
  const result = Buffer.from(text, "base64url");
  if (result.length !== bytes) throw new Error(`${label} must be ${bytes} bytes`);
  return result;
}

function validateProfile(value) {
  const profile = String(value ?? "");
  if (!MODEL_PROFILES.has(profile)) throw new Error("unsupported model profile");
  return profile;
}

function sequenceBuffer(value) {
  const result = Buffer.allocUnsafe(8);
  result.writeBigUInt64BE(value, 0);
  return result;
}

function nonce(prefix, sequence) {
  return Buffer.concat([prefix, sequenceBuffer(sequence)]);
}

function seal(session, type, payload = Buffer.alloc(0)) {
  if (!Number.isSafeInteger(type) || type < 1 || type > 255) throw new Error("invalid encrypted worker message type");
  const sequence = session.sendSeq;
  const header = Buffer.concat([Buffer.from([type]), sequenceBuffer(sequence)]);
  const cipher = createCipheriv("aes-256-gcm", session.sendKey, nonce(session.sendNoncePrefix, sequence), { authTagLength: 16 });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(payload)), cipher.final()]);
  session.sendSeq += 1n;
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
}

function open(session, frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 25) throw new Error("encrypted worker frame is truncated");
  const type = frame[0];
  const sequence = frame.readBigUInt64BE(1);
  if (sequence !== session.receiveSeq) throw new Error("worker frame sequence mismatch");
  const header = frame.subarray(0, 9);
  const tag = frame.subarray(frame.length - 16);
  const ciphertext = frame.subarray(9, frame.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", session.receiveKey, nonce(session.receiveNoncePrefix, sequence), { authTagLength: 16 });
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  session.receiveSeq += 1n;
  return { type, payload };
}

function deriveSession(ecdh, clientPublicKey, clientNonce, serverNonce) {
  const serverPublicKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(clientPublicKey);
  const salt = createHash("sha256")
    .update(PROTOCOL_LABEL)
    .update(clientNonce)
    .update(serverNonce)
    .digest();
  const material = Buffer.from(hkdfSync("sha256", sharedSecret, salt, PROTOCOL_LABEL, 104));
  const transcript = createHash("sha256")
    .update(PROTOCOL_LABEL)
    .update(clientPublicKey)
    .update(serverPublicKey)
    .update(clientNonce)
    .update(serverNonce)
    .digest();
  return {
    serverPublicKey,
    transcript,
    session: {
      receiveKey: material.subarray(0, 32),
      sendKey: material.subarray(32, 64),
      receiveNoncePrefix: material.subarray(64, 68),
      sendNoncePrefix: material.subarray(68, 72),
      proofKey: material.subarray(72, 104),
      receiveSeq: 0n,
      sendSeq: 0n,
    },
  };
}

function proof(session, label, transcript) {
  return createHmac("sha256", session.proofKey)
    .update(Buffer.from(`${label}\0`, "utf8"))
    .update(transcript)
    .digest();
}

function workerSnapshot(worker) {
  return {
    index: worker.index,
    busy: worker.busy,
    connected: !worker.ws.closed,
    authenticated: worker.authenticated,
    info: worker.info,
    connectedAt: worker.connectedAt,
    lastPongAt: worker.lastPongAt,
  };
}

function abortError() {
  return new DOMException("Synthesis cancelled", "AbortError");
}

function decodeAudioChunk(payload) {
  if (payload.length < 3) throw new Error("worker audio chunk is truncated");
  const idLength = payload.readUInt16BE(0);
  if (idLength < 1 || idLength > 128 || payload.length <= 2 + idLength) throw new Error("worker audio chunk id is invalid");
  const id = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(2, 2 + idLength));
  return { id, chunk: payload.subarray(2 + idLength) };
}

export class BrowserWorkerPool {
  constructor({ profile = "fp16", jobTimeoutMs = 600_000, onState = () => {}, onDiagnostic = () => {} } = {}) {
    this.profile = validateProfile(profile);
    this.jobTimeoutMs = jobTimeoutMs;
    this.onState = onState;
    this.onDiagnostic = onDiagnostic;
    this.workers = new Map();
    this.nextWorkerIndex = 0;
    this.jobs = new Map();
    this.queue = [];
    this.dispatchPaused = false;
    this.idleWaiters = new Set();
    this.closed = false;
  }

  handleUpgrade(request, socket, head, { accessTokenValidator = null } = {}) {
    const ws = acceptWebSocketUpgrade(request, socket, head, {
      path: "/worker/ws",
      maxMessageBytes: MAX_WORKER_MESSAGE_BYTES,
    });
    this.attachTransport(ws, { accessTokenValidator });
  }

  attachTransport(ws, { accessTokenValidator = null } = {}) {
    if (this.closed) throw new Error("worker pool is closed");
    if (this.workers.size >= MAX_WORKERS) throw new Error("worker limit reached");
    if (!ws || typeof ws.sendBinary !== "function" || typeof ws.close !== "function") {
      throw new Error("worker transport is invalid");
    }
    if (accessTokenValidator !== null && typeof accessTokenValidator !== "function") {
      throw new Error("worker access token validator must be a function");
    }
    this.#attach(ws, accessTokenValidator);
  }

  status() {
    return {
      engines: [...this.workers.values()].sort((left, right) => left.index - right.index).map(workerSnapshot),
      queued: this.queue.length,
      running: this.jobs.size,
      profile: this.profile,
    };
  }

  synthesize(id, text) {
    const normalizedId = String(id ?? "");
    const normalizedText = String(text ?? "");
    if (!normalizedId || !normalizedText.trim()) throw new Error("id and text are required");
    if (this.jobs.has(normalizedId) || this.queue.some((job) => job.id === normalizedId)) throw new Error("duplicate synthesis id");
    return new Promise((resolvePromise, rejectPromise) => {
      const job = {
        id: normalizedId,
        text: normalizedText,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer: null,
      };
      job.timer = setTimeout(() => this.#expireJob(job), this.jobTimeoutMs);
      this.queue.push(job);
      this.#notify();
      this.#dispatch();
    });
  }

  async cancel(id) {
    const normalizedId = String(id ?? "");
    const queuedIndex = this.queue.findIndex((job) => job.id === normalizedId);
    if (queuedIndex >= 0) {
      const [job] = this.queue.splice(queuedIndex, 1);
      this.#settleJob(job, abortError());
      this.#notify();
      return true;
    }
    const worker = this.jobs.get(normalizedId);
    if (!worker?.currentJob) return false;
    const job = worker.currentJob;
    worker.currentJob = null;
    worker.busy = true;
    if (this.jobs.get(job.id) === worker) this.jobs.delete(job.id);
    this.#settleJob(job, abortError());
    this.#notify();
    void this.#sendWithPing(worker, EngineMessageType.CANCEL, Buffer.from(JSON.stringify({ id: normalizedId }), "utf8"))
      .catch(() => {})
      .finally(() => {
        if (worker.ws.closed) return;
        worker.busy = false;
        this.#notify();
        this.#dispatch();
      });
    return true;
  }

  async reconfigure(profile) {
    const nextProfile = validateProfile(profile);
    if (nextProfile === this.profile) return this.status();
    this.dispatchPaused = true;
    await this.#waitForRunningJobs();
    this.profile = nextProfile;
    const sends = [];
    for (const worker of this.workers.values()) {
      worker.info = null;
      if (worker.authenticated && !worker.ws.closed) {
        sends.push(this.#sendWithPing(worker, EngineMessageType.CONFIG, Buffer.from(JSON.stringify({ profile: this.profile, reload: true }), "utf8")));
      }
    }
    await Promise.allSettled(sends);
    this.dispatchPaused = false;
    this.#notify();
    this.#dispatch();
    return this.status();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.queue.splice(0)) this.#settleJob(job, new Error("worker pool closed"));
    for (const worker of [...this.workers.values()]) {
      if (worker.currentJob) this.#settleRunningJob(worker, new Error("worker pool closed"));
      clearTimeout(worker.handshakeTimer);
      clearTimeout(worker.heartbeatTimer);
      this.#rejectPendingPing(worker, new Error("worker pool closed"));
      worker.ws.close(1001);
    }
    this.workers.clear();
    this.#notify();
  }

  disconnectAll(code = 1008) {
    for (const worker of this.workers.values()) {
      worker.authenticated = false;
      worker.info = null;
      worker.session = null;
      worker.ws.close(code);
    }
    this.#notify();
  }

  #attach(ws, accessTokenValidator) {
    const worker = {
      index: this.nextWorkerIndex++,
      ws,
      info: null,
      busy: false,
      currentJob: null,
      authenticated: false,
      connectedAt: Date.now(),
      lastPongAt: null,
      handshakeStage: "hello",
      handshakeTimer: null,
      heartbeatTimer: null,
      pendingPing: null,
      sendChain: Promise.resolve(),
      session: null,
      transcript: null,
      accessTokenValidator,
    };
    worker.handshakeTimer = setTimeout(() => ws.close(1008), HANDSHAKE_TIMEOUT_MS);
    this.workers.set(worker.index, worker);
    ws.onMessage = (payload) => {
      try {
        this.#acceptMessage(worker, Buffer.from(payload));
      } catch (error) {
        this.onDiagnostic({ index: worker.index, message: error instanceof Error ? error.message : String(error) });
        ws.close(1008);
      }
    };
    ws.onClose = () => {
      clearTimeout(worker.handshakeTimer);
      clearTimeout(worker.heartbeatTimer);
      this.#rejectPendingPing(worker, new Error(`worker ${worker.index} disconnected`));
      if (worker.currentJob) this.#requeueRunningJob(worker);
      this.workers.delete(worker.index);
      this.#notify();
      this.#dispatch();
    };
    this.#notify();
  }

  #acceptMessage(worker, payload) {
    if (!payload.length) throw new Error("empty worker message");
    if (!worker.authenticated) {
      this.#acceptHandshake(worker, payload);
      return;
    }
    const frame = open(worker.session, payload);
    if (frame.type === EngineMessageType.PONG) {
      this.#acceptPong(worker, frame.payload);
      return;
    }
    if (frame.type === EngineMessageType.STATUS) {
      const status = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload));
      if (String(status.profile ?? "") !== this.profile) throw new Error("worker profile mismatch");
      worker.info = {
        ready: Boolean(status.ready),
        profile: this.profile,
        backend: status.backend == null ? null : String(status.backend),
        sampleRate: Number.isSafeInteger(status.sampleRate) ? status.sampleRate : null,
        error: status.error == null ? null : String(status.error),
      };
      this.#notify();
      this.#dispatch();
      return;
    }
    if (frame.type === EngineMessageType.AUDIO_META) {
      this.#acceptAudioMeta(worker, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload)));
      return;
    }
    if (frame.type === EngineMessageType.AUDIO_CHUNK) {
      this.#acceptAudioChunk(worker, frame.payload);
      return;
    }
    if (frame.type === EngineMessageType.ERROR) {
      const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.payload));
      if (!worker.currentJob || String(message.id ?? "") !== worker.currentJob.id) return;
      this.#settleRunningJob(worker, new Error(String(message.error ?? "worker synthesis failed")));
      return;
    }
    throw new Error(`unsupported encrypted worker message type ${frame.type}`);
  }

  #acceptHandshake(worker, payload) {
    if (worker.handshakeStage === "hello") {
      const hello = decodeJson(payload, EngineMessageType.HELLO);
      if (hello.version !== 2) throw new Error("unsupported worker protocol version");
      if (worker.accessTokenValidator) {
        if (!worker.accessTokenValidator(String(hello.accessToken ?? ""))) {
          throw new Error("worker access token is invalid or expired");
        }
        worker.accessTokenValidator = null;
      }
      const clientPublicKey = decodeBase64Url(hello.publicKey, 65, "worker public key");
      const clientNonce = decodeBase64Url(hello.nonce, 32, "worker nonce");
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      const serverNonce = randomBytes(32);
      const derived = deriveSession(ecdh, clientPublicKey, clientNonce, serverNonce);
      worker.session = derived.session;
      worker.transcript = derived.transcript;
      worker.handshakeStage = "auth";
      worker.ws.sendBinary(encodeJson(EngineMessageType.HELLO_ACK, {
        version: 2,
        publicKey: derived.serverPublicKey.toString("base64url"),
        nonce: serverNonce.toString("base64url"),
        proof: proof(worker.session, "server", worker.transcript).toString("base64url"),
      }));
      return;
    }
    if (worker.handshakeStage === "auth") {
      const auth = decodeJson(payload, EngineMessageType.AUTH);
      const supplied = decodeBase64Url(auth.proof, 32, "worker proof");
      const expected = proof(worker.session, "client", worker.transcript);
      if (!timingSafeEqual(supplied, expected)) throw new Error("worker session proof mismatch");
      worker.authenticated = true;
      worker.handshakeStage = "ready";
      clearTimeout(worker.handshakeTimer);
      worker.handshakeTimer = null;
      void this.#sendWithPing(worker, EngineMessageType.CONFIG, Buffer.from(JSON.stringify({ profile: this.profile, reload: false }), "utf8"))
        .catch(() => worker.ws.close(1001));
      this.#notify();
      return;
    }
    throw new Error("invalid worker handshake stage");
  }

  #acceptPong(worker, payload) {
    const pending = worker.pendingPing;
    if (!pending || payload.length !== pending.challenge.length || !timingSafeEqual(payload, pending.challenge)) {
      throw new Error("unexpected worker PONG");
    }
    worker.pendingPing = null;
    clearTimeout(pending.timer);
    worker.lastPongAt = Date.now();
    pending.resolve();
    this.#scheduleHeartbeat(worker);
    this.#notify();
  }

  #ping(worker) {
    if (!worker.authenticated || worker.ws.closed) return Promise.reject(new Error("worker is unavailable"));
    if (worker.pendingPing) return worker.pendingPing.promise;
    clearTimeout(worker.heartbeatTimer);
    worker.heartbeatTimer = null;
    const challenge = randomBytes(16);
    let pending;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      pending = {
        challenge,
        resolve: resolvePromise,
        reject: rejectPromise,
        promise: null,
        timer: setTimeout(() => {
          if (worker.pendingPing !== pending) return;
          worker.pendingPing = null;
          rejectPromise(new Error(`worker ${worker.index} PING timed out`));
          worker.ws.close(1001);
        }, PING_TIMEOUT_MS),
      };
      worker.pendingPing = pending;
      worker.ws.sendBinary(seal(worker.session, EngineMessageType.PING, challenge));
    });
    pending.promise = promise;
    return promise;
  }

  #sendWithPing(worker, type, payload) {
    const run = worker.sendChain.catch(() => {}).then(async () => {
      await this.#ping(worker);
      if (worker.ws.closed) throw new Error("worker disconnected after PING");
      worker.ws.sendBinary(seal(worker.session, type, payload));
      this.#scheduleHeartbeat(worker);
    });
    worker.sendChain = run;
    return run;
  }

  #scheduleHeartbeat(worker) {
    clearTimeout(worker.heartbeatTimer);
    if (!worker.authenticated || worker.ws.closed || this.closed) return;
    worker.heartbeatTimer = setTimeout(() => {
      void this.#ping(worker).catch((error) => {
        this.onDiagnostic({ index: worker.index, message: error instanceof Error ? error.message : String(error) });
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  #rejectPendingPing(worker, error) {
    const pending = worker.pendingPing;
    if (!pending) return;
    worker.pendingPing = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #acceptAudioMeta(worker, message) {
    const job = worker.currentJob;
    if (!job || String(message.id ?? "") !== job.id) return;
    if (job.metadata) throw new Error("duplicate worker audio metadata");
    const sampleRate = Number(message.sampleRate);
    const sampleCount = Number(message.sampleCount);
    const byteLength = Number(message.byteLength);
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error("invalid worker sample rate");
    if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) throw new Error("invalid worker sample count");
    if (!Number.isSafeInteger(byteLength) || byteLength !== sampleCount * 4 || byteLength > MAX_AUDIO_BYTES) throw new Error("invalid worker audio byte length");
    job.metadata = { sampleRate, sampleCount, byteLength };
  }

  #acceptAudioChunk(worker, chunk) {
    const decoded = decodeAudioChunk(chunk);
    const job = worker.currentJob;
    if (!job || decoded.id !== job.id) return;
    if (!job.metadata) throw new Error("worker audio metadata is required before chunks");
    if (!decoded.chunk.length || decoded.chunk.length > AUDIO_CHUNK_BYTES) throw new Error("invalid worker audio chunk size");
    job.receivedBytes += decoded.chunk.length;
    if (job.receivedBytes > job.metadata.byteLength) throw new Error("worker audio exceeds declared length");
    job.audioChunks.push(Buffer.from(decoded.chunk));
    if (job.receivedBytes !== job.metadata.byteLength) return;
    this.#settleRunningJob(worker, null, {
      sampleRate: job.metadata.sampleRate,
      sampleCount: job.metadata.sampleCount,
      audio: Buffer.concat(job.audioChunks, job.receivedBytes),
    });
  }

  #dispatch() {
    if (this.dispatchPaused || this.closed) return;
    for (const worker of this.#readyWorkers()) {
      if (worker.busy || this.queue.length === 0) continue;
      const job = this.queue.shift();
      worker.busy = true;
      worker.currentJob = job;
      job.metadata = null;
      job.audioChunks = [];
      job.receivedBytes = 0;
      this.jobs.set(job.id, worker);
      void this.#sendWithPing(worker, EngineMessageType.SYNTH, Buffer.from(JSON.stringify({ id: job.id, text: job.text }), "utf8"))
        .catch(() => {
          if (worker.currentJob === job && !worker.ws.closed) worker.ws.close(1001);
        });
      this.#notify();
    }
  }

  #expireJob(job) {
    const queuedIndex = this.queue.indexOf(job);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.#settleJob(job, new Error(`synthesis timed out after ${this.jobTimeoutMs} ms while waiting for a trusted worker`));
      this.#notify();
      return;
    }
    const worker = this.jobs.get(job.id);
    if (worker?.currentJob === job) {
      worker.currentJob = null;
      worker.busy = true;
      if (this.jobs.get(job.id) === worker) this.jobs.delete(job.id);
      this.#settleJob(job, new Error(`synthesis timed out after ${this.jobTimeoutMs} ms`));
      this.#notify();
      void this.#sendWithPing(worker, EngineMessageType.CANCEL, Buffer.from(JSON.stringify({ id: job.id }), "utf8"))
        .catch(() => {})
        .finally(() => {
          if (worker.ws.closed) return;
          worker.busy = false;
          this.#notify();
          this.#dispatch();
        });
    }
  }

  #requeueRunningJob(worker) {
    const job = worker.currentJob;
    if (!job) return;
    worker.currentJob = null;
    worker.busy = false;
    if (this.jobs.get(job.id) === worker) this.jobs.delete(job.id);
    job.metadata = null;
    job.audioChunks = [];
    job.receivedBytes = 0;
    if (this.closed) {
      this.#settleJob(job, new Error("worker pool closed"));
    } else {
      this.queue.unshift(job);
    }
    this.#notify();
  }

  #settleRunningJob(worker, error, result = null) {
    const job = worker.currentJob;
    if (!job) return;
    worker.currentJob = null;
    worker.busy = false;
    if (this.jobs.get(job.id) === worker) this.jobs.delete(job.id);
    this.#settleJob(job, error, result);
    this.#notify();
    this.#dispatch();
  }

  #settleJob(job, error, result = null) {
    clearTimeout(job.timer);
    if (error) job.reject(error);
    else job.resolve(result);
  }

  #readyWorkers() {
    return [...this.workers.values()].filter((worker) => worker.authenticated && !worker.ws.closed && worker.info?.ready);
  }

  #notify() {
    const workers = [...this.workers.values()];
    const ready = workers.filter((worker) => worker.authenticated && worker.info?.ready && !worker.ws.closed).length;
    this.onState({
      engine: workers.length ? `Trusted Worker ${ready}/${workers.length} 準備済み` : "Trusted Worker待機中",
      model: `選択: ${this.profile}`,
      engineSlots: workers.sort((left, right) => left.index - right.index).map(workerSnapshot),
      runningJobs: this.jobs.size,
      queuedJobs: this.queue.length,
    });
    if (this.jobs.size === 0) {
      for (const resolvePromise of this.idleWaiters) resolvePromise();
      this.idleWaiters.clear();
    }
  }

  #waitForRunningJobs() {
    if (this.jobs.size === 0) return Promise.resolve();
    return new Promise((resolvePromise) => this.idleWaiters.add(resolvePromise));
  }
}

export const VOLUNTEER_WORKER_PROTOCOL = Object.freeze({
  version: 2,
  curve: "P-256",
  encryption: "AES-256-GCM",
  keyDerivation: "HKDF-SHA-256",
  pingTimeoutMs: PING_TIMEOUT_MS,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
});
