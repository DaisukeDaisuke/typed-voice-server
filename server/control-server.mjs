import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { ControlType, createControlParser, encodeControlFrame } from "../worker/control-protocol.mjs";
import { listenOnRandomHighPort } from "../worker/high-port.mjs";

function idBuffer(id) {
  const result = Buffer.allocUnsafe(8);
  result.writeBigUInt64BE(id, 0);
  return result;
}

export class WorkerControlServer {
  constructor({ key, pool, onHistory = () => {}, onState = () => {}, onWorkerStatus = () => {} }) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("control key must be 32 bytes");
    this.key = key;
    this.pool = pool;
    this.onHistory = onHistory;
    this.onState = onState;
    this.onWorkerStatus = onWorkerStatus;
    this.server = null;
    this.socket = null;
    this.port = 0;
    this.authenticated = false;
  }

  async start() {
    const server = net.createServer((socket) => this.#attach(socket));
    await listenOnRandomHighPort(server);
    this.server = server;
    this.port = server.address().port;
    return this.port;
  }

  #attach(socket) {
    if (this.socket && !this.socket.destroyed) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    this.authenticated = false;
    const parser = createControlParser((type, payload) => {
      if (!this.authenticated) {
        if (type !== ControlType.HELLO || payload.length !== this.key.length || !timingSafeEqual(payload, this.key)) {
          socket.destroy();
          return;
        }
        this.authenticated = true;
        socket.write(encodeControlFrame(ControlType.HELLO_ACK));
        this.onState({ control: "接続済み" });
        return;
      }
      this.#handle(type, payload);
    });
    socket.on("data", (chunk) => {
      try { parser(chunk); } catch (error) { socket.destroy(error); }
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.authenticated = false;
        this.onState({ control: "切断" });
      }
    });
  }

  #handle(type, payload) {
    if (type === ControlType.STATUS) {
      try {
        const status = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
        this.onWorkerStatus(status);
      } catch {}
      return;
    }
    if (type === ControlType.SYNTH) {
      if (payload.length < 11 || payload.length > 16 * 1024 + 8 + 2 + 128) return;
      const id = payload.readBigUInt64BE(0);
      const conversationLength = payload.readUInt16BE(8);
      if (conversationLength > 128 || payload.length < 10 + conversationLength + 1) {
        this.#sendError(id, "BAD_TEXT");
        return;
      }
      let conversationId = null;
      let text;
      try {
        if (conversationLength > 0) {
          conversationId = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(10, 10 + conversationLength));
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(conversationId)) throw new Error("invalid conversation id");
        }
        text = new TextDecoder("utf-8", { fatal: true }).decode(payload.subarray(10 + conversationLength));
      }
      catch { this.#sendError(id, "BAD_TEXT"); return; }
      if (!text.trim()) { this.#sendError(id, "BAD_TEXT"); return; }
      const startedAt = Date.now();
      this.onHistory({
        phase: "request",
        conversationId,
        requestId: id.toString(),
        text,
        at: startedAt,
      });
      void this.pool.synthesize(id.toString(), text).then((audio) => {
        const header = Buffer.allocUnsafe(16);
        header.writeBigUInt64BE(id, 0);
        header.writeUInt32BE(audio.sampleRate, 8);
        header.writeUInt32BE(audio.sampleCount, 12);
        this.#send(ControlType.AUDIO, Buffer.concat([header, audio.audio]));
        this.onHistory({
          phase: "result",
          conversationId,
          requestId: id.toString(),
          ok: true,
          durationMs: Date.now() - startedAt,
          at: Date.now(),
        });
      }).catch((error) => {
        this.#sendError(id, error instanceof Error ? error.message : String(error));
        this.onHistory({
          phase: "result",
          conversationId,
          requestId: id.toString(),
          ok: false,
          cancelled: error?.name === "AbortError",
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
          at: Date.now(),
        });
      });
      return;
    }
    if (type === ControlType.CANCEL) {
      if (payload.length !== 8) return;
      const id = payload.readBigUInt64BE(0);
      void this.pool.cancel(id.toString()).catch(() => {});
    }
  }

  disconnect(connectionId) {
    const normalized = String(connectionId ?? "").toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(normalized)) return false;
    return this.#send(ControlType.DISCONNECT, Buffer.from(normalized, "hex"));
  }

  #sendError(id, message) {
    this.#send(ControlType.ERROR, Buffer.concat([idBuffer(id), Buffer.from(String(message).slice(0, 1024), "utf8")]));
  }

  #send(type, payload = Buffer.alloc(0)) {
    if (!this.authenticated || !this.socket || this.socket.destroyed) return false;
    return this.socket.write(encodeControlFrame(type, payload));
  }

  async close() {
    this.socket?.destroy();
    this.socket = null;
    this.authenticated = false;
    if (this.server?.listening) await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
    this.port = 0;
  }
}

