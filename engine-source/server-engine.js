import "./poc.css";
import { EngineClient } from "./engine/engine-client.js";
import { requireServiceWorker } from "./app/service-worker-required.js";

const MESSAGE = Object.freeze({
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
const PROTOCOL_LABEL = new TextEncoder().encode("typed-voice-volunteer-worker/v2");
const AUDIO_CHUNK_BYTES = 64 * 1024;
const REMOTE_MANIFEST_URLS = Object.freeze({
  "mobile-int4": "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int4/typed-voice-manifest.json",
  "mobile-int8": "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/mobile-int8/typed-voice-manifest.json",
  fp16: "https://huggingface.co/RabbitDaisuke/tsukuyomichan-omnivoice-full-finetune-onnx/resolve/fp16/typed-voice-manifest.json",
});

const startButton = document.getElementById("volunteer-start");
const stopButton = document.getElementById("volunteer-stop");
const statusElement = document.getElementById("server-engine-status");
const connectionElement = document.getElementById("volunteer-connection");
const modelElement = document.getElementById("volunteer-model");
const backendElement = document.getElementById("volunteer-backend");
const appBaseUrl = new URL(import.meta.env.BASE_URL, document.baseURI).href;

let socket = null;
let session = null;
let handshake = null;
let receiveChain = Promise.resolve();
let sendChain = Promise.resolve();
let engineClient = null;
let engineInfo = null;
let currentProfile = null;
let configurationGeneration = 0;
const synthesisGenerations = new Map();

function bytes(...values) {
  const arrays = values.map((value) => value instanceof Uint8Array ? value : new Uint8Array(value));
  const total = arrays.reduce((sum, value) => sum + value.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const value of arrays) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function utf8(value) {
  return new TextEncoder().encode(String(value));
}

function decodeUtf8(value) {
  return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

function encodeBase64Url(value) {
  const raw = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < raw.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...raw.subarray(offset, Math.min(raw.byteLength, offset + chunkSize)));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const text = String(value ?? "");
  const padded = `${text.replace(/-/g, "+").replace(/_/g, "/")}${"=".repeat((4 - (text.length % 4)) % 4)}`;
  const binary = atob(padded);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function sequenceBytes(value) {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, value, false);
  return result;
}

function nonce(prefix, sequence) {
  return bytes(prefix, sequenceBytes(sequence));
}

async function sha256(...parts) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(...parts)));
}

async function hmac(keyBytes, ...parts) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes(...parts)));
}

function encodeJson(type, value) {
  return bytes(new Uint8Array([type]), utf8(JSON.stringify(value)));
}

function encodeAudioChunk(id, chunk) {
  const idBytes = utf8(id);
  if (idBytes.byteLength < 1 || idBytes.byteLength > 128) throw new Error("worker request id is invalid");
  const header = new Uint8Array(2);
  new DataView(header.buffer).setUint16(0, idBytes.byteLength, false);
  return bytes(header, idBytes, chunk);
}

function decodeJson(frame, expectedType) {
  if (frame.byteLength < 2 || frame[0] !== expectedType) throw new Error("invalid worker handshake message");
  return JSON.parse(decodeUtf8(frame.subarray(1)));
}

async function deriveSession(keyPair, clientPublicKey, clientNonce, serverPublicKey, serverNonce) {
  const serverKey = await crypto.subtle.importKey(
    "raw",
    serverPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: serverKey },
    keyPair.privateKey,
    256,
  ));
  const salt = await sha256(PROTOCOL_LABEL, clientNonce, serverNonce);
  const hkdfKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]);
  const material = new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt,
    info: PROTOCOL_LABEL,
  }, hkdfKey, 104 * 8));
  const transcript = await sha256(PROTOCOL_LABEL, clientPublicKey, serverPublicKey, clientNonce, serverNonce);
  return {
    sendKey: await crypto.subtle.importKey("raw", material.subarray(0, 32), "AES-GCM", false, ["encrypt"]),
    receiveKey: await crypto.subtle.importKey("raw", material.subarray(32, 64), "AES-GCM", false, ["decrypt"]),
    sendNoncePrefix: material.slice(64, 68),
    receiveNoncePrefix: material.slice(68, 72),
    proofKey: material.slice(72, 104),
    transcript,
    sendSeq: 0n,
    receiveSeq: 0n,
  };
}

