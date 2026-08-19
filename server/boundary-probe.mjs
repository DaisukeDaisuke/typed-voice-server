import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";

const REMOTE_HELLO_CLIENT = 0xf0;
const REMOTE_AUTH = 0xf2;
const REMOTE_VERSION = 1;
const REMOTE_PCM16LE = 1;

function validatePort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("probe port must be 1..65535");
  return port;
}

function validateTimeout(value) {
  const timeoutMs = Number(value);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw new Error("invalid probe timeout");
  return timeoutMs;
}

function maskedBinaryFrame(payload) {
  const bytes = Buffer.from(payload);
  if (bytes.length > 125) throw new Error("probe websocket payload is too large");
  const mask = randomBytes(4);
  const result = Buffer.allocUnsafe(2 + 4 + bytes.length);
  result[0] = 0x82;
  result[1] = 0x80 | bytes.length;
  mask.copy(result, 2);
  for (let index = 0; index < bytes.length; index += 1) result[6 + index] = bytes[index] ^ mask[index & 3];
  return result;
}

function serverFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (buffer[1] & 0x80) throw new Error("server probe websocket frame must not be masked");
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const bigLength = buffer.readBigUInt64BE(2);
    if (bigLength > 4096n) throw new Error("server probe websocket frame is too large");
    length = Number(bigLength);
    offset = 10;
  }
  if (buffer.length < offset + length) return null;
  return {
    opcode,
    payload: buffer.subarray(offset, offset + length),
    bytesConsumed: offset + length,
  };
}

async function assertHttpAuthenticationDenied(port, { path, body, timeoutMs }) {
  await new Promise((resolvePromise, rejectPromise) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        "Content-Type": "text/plain;charset=UTF-8",
        "Content-Length": String(Buffer.byteLength(body)),
      },
    }, (response) => {
      response.resume();
      response.once("end", () => {
        if (response.statusCode === 404) resolvePromise();
        else rejectPromise(new Error(`sibling capability probe unexpectedly reached ${path}: status=${response.statusCode}`));
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("probe timeout")));
    request.once("error", (error) => {
      if (["EACCES", "ECONNREFUSED", "ENETUNREACH", "EPERM"].includes(error?.code)) resolvePromise();
      else rejectPromise(error);
    });
    request.end(body);
  });
}

async function assertRemoteAuthenticationDenied(port, timeoutMs) {
  await new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    let phase = "handshake";
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const timer = setTimeout(() => finish(new Error("remote sibling authentication probe timed out")), timeoutMs);
    socket.once("connect", () => {
      const key = randomBytes(16).toString("base64");
      socket.write([
        "GET /remote HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${key}`,
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (chunk) => {
      try {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        if (phase === "handshake") {
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const head = buffer.subarray(0, end).toString("latin1");
          if (!/^HTTP\/1\.1 101 /u.test(head)) return finish(new Error("remote sibling probe websocket upgrade was not accepted"));
          buffer = buffer.subarray(end + 4);
          const hello = Buffer.alloc(36);
          hello[0] = REMOTE_HELLO_CLIENT;
          hello[1] = REMOTE_VERSION;
          hello[2] = REMOTE_PCM16LE;
          randomBytes(32).copy(hello, 4);
          socket.write(maskedBinaryFrame(hello));
          phase = "hello";
        }
        while (phase !== "handshake") {
          const frame = serverFrame(buffer);
          if (!frame) return;
          buffer = buffer.subarray(frame.bytesConsumed);
          if (phase === "hello") {
            if (frame.opcode !== 0x2) return finish(new Error("remote sibling probe did not receive server hello"));
            const auth = Buffer.alloc(36);
            auth[0] = REMOTE_AUTH;
            auth[1] = REMOTE_VERSION;
            auth[2] = REMOTE_PCM16LE;
            socket.write(maskedBinaryFrame(auth));
            phase = "auth";
            continue;
          }
          if (phase === "auth") {
            if (frame.opcode === 0x8) return finish();
            return finish(new Error("remote sibling probe remained usable after invalid 256-bit authentication proof"));
          }
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.once("close", () => {
      if (phase === "auth") finish();
      else if (!settled) finish(new Error("remote sibling probe closed before authentication was tested"));
    });
    socket.once("error", (error) => {
      if (["EACCES", "ECONNREFUSED", "ENETUNREACH", "EPERM"].includes(error?.code)) finish();
      else if (phase === "auth") finish();
      else finish(error);
    });
  });
}

export async function assertSiblingRoleAuthenticationDenied(portValue, roleValue, { timeoutMs = 1500 } = {}) {
  const port = validatePort(portValue);
  const role = String(roleValue ?? "");
  const timeout = validateTimeout(timeoutMs);
  if (role === "admin") {
    await assertHttpAuthenticationDenied(port, { path: "/admin/session", body: "0".repeat(64), timeoutMs: timeout });
    return true;
  }
  if (role === "worker") {
    await assertHttpAuthenticationDenied(port, { path: "/worker/reset", body: "0".repeat(128), timeoutMs: timeout });
    return true;
  }
  if (role === "remote") {
    await assertRemoteAuthenticationDenied(port, timeout);
    return true;
  }
  throw new Error(`unsupported sibling capability probe role: ${role}`);
}
