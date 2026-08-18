import { createHash } from "node:crypto";

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function websocketAccept(key) {
  return createHash("sha1").update(`${key}${WS_MAGIC}`).digest("base64");
}

export function acceptWebSocketUpgrade(request, socket, head, { path = "/remote", maxMessageBytes = 1024 * 1024 } = {}) {
  if (request.method !== "GET" || request.url !== path) throw new Error("invalid websocket path");
  if (String(request.headers.upgrade ?? "").toLowerCase() !== "websocket") throw new Error("missing websocket upgrade");
  const connection = String(request.headers.connection ?? "").toLowerCase().split(",").map((value) => value.trim());
  if (!connection.includes("upgrade")) throw new Error("invalid websocket connection header");
  if (request.headers["sec-websocket-version"] !== "13") throw new Error("unsupported websocket version");
  const key = String(request.headers["sec-websocket-key"] ?? "");
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) throw new Error("invalid websocket key");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
    "\r\n",
  ].join("\r\n"));
  return new RawWebSocket(socket, { head, maxMessageBytes });
}

export class RawWebSocket {
  constructor(socket, { head = Buffer.alloc(0), maxMessageBytes = 1024 * 1024 } = {}) {
    this.socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.buffer = Buffer.from(head);
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.closed = false;
    this.onMessage = () => {};
    this.onClose = () => {};
    socket.on("data", (chunk) => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.#drain();
      } catch {
        this.close(1002);
      }
    });
    socket.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.onClose();
    });
    socket.on("error", () => this.close(1002));
    if (this.buffer.length) queueMicrotask(() => {
      try { this.#drain(); } catch { this.close(1002); }
    });
  }

  sendBinary(payload) {
    if (this.closed) return false;
    return this.socket.write(encodeServerFrame(0x2, Buffer.from(payload)));
  }

  close(code = 1000) {
    if (this.closed) return;
    this.closed = true;
    const payload = Buffer.allocUnsafe(2);
    payload.writeUInt16BE(code, 0);
    try { this.socket.end(encodeServerFrame(0x8, payload)); } catch { this.socket.destroy(); }
    this.onClose();
  }

  #drain() {
    while (true) {
      const frame = parseClientFrame(this.buffer, this.maxMessageBytes);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.bytesConsumed);
      if (frame.opcode === 0x8) {
        this.close(1000);
        return;
      }
      if (frame.opcode === 0x9) {
        this.socket.write(encodeServerFrame(0xA, frame.payload));
        continue;
      }
      if (frame.opcode === 0xA) continue;
      if (frame.opcode === 0x0) {
        if (this.fragmentOpcode === null) throw new Error("unexpected continuation");
        this.fragments.push(frame.payload);
        this.fragmentBytes += frame.payload.length;
        if (this.fragmentBytes > this.maxMessageBytes) throw new Error("message too large");
        if (frame.fin) {
          const payload = Buffer.concat(this.fragments, this.fragmentBytes);
          const opcode = this.fragmentOpcode;
          this.fragmentOpcode = null;
          this.fragments = [];
          this.fragmentBytes = 0;
          if (opcode !== 0x2) throw new Error("text websocket messages are not supported");
          this.onMessage(payload);
        }
        continue;
      }
      if (frame.opcode !== 0x2) throw new Error("only binary websocket messages are supported");
      if (this.fragmentOpcode !== null) throw new Error("fragment already active");
      if (frame.fin) this.onMessage(frame.payload);
      else {
        this.fragmentOpcode = frame.opcode;
        this.fragments = [frame.payload];
        this.fragmentBytes = frame.payload.length;
      }
    }
  }
}

function parseClientFrame(buffer, maxMessageBytes) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = Boolean(first & 0x80);
  const rsv = first & 0x70;
  const opcode = first & 0x0f;
  if (rsv) throw new Error("RSV bits are unsupported");
  if (!(second & 0x80)) throw new Error("client websocket frames must be masked");
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const bigLength = buffer.readBigUInt64BE(2);
    if (bigLength > BigInt(maxMessageBytes)) throw new Error("message too large");
    length = Number(bigLength);
    offset = 10;
  }
  if (length > maxMessageBytes) throw new Error("message too large");
  if ([0x8, 0x9, 0xA].includes(opcode) && (!fin || length > 125)) throw new Error("invalid control frame");
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) payload[index] = buffer[offset + index] ^ mask[index & 3];
  return { fin, opcode, payload, bytesConsumed: offset + length };
}

function encodeServerFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

