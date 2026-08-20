import assert from "node:assert/strict";
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
import http from "node:http";
import test from "node:test";
import { BrowserWorkerPool, EngineMessageType } from "../server/engine-pool.mjs";

const PROTOCOL_LABEL = Buffer.from("typed-voice-volunteer-worker/v2", "utf8");

function encodeJson(type, value) {
  return Buffer.concat([Buffer.from([type]), Buffer.from(JSON.stringify(value), "utf8")]);
}

function decodeJson(payload, expectedType) {
  assert.equal(payload[0], expectedType);
  return JSON.parse(payload.subarray(1).toString("utf8"));
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
  const sequence = session.sendSeq;
  const header = Buffer.concat([Buffer.from([type]), sequenceBuffer(sequence)]);
  const cipher = createCipheriv("aes-256-gcm", session.sendKey, nonce(session.sendNoncePrefix, sequence), { authTagLength: 16 });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  session.sendSeq += 1n;
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
}

function open(session, frame) {
  const payload = Buffer.from(frame);
  assert.ok(payload.length >= 25);
  const type = payload[0];
  const sequence = payload.readBigUInt64BE(1);
  assert.equal(sequence, session.receiveSeq);
  const header = payload.subarray(0, 9);
  const ciphertext = payload.subarray(9, payload.length - 16);
  const tag = payload.subarray(payload.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", session.receiveKey, nonce(session.receiveNoncePrefix, sequence), { authTagLength: 16 });
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  session.receiveSeq += 1n;
  return { type, payload: plaintext };
}

function deriveClientSession(ecdh, serverPublicKey, clientNonce, serverNonce) {
  const clientPublicKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(serverPublicKey);
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
    transcript,
    session: {
      sendKey: material.subarray(0, 32),
      receiveKey: material.subarray(32, 64),
      sendNoncePrefix: material.subarray(64, 68),
      receiveNoncePrefix: material.subarray(68, 72),
      proofKey: material.subarray(72, 104),
      sendSeq: 0n,
      receiveSeq: 0n,
    },
  };
}

function proof(session, label, transcript) {
  return createHmac("sha256", session.proofKey)
    .update(Buffer.from(`${label}\0`, "utf8"))
    .update(transcript)
    .digest();
}

function encodeAudioChunk(id, chunk) {
  const idBytes = Buffer.from(id, "utf8");
  const header = Buffer.allocUnsafe(2);
  header.writeUInt16BE(idBytes.length, 0);
  return Buffer.concat([header, idBytes, chunk]);
}

class VolunteerClient {
  constructor(url, accessToken = null, sessionToken = null) {
    this.url = url;
    this.accessToken = accessToken;
    this.sessionToken = sessionToken;
    this.socket = null;
    this.session = null;
    this.messages = [];
    this.waiters = [];
    this.serverMessages = [];
  }