async function seal(type, payload = new Uint8Array()) {
  if (!session) throw new Error("worker session is unavailable");
  const sequence = session.sendSeq;
  const header = bytes(new Uint8Array([type]), sequenceBytes(sequence));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({
    name: "AES-GCM",
    iv: nonce(session.sendNoncePrefix, sequence),
    additionalData: header,
    tagLength: 128,
  }, session.sendKey, payload));
  session.sendSeq += 1n;
  return bytes(header, encrypted);
}

async function open(frame) {
  if (!session || frame.byteLength < 25) throw new Error("encrypted worker frame is invalid");
  const type = frame[0];
  const sequence = new DataView(frame.buffer, frame.byteOffset + 1, 8).getBigUint64(0, false);
  if (sequence !== session.receiveSeq) throw new Error("worker frame sequence mismatch");
  const header = frame.subarray(0, 9);
  const payload = new Uint8Array(await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: nonce(session.receiveNoncePrefix, sequence),
    additionalData: header,
    tagLength: 128,
  }, session.receiveKey, frame.subarray(9)));
  session.receiveSeq += 1n;
  return { type, payload };
}

function sendPlain(frame) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("worker websocket is not open");
  socket.send(frame);
}

function sendSecure(type, payload = new Uint8Array()) {
  const task = sendChain.then(async () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("worker websocket is not open");
    socket.send(await seal(type, payload));
  });
  sendChain = task.catch(() => {});
  return task;
}

function sendSecureJson(type, value) {
  return sendSecure(type, utf8(JSON.stringify(value)));
}

function updateParticipationUi(participating) {
  startButton.hidden = participating;
  stopButton.hidden = !participating;
  startButton.disabled = false;
}

function setStatus(message) {
  statusElement.textContent = message;
}

