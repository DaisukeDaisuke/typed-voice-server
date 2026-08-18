export const ControlType = Object.freeze({
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  SYNTH: 0x10,
  CANCEL: 0x11,
  DISCONNECT: 0x12,
  AUDIO: 0x20,
  STATUS: 0x30,
  ERROR: 0x7f,
});

export function encodeControlFrame(type, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from([type]), Buffer.from(payload)]);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function createControlParser(onFrame, { maxFrameBytes = 64 * 1024 * 1024 } = {}) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (length < 1 || length > maxFrameBytes) throw new Error("invalid control frame length");
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      onFrame(body[0], body.subarray(1));
    }
  };
}

