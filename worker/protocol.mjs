import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const VERSION = 1;
export const HEADER_BYTES = 20;
export const AUTH_DEADLINE_MS = 20_000;
export const HEARTBEAT_INTERVAL_MS = 90_000;
export const HEARTBEAT_TIMEOUT_MS = 20_000;

export const Opcode = Object.freeze({
  PING: 0x01,
  PONG: 0x02,
  SESSION: 0x03,
  SERVER_CONFIG: 0x04,
  WORKER_STATUS: 0x05,
  TEXT: 0x10,
  CANCEL: 0x11,
  AUDIO: 0x20,
  ERROR: 0x7f,
  HELLO_CLIENT: 0xf0,
  HELLO_SERVER: 0xf1,
  AUTH: 0xf2,
});

export const ModelProfileCode = Object.freeze({
  fp32: 1,
  fp16: 2,
  "mobile-int8": 3,
  "mobile-int4": 4,
});

export const ModelProfileFromCode = Object.freeze({
  1: "fp32",
  2: "fp16",
  3: "mobile-int8",
  4: "mobile-int4",
});

export const AudioFormat = Object.freeze({ PCM16LE: 1, FLOAT32LE: 2 });
export const AudioFlags = Object.freeze({ START: 1, END: 2 });

function concat(...parts) {
  return Buffer.concat(parts.map((part) => Buffer.isBuffer(part) ? part : Buffer.from(part)));
}

function proofInput(label, audioFormat, clientNonce, serverNonce) {
  return concat(Buffer.from(label, "utf8"), Buffer.from([VERSION, audioFormat]), clientNonce, serverNonce);
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

function derive(key, salt, info, length) {
  return Buffer.from(hkdfSync("sha256", key, salt, Buffer.from(info, "utf8"), length));
}

export function acceptClientHello(frame, authKey, encryptionKey, { clientBanSalt = null } = {}) {
  const bytes = Buffer.from(frame);
  if (bytes.length !== 36 || bytes[0] !== Opcode.HELLO_CLIENT || bytes[1] !== VERSION || bytes[3] !== 0) {
    throw new Error("invalid client hello");
  }
  const audioFormat = bytes[2];
  if (![AudioFormat.PCM16LE, AudioFormat.FLOAT32LE].includes(audioFormat)) throw new Error("unsupported audio format");
  const clientNonce = bytes.subarray(4, 36);
  const serverNonce = randomBytes(32);
  const banSalt = clientBanSalt == null ? null : Buffer.from(clientBanSalt);
  if (banSalt && banSalt.length !== 32) throw new Error("client ban salt must be 32 bytes");
  const serverProofBase = proofInput("server", audioFormat, clientNonce, serverNonce);
  const serverProof = hmac(authKey, banSalt ? concat(serverProofBase, banSalt) : serverProofBase);
  const hello = concat(
    Buffer.from([Opcode.HELLO_SERVER, VERSION, audioFormat, banSalt ? 1 : 0]),
    serverNonce,
    serverProof,
    banSalt ?? Buffer.alloc(0),
  );
  const salt = concat(clientNonce, serverNonce);
  const session = {
    audioFormat,
    receiveKey: derive(encryptionKey, salt, "typed-voice-remote/v1/c2s/key", 32),
    sendKey: derive(encryptionKey, salt, "typed-voice-remote/v1/s2c/key", 32),
    receiveNoncePrefix: derive(encryptionKey, salt, "typed-voice-remote/v1/c2s/nonce", 4),
    sendNoncePrefix: derive(encryptionKey, salt, "typed-voice-remote/v1/s2c/nonce", 4),
    receiveSeq: 0n,
    sendSeq: 0n,
    expectedClientProof: hmac(authKey, proofInput("client", audioFormat, clientNonce, serverNonce)),
    clientProofInput: proofInput("client", audioFormat, clientNonce, serverNonce),
    authKey: Buffer.from(authKey),
  };
  return { hello, session };
}

export function readClientAuth(frame, session) {
  const bytes = Buffer.from(frame);
  if (![36, 68].includes(bytes.length) || bytes[0] !== Opcode.AUTH || bytes[1] !== VERSION || bytes[2] !== session.audioFormat || bytes[3] !== 0) {
    return { valid: false, clientHash: null };
  }
  const clientHashBytes = bytes.length === 68 ? bytes.subarray(36, 68) : null;
  const expectedProof = clientHashBytes
    ? hmac(session.authKey, concat(session.clientProofInput, clientHashBytes))
    : session.expectedClientProof;
  const valid = timingSafeEqual(bytes.subarray(4, 36), expectedProof);
  return {
    valid,
    clientHash: valid && clientHashBytes ? clientHashBytes.toString("hex") : null,
  };
}

export function verifyClientAuth(frame, session) {
  return readClientAuth(frame, session).valid;
}

function nonce(prefix, seq) {
  const result = Buffer.allocUnsafe(12);
  prefix.copy(result, 0);
  result.writeBigUInt64BE(seq, 4);
  return result;
}

function createHeader(op, flags, seq, id) {
  const result = Buffer.alloc(HEADER_BYTES);
  result[0] = VERSION;
  result[1] = op;
  result[2] = flags;
  result[3] = 0;
  result.writeBigUInt64BE(seq, 4);
  result.writeBigUInt64BE(id, 12);
  return result;
}

export function encryptFrame(session, { op, flags = 0, id = 0n, payload = Buffer.alloc(0) }) {
  if (session.sendSeq > 0xffffffffffffffffn) throw new Error("send seq exhausted");
  const seq = session.sendSeq;
  const header = createHeader(op, flags, seq, id);
  const cipher = createCipheriv("aes-256-gcm", session.sendKey, nonce(session.sendNoncePrefix, seq), { authTagLength: 16 });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  const tag = cipher.getAuthTag();
  session.sendSeq += 1n;
  return concat(header, ciphertext, tag);
}

export function decryptFrame(session, frame) {
  const bytes = Buffer.from(frame);
  if (bytes.length < HEADER_BYTES + 16) throw new Error("encrypted frame too short");
  const header = bytes.subarray(0, HEADER_BYTES);
  if (header[0] !== VERSION || header[3] !== 0) throw new Error("invalid encrypted header");
  const seq = header.readBigUInt64BE(4);
  if (seq !== session.receiveSeq) throw new Error("unexpected receive seq");
  const id = header.readBigUInt64BE(12);
  const tag = bytes.subarray(bytes.length - 16);
  const ciphertext = bytes.subarray(HEADER_BYTES, bytes.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", session.receiveKey, nonce(session.receiveNoncePrefix, seq), { authTagLength: 16 });
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const payload = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  session.receiveSeq += 1n;
  return { op: header[1], flags: header[2], seq, id, payload };
}

export function randomId() {
  return randomBytes(8).readBigUInt64BE(0);
}