async function prepareServiceWorker() {
  try {
    await requireServiceWorker({ reloadKey: "typed-voice-volunteer-worker-coi-reloaded" });
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function startParticipation() {
  startButton.disabled = true;
  setStatus("参加用の暗号化セッションを準備しています。");
  await prepareServiceWorker();
  if (!navigator.gpu) throw new Error("このブラウザではWebGPUを利用できません。");

  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const clientPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const clientNonce = crypto.getRandomValues(new Uint8Array(32));
  handshake = { keyPair, clientPublicKey, clientNonce };
  session = null;
  receiveChain = Promise.resolve();
  sendChain = Promise.resolve();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/worker/ws`);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    connectionElement.textContent = "鍵交換中";
    sendPlain(encodeJson(MESSAGE.HELLO, {
      version: 2,
      publicKey: encodeBase64Url(clientPublicKey),
      nonce: encodeBase64Url(clientNonce),
    }));
  });
  socket.addEventListener("message", (event) => {
    const frame = event.data instanceof ArrayBuffer
      ? new Uint8Array(event.data)
      : ArrayBuffer.isView(event.data)
        ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
        : new Uint8Array(event.data);
    receiveChain = receiveChain.then(() => acceptServerMessage(frame)).catch((error) => {
      setStatus(`Worker通信エラー: ${error instanceof Error ? error.message : String(error)}`);
      socket?.close(1008);
    });
  });
  socket.addEventListener("close", () => {
    connectionElement.textContent = "切断";
    updateParticipationUi(false);
    socket = null;
    session = null;
    handshake = null;
    void disposeEngine();
  });
  socket.addEventListener("error", () => {
    setStatus("Worker WebSocketへ接続できませんでした。");
  });
  updateParticipationUi(true);
}

async function acceptServerMessage(frame) {
  if (!session) {
    if (!handshake) throw new Error("unexpected handshake message");
    const hello = decodeJson(frame, MESSAGE.HELLO_ACK);
    if (hello.version !== 2) throw new Error("unsupported server worker protocol version");
    const serverPublicKey = decodeBase64Url(hello.publicKey);
    const serverNonce = decodeBase64Url(hello.nonce);
    const suppliedProof = decodeBase64Url(hello.proof);
    if (serverPublicKey.byteLength !== 65 || serverNonce.byteLength !== 32 || suppliedProof.byteLength !== 32) {
      throw new Error("server worker handshake fields are invalid");
    }
    session = await deriveSession(
      handshake.keyPair,
      handshake.clientPublicKey,
      handshake.clientNonce,
      serverPublicKey,
      serverNonce,
    );
    const expectedServerProof = await hmac(session.proofKey, utf8("server\0"), session.transcript);
    if (!sameBytes(suppliedProof, expectedServerProof)) throw new Error("server worker proof verification failed");
    const clientProof = await hmac(session.proofKey, utf8("client\0"), session.transcript);
    sendPlain(encodeJson(MESSAGE.AUTH, { proof: encodeBase64Url(clientProof) }));
    connectionElement.textContent = "暗号化セッション確立中";
    return;
  }

  const message = await open(frame);
  if (message.type === MESSAGE.PING) {
    await sendSecure(MESSAGE.PONG, message.payload);
    connectionElement.textContent = "接続中";
    return;
  }
  if (message.type === MESSAGE.CONFIG) {
    const config = JSON.parse(decodeUtf8(message.payload));
    const profile = String(config.profile ?? "");
    if (!["fp32", "fp16", "mobile-int8", "mobile-int4"].includes(profile)) throw new Error("unsupported model profile");
    currentProfile = profile;
    modelElement.textContent = profile;
    connectionElement.textContent = "参加中";
    void configureEngine(profile, Boolean(config.reload));
    return;
  }
  if (message.type === MESSAGE.SYNTH) {
    const request = JSON.parse(decodeUtf8(message.payload));
    void synthesizeForServer(String(request.id ?? ""), String(request.text ?? ""));
    return;
  }
  if (message.type === MESSAGE.CANCEL) {
    const request = JSON.parse(decodeUtf8(message.payload));
    void cancelForServer(String(request.id ?? ""));
    return;
  }
  throw new Error(`unsupported server message ${message.type}`);
}

async function configureEngine(profile, reload) {
  const generation = ++configurationGeneration;
  const previousClient = engineClient;
  engineClient = null;
  engineInfo = null;
  synthesisGenerations.clear();
  if (previousClient) await previousClient.dispose().catch(() => previousClient.abort());
  if (!socket || socket.readyState !== WebSocket.OPEN || !session || generation !== configurationGeneration) return;
  currentProfile = profile;
  modelElement.textContent = profile;
  engineInfo = null;
  backendElement.textContent = "初期化中";
  const manifestUrl = REMOTE_MANIFEST_URLS[profile]
    || new URL("voice-manifest.json", appBaseUrl).href;
  try {
    setStatus(`音声データを準備しています (${profile})。`);
    const client = new EngineClient({
      manifestUrl,
      appBaseUrl,
      onProgress(message) {
        if (generation !== configurationGeneration) return;
        if (message.stage === "download") {
          const loaded = Number(message.loadedBytes || 0);
          const total = Number(message.totalBytes || 0);
          const percentage = total > 0 ? ((loaded / total) * 100).toFixed(1) : "?";
          setStatus(`取得・検証: ${message.assetId || "asset"} ${(loaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MiB (${percentage}%)`);
        } else if (message.stage === "initialize") {
          setStatus(`エンジン初期化: ${message.phase}${message.backend ? ` (${message.backend})` : ""}`);
        } else if (message.stage === "generate") {
          setStatus(`音声生成: step ${message.step}/${message.numStep}`);
        }
      },
    });
    engineClient = client;
    await client.prepare(0);
    if (generation !== configurationGeneration || engineClient !== client) {
      await client.dispose().catch(() => client.abort());
      return;
    }
    const info = await client.initialize(0);
    if (generation !== configurationGeneration || engineClient !== client) {
      await client.dispose().catch(() => client.abort());
      return;
    }
    engineInfo = info;
    backendElement.textContent = info.backend || "ready";
    setStatus("参加中です。音声合成要求を待っています。");
    await sendSecureJson(MESSAGE.STATUS, {
      ready: true,
      profile,
      backend: info.backend ?? null,
      sampleRate: info.sampleRate ?? null,
      error: null,
    });
  } catch (error) {
    if (generation !== configurationGeneration) return;
    engineInfo = null;
    backendElement.textContent = "初期化失敗";
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`起動失敗: ${message}`);
    if (socket?.readyState === WebSocket.OPEN && session) {
      await sendSecureJson(MESSAGE.STATUS, {
        ready: false,
        profile,
        backend: null,
        sampleRate: null,
        error: message,
      }).catch(() => {});
    }
  }
}

async function synthesizeForServer(id, text) {
  if (!id || !text.trim()) return sendSecureJson(MESSAGE.ERROR, { id, error: "id and text are required" });
  const client = engineClient;
  if (!client || !engineInfo) return sendSecureJson(MESSAGE.ERROR, { id, error: "worker engine is not ready" });
  const generation = (synthesisGenerations.get(id) ?? 0) + 1;
  synthesisGenerations.set(id, generation);
  try {
    const result = await client.synthesize({
      utteranceId: id,
      generation,
      text,
      options: { language: "ja", speed: 1 },
    });
    if (synthesisGenerations.get(id) !== generation) return;
    const audio = new Uint8Array(result.samples.buffer, result.samples.byteOffset, result.samples.byteLength);
    await sendSecureJson(MESSAGE.AUDIO_META, {
      id,
      sampleRate: result.sampleRate,
      sampleCount: result.samples.length,
      byteLength: audio.byteLength,
    });
    for (let offset = 0; offset < audio.byteLength; offset += AUDIO_CHUNK_BYTES) {
      if (synthesisGenerations.get(id) !== generation) return;
      await sendSecure(MESSAGE.AUDIO_CHUNK, encodeAudioChunk(id, audio.slice(offset, Math.min(audio.byteLength, offset + AUDIO_CHUNK_BYTES))));
    }
    synthesisGenerations.delete(id);
    setStatus("参加中です。音声合成要求を待っています。");
  } catch (error) {
    if (synthesisGenerations.get(id) !== generation) return;
    synthesisGenerations.delete(id);
    await sendSecureJson(MESSAGE.ERROR, {
      id,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
  }
}

async function cancelForServer(id) {
  const generation = synthesisGenerations.get(id);
  if (!generation || !engineClient) return;
  synthesisGenerations.delete(id);
  await engineClient.cancel(id, generation).catch(() => {});
}

async function disposeEngine() {
  configurationGeneration += 1;
  const client = engineClient;
  engineClient = null;
  engineInfo = null;
  currentProfile = null;
  synthesisGenerations.clear();
  modelElement.textContent = "未選択";
  backendElement.textContent = "未初期化";
  if (client) await client.dispose().catch(() => client.abort());
}

async function stopParticipation() {
  updateParticipationUi(false);
  connectionElement.textContent = "終了中";
  const currentSocket = socket;
  socket = null;
  session = null;
  handshake = null;
  if (currentSocket && currentSocket.readyState <= WebSocket.OPEN) currentSocket.close(1000);
  await disposeEngine();
  connectionElement.textContent = "未接続";
  setStatus("参加していません。");
}

startButton.addEventListener("click", () => {
  void startParticipation().catch((error) => {
    updateParticipationUi(false);
    setStatus(error instanceof Error ? error.message : String(error));
  });
});
stopButton.addEventListener("click", () => void stopParticipation());
