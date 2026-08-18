import {
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  AudioFlags,
  AudioFormat,
  ModelProfileFromCode,
  Opcode,
  VERSION,
  decryptFrame,
  encryptFrame,
  randomId,
} from "../worker/protocol.mjs";

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

function proofInput(label, audioFormat, clientNonce, serverNonce) {
  return Buffer.concat([
    Buffer.from(label, "utf8"),
    Buffer.from([VERSION, audioFormat]),
    clientNonce,
    serverNonce,
  ]);
}

function derive(key, salt, info, length) {
  return Buffer.from(hkdfSync("sha256", key, salt, Buffer.from(info, "utf8"), length));
}

function createMessageQueue(socket) {
  const queued = [];
  const waiters = [];
  let closedError = null;
  socket.addEventListener("message", (event) => {
    const value = event.data instanceof ArrayBuffer
      ? Buffer.from(event.data)
      : ArrayBuffer.isView(event.data)
        ? Buffer.from(event.data.buffer, event.data.byteOffset, event.data.byteLength)
        : Buffer.from(event.data);
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(value);
    else queued.push(value);
  });
  socket.addEventListener("close", () => {
    closedError = new Error("probe websocket closed");
    for (const waiter of waiters.splice(0)) waiter.reject(closedError);
  });
  return function next(timeoutMs = 30_000) {
    if (queued.length) return Promise.resolve(queued.shift());
    if (closedError) return Promise.reject(closedError);
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
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        rejectPromise(new Error(`probe websocket message timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
}

async function openWebSocket(url, timeoutMs = 10_000) {
  if (typeof WebSocket !== "function") throw new Error("Node.js 22 or newer is required for websocket probes");
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      try { socket.close(); } catch {}
      rejectPromise(new Error(`websocket open timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolvePromise();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      rejectPromise(new Error("websocket open failed"));
    }, { once: true });
  });
  return socket;
}

export async function probeRemoteEndpoint({
  endpoint,
  authKey,
  encryptionKey,
  expectedModelProfile,
  text = "疎通確認",
  timeoutMs = 90_000,
}) {
  const socket = await openWebSocket(endpoint, 15_000);
  const next = createMessageQueue(socket);
  const audioFormat = AudioFormat.FLOAT32LE;
  try {
    const clientNonce = randomBytes(32);
    socket.send(Buffer.concat([
      Buffer.from([Opcode.HELLO_CLIENT, VERSION, audioFormat, 0]),
      clientNonce,
    ]));
    const hello = await next(15_000);
    if (hello.length !== 68 || hello[0] !== Opcode.HELLO_SERVER || hello[1] !== VERSION || hello[2] !== audioFormat || hello[3] !== 0) {
      throw new Error("remote probe received an invalid server HELLO");
    }
    const serverNonce = hello.subarray(4, 36);
    const expectedServerProof = hmac(authKey, proofInput("server", audioFormat, clientNonce, serverNonce));
    if (!timingSafeEqual(hello.subarray(36, 68), expectedServerProof)) throw new Error("remote probe server HMAC verification failed");
    const salt = Buffer.concat([clientNonce, serverNonce]);
    const session = {
      sendKey: derive(encryptionKey, salt, "typed-voice-remote/v1/c2s/key", 32),
      receiveKey: derive(encryptionKey, salt, "typed-voice-remote/v1/s2c/key", 32),
      sendNoncePrefix: derive(encryptionKey, salt, "typed-voice-remote/v1/c2s/nonce", 4),
      receiveNoncePrefix: derive(encryptionKey, salt, "typed-voice-remote/v1/s2c/nonce", 4),
      sendSeq: 0n,
      receiveSeq: 0n,
    };
    const clientProof = hmac(authKey, proofInput("client", audioFormat, clientNonce, serverNonce));
    socket.send(Buffer.concat([
      Buffer.from([Opcode.AUTH, VERSION, audioFormat, 0]),
      clientProof,
    ]));

    let configSeen = false;
    let pingSeen = false;
    while (!configSeen || !pingSeen) {
      const frame = decryptFrame(session, await next(15_000));
      if (frame.op === Opcode.SERVER_CONFIG) {
        if (frame.payload.length !== 1) throw new Error("remote probe model config payload is invalid");
        const modelProfile = ModelProfileFromCode[frame.payload[0]];
        if (modelProfile !== expectedModelProfile) throw new Error(`remote probe model config mismatch: ${modelProfile}`);
        configSeen = true;
        continue;
      }
      if (frame.op === Opcode.PING) {
        socket.send(encryptFrame(session, { op: Opcode.PONG, id: frame.id }));
        pingSeen = true;
        continue;
      }
      throw new Error(`unexpected encrypted opcode during probe auth: ${frame.op}`);
    }

    const requestId = randomId();
    socket.send(encryptFrame(session, {
      op: Opcode.TEXT,
      id: requestId,
      payload: Buffer.from(text, "utf8"),
    }));
    const deadline = Date.now() + timeoutMs;
    let metadata = null;
    let audioBytes = 0;
    while (Date.now() < deadline) {
      const frame = decryptFrame(session, await next(Math.max(1000, deadline - Date.now())));
      if (frame.op === Opcode.PING) {
        socket.send(encryptFrame(session, { op: Opcode.PONG, id: frame.id }));
        continue;
      }
      if (frame.op === Opcode.ERROR && frame.id === requestId) {
        throw new Error(`remote synthesis probe failed: ${frame.payload.subarray(2).toString("utf8")}`);
      }
      if (frame.op !== Opcode.AUDIO || frame.id !== requestId) continue;
      let audio = frame.payload;
      if (frame.flags & AudioFlags.START) {
        if (frame.payload.length < 10) throw new Error("remote probe AUDIO START metadata is truncated");
        metadata = {
          format: frame.payload[0],
          channels: frame.payload[1],
          sampleRate: frame.payload.readUInt32BE(2),
          sampleCount: frame.payload.readUInt32BE(6),
        };
        audio = frame.payload.subarray(10);
      }
      audioBytes += audio.length;
      if (frame.flags & AudioFlags.END) {
        if (!metadata || metadata.format !== audioFormat || metadata.channels !== 1 || metadata.sampleCount < 1) {
          throw new Error("remote probe received invalid audio metadata");
        }
        if (audioBytes !== metadata.sampleCount * 4) throw new Error("remote probe audio byte length mismatch");
        return { ...metadata, audioBytes };
      }
    }
    throw new Error("remote synthesis probe timed out");
  } finally {
    try { socket.close(); } catch {}
  }
}