  async startReady() {
    const socket = new WebSocket(this.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const payload = Buffer.from(event.data);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(payload);
      else this.messages.push(payload);
    });
    socket.addEventListener("close", () => {
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("volunteer websocket closed"));
    });
    await new Promise((resolvePromise, rejectPromise) => {
      socket.addEventListener("open", resolvePromise, { once: true });
      socket.addEventListener("error", () => rejectPromise(new Error("volunteer websocket open failed")), { once: true });
    });

    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    const clientNonce = randomBytes(32);
    socket.send(encodeJson(EngineMessageType.HELLO, {
      version: 2,
      ...(this.accessToken ? { accessToken: this.accessToken } : {}),
      ...(this.sessionToken ? { sessionToken: this.sessionToken } : {}),
      publicKey: ecdh.getPublicKey().toString("base64url"),
      nonce: clientNonce.toString("base64url"),
    }));
    const hello = decodeJson(await this.#next(), EngineMessageType.HELLO_ACK);
    const serverPublicKey = Buffer.from(hello.publicKey, "base64url");
    const serverNonce = Buffer.from(hello.nonce, "base64url");
    const derived = deriveClientSession(ecdh, serverPublicKey, clientNonce, serverNonce);
    this.session = derived.session;
    const expectedServerProof = proof(this.session, "server", derived.transcript);
    assert.ok(timingSafeEqual(Buffer.from(hello.proof, "base64url"), expectedServerProof));
    socket.send(encodeJson(EngineMessageType.AUTH, {
      proof: proof(this.session, "client", derived.transcript).toString("base64url"),
    }));

    const config = await this.#nextApplicationMessage();
    assert.equal(config.type, EngineMessageType.CONFIG);
    const parsed = JSON.parse(config.payload.toString("utf8"));
    assert.equal(parsed.profile, "fp16");
    assert.match(this.sessionToken, /^[0-9a-f]{64}$/);
    this.#sendEncrypted(EngineMessageType.STATUS, Buffer.from(JSON.stringify({
      ready: true,
      profile: "fp16",
      backend: "test-webgpu",
      sampleRate: 24000,
    }), "utf8"));
  }

  async nextSynthesis() {
    const message = await this.#nextApplicationMessage();
    assert.equal(message.type, EngineMessageType.SYNTH);
    return JSON.parse(message.payload.toString("utf8"));
  }

  sendAudio(id, samples) {
    const audio = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    this.#sendEncrypted(EngineMessageType.AUDIO_META, Buffer.from(JSON.stringify({
      id,
      sampleRate: 24000,
      sampleCount: samples.length,
      byteLength: audio.length,
    }), "utf8"));
    this.#sendEncrypted(EngineMessageType.AUDIO_CHUNK, encodeAudioChunk(id, audio));
  }

  sendError(id, error = "worker synthesis failed") {
    this.#sendEncrypted(EngineMessageType.ERROR, Buffer.from(JSON.stringify({ id, error }), "utf8"));
  }

  close() {
    this.socket?.close();
  }

  async #nextApplicationMessage() {
    while (true) {
      const message = open(this.session, await this.#next());
      this.serverMessages.push(message.type);
      if (message.type === EngineMessageType.PING) {
        this.#sendEncrypted(EngineMessageType.PONG, message.payload);
        continue;
      }
      if (message.type === EngineMessageType.RECONNECT_TOKEN) {
        const token = message.payload.toString("ascii");
        assert.match(token, /^[0-9a-f]{64}$/);
        this.sessionToken = token;
        continue;
      }
      return message;
    }
  }

  #sendEncrypted(type, payload) {
    this.socket.send(seal(this.session, type, payload));
  }

  #next(timeoutMs = 3000) {
    if (this.messages.length) return Promise.resolve(this.messages.shift());
    return new Promise((resolvePromise, rejectPromise) => {
      const waiter = {
        resolve(value) {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject(error) {
          clearTimeout(timer);
          rejectPromise(error);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        rejectPromise(new Error("volunteer message timed out"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

async function startPoolServer(pool, accessTokenValidator = null) {
  const server = http.createServer((_request, response) => {
    response.writeHead(404, { "Content-Length": "0" });
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    try {
      pool.handleUpgrade(request, socket, head, { accessTokenValidator });
    } catch {
      socket.destroy();
    }
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  return server;
}

test("Trusted Workerは固定ページ経由では最初のHELLOで接続トークンを検証できる", async () => {
  const expectedToken = "c".repeat(128);
  let suppliedToken = null;
  const pool = new BrowserWorkerPool({ profile: "fp16", jobTimeoutMs: 5000 });
  const server = await startPoolServer(pool, (token) => {
    suppliedToken = token;
    return token === expectedToken;
  });
  const port = server.address().port;
  const worker = new VolunteerClient(`ws://127.0.0.1:${port}/worker/ws`, expectedToken);
  try {
    await worker.startReady();
    assert.equal(suppliedToken, expectedToken);
    assert.equal(pool.status().engines[0]?.authenticated, true);
  } finally {
    worker.close();
    await pool.close();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("Trusted Workerは暗号化後に受け取ったセッショントークンで再接続できる", async () => {
  const expectedToken = "d".repeat(128);
  let validationCount = 0;
  const pool = new BrowserWorkerPool({ profile: "fp16", jobTimeoutMs: 5000 });
  const server = await startPoolServer(pool, (token) => {
    validationCount += 1;
    return token === expectedToken;
  });
  const port = server.address().port;
  const first = new VolunteerClient(`ws://127.0.0.1:${port}/worker/ws`, expectedToken);
  let reconnected = null;
  let reconnectedAgain = null;
  try {
    await first.startReady();
    const sessionToken = first.sessionToken;
    first.close();

    reconnected = new VolunteerClient(
      `ws://127.0.0.1:${port}/worker/ws`,
      "expired-access-token",
      sessionToken,
    );
    await reconnected.startReady();
    assert.notEqual(reconnected.sessionToken, sessionToken);
    assert.equal(validationCount, 1);
    assert.equal(pool.status().engines.some((engine) => engine.authenticated), true);

    reconnected.close();
    reconnectedAgain = new VolunteerClient(
      `ws://127.0.0.1:${port}/worker/ws`,
      "expired-access-token",
      sessionToken,
    );
    await reconnectedAgain.startReady();
    assert.equal(validationCount, 1);
  } finally {
    first.close();
    reconnected?.close();
    reconnectedAgain?.close();
    await pool.close();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("Trusted Workerは各サーバーメッセージ前にPINGされ、脱落時は同じジョブを別Workerへ再割当する", async () => {
  const pool = new BrowserWorkerPool({ profile: "fp16", jobTimeoutMs: 5000 });
  const server = await startPoolServer(pool);
  const port = server.address().port;
  const first = new VolunteerClient(`ws://127.0.0.1:${port}/worker/ws`);
  const second = new VolunteerClient(`ws://127.0.0.1:${port}/worker/ws`);
  try {
    await first.startReady();
    await second.startReady();

    const resultPromise = pool.synthesize("12345", "再割当テスト");
    const firstRequest = await first.nextSynthesis();
    assert.equal(firstRequest.text, "再割当テスト");
    assert.match(firstRequest.id, /^cache-[0-9a-f]{32}$/);
    assert.deepEqual(first.serverMessages.slice(0, 5), [
      EngineMessageType.PING,
      EngineMessageType.RECONNECT_TOKEN,
      EngineMessageType.CONFIG,
      EngineMessageType.PING,
      EngineMessageType.SYNTH,
    ]);

    first.close();
    const secondRequest = await second.nextSynthesis();
    assert.deepEqual(secondRequest, firstRequest);
    const samples = new Float32Array([0, 0.25, -0.25, 0.5]);
    second.sendAudio(secondRequest.id, samples);

    const result = await resultPromise;
    assert.equal(result.sampleRate, 24000);
    assert.equal(result.sampleCount, samples.length);
    assert.equal(result.audio.length, samples.byteLength);
    assert.deepEqual(second.serverMessages.slice(-2), [EngineMessageType.PING, EngineMessageType.SYNTH]);
  } finally {
    first.close();
    second.close();
    await pool.close();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("完全一致queryは生成中も完成後も1回のWorker合成へ束ねる", async () => {
  const pool = new BrowserWorkerPool({ profile: "fp16", jobTimeoutMs: 5000 });
  const server = await startPoolServer(pool);
  const port = server.address().port;
  const worker = new VolunteerClient(`ws://127.0.0.1:${port}/worker/ws`);
  try {
    await worker.startReady();

    const firstResult = pool.synthesize("request-a", "同じ文章");
    const secondResult = pool.synthesize("request-b", "同じ文章");
    const request = await worker.nextSynthesis();
    assert.equal(request.text, "同じ文章");
    assert.equal(pool.status().running, 1);
    assert.equal(pool.status().queued, 0);

    const samples = new Float32Array([0.1, -0.1, 0.2]);
    worker.sendAudio(request.id, samples);
    const [first, second] = await Promise.all([firstResult, secondResult]);
    assert.deepEqual(first, second);

    const cached = await pool.synthesize("request-c", "同じ文章");
    assert.deepEqual(cached, first);
    assert.equal(pool.status().running, 0);
    assert.equal(pool.status().queued, 0);
  } finally {
    worker.close();
    await pool.close();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("共有queryのWorker失敗は全consumerへ伝播し、失敗cacheは次回再生成する", async () => {
  const pool = new BrowserWorkerPool({ profile: "fp16", jobTimeoutMs: 5000 });
  const server = await startPoolServer(pool);
  const port = server.address().port;
  const worker = new VolunteerClient(`ws://127.0.0.1:${port}/worker/ws`);
  try {
    await worker.startReady();
    const firstResult = pool.synthesize("failure-a", "失敗する文章");
    const secondResult = pool.synthesize("failure-b", "失敗する文章");
    const firstRequest = await worker.nextSynthesis();
    worker.sendError(firstRequest.id, "test failure");
    await assert.rejects(firstResult, /test failure/);
    await assert.rejects(secondResult, /test failure/);

    const retryResult = pool.synthesize("failure-c", "失敗する文章");
    const retryRequest = await worker.nextSynthesis();
    assert.notEqual(retryRequest.id, firstRequest.id);
    const samples = new Float32Array([0.3]);
    worker.sendAudio(retryRequest.id, samples);
    const retry = await retryResult;
    assert.equal(retry.sampleCount, 1);
  } finally {
    worker.close();
    await pool.close();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});

test("緊急失効では接続済みTrusted Workerを全て切断する", async () => {
  const pool = new BrowserWorkerPool({ profile: "fp16", jobTimeoutMs: 5000 });
  const server = await startPoolServer(pool);
  const port = server.address().port;
  const worker = new VolunteerClient(`ws://127.0.0.1:${port}/worker/ws`);
  try {
    await worker.startReady();
    assert.equal(pool.status().engines.length, 1);
    const closed = new Promise((resolvePromise) => worker.socket.addEventListener("close", resolvePromise, { once: true }));
    pool.disconnectAll(1008);
    await closed;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    assert.equal(pool.status().engines.length, 0);
  } finally {
    worker.close();
    await pool.close();
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
});
