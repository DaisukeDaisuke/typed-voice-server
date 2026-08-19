import { createReadStream, createWriteStream } from "node:fs";

const DEFAULT_MAX_LINE_BYTES = 2 * 1024 * 1024;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export class StdioPeer {
  constructor(input, output, {
    onRequest = async () => { throw new Error("unsupported stdio request"); },
    onEvent = () => {},
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  } = {}) {
    if (!input || typeof input.on !== "function") throw new Error("stdio input stream is required");
    if (!output || typeof output.write !== "function") throw new Error("stdio output stream is required");
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1024) throw new Error("invalid stdio line limit");
    this.input = input;
    this.output = output;
    this.onRequest = onRequest;
    this.onEvent = onEvent;
    this.maxLineBytes = maxLineBytes;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    input.setEncoding("utf8");
    input.on("data", (chunk) => this.#accept(chunk));
    input.on("end", () => this.close(new Error("stdio peer closed")));
    input.on("error", (error) => this.close(error));
  }

  request(method, params = null) {
    if (this.closed) return Promise.reject(new Error("stdio peer is closed"));
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      try {
        this.#write({ kind: "request", id, method: String(method), params });
      } catch (error) {
        this.pending.delete(id);
        rejectPromise(error);
      }
    });
  }

  event(type, payload = null) {
    if (this.closed) return false;
    this.#write({ kind: "event", type: String(type), payload });
    return true;
  }

  close(error = new Error("stdio peer closed")) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  #write(message) {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) throw new Error("stdio message exceeds line limit");
    this.output.write(line);
  }

  #accept(chunk) {
    if (this.closed) return;
    this.buffer += String(chunk);
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxLineBytes * 2) {
      this.close(new Error("stdio receive buffer exceeds limit"));
      return;
    }
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/u, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
        this.close(new Error("stdio line exceeds limit"));
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.close(new Error("invalid stdio JSON"));
        return;
      }
      void this.#dispatch(message);
    }
  }

  async #dispatch(message) {
    if (!message || typeof message !== "object") return;
    if (message.kind === "response" && Number.isSafeInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(String(message.error ?? "stdio request failed")));
      return;
    }
    if (message.kind === "event" && typeof message.type === "string") {
      try { this.onEvent(message.type, message.payload); } catch {}
      return;
    }
    if (message.kind !== "request" || !Number.isSafeInteger(message.id) || typeof message.method !== "string") return;
    try {
      const result = await this.onRequest(message.method, message.params);
      this.#write({ kind: "response", id: message.id, ok: true, result });
    } catch (error) {
      this.#write({ kind: "response", id: message.id, ok: false, error: errorMessage(error).slice(0, 4096) });
    }
  }
}

export function createFdStdioPeer(options = {}) {
  const input = createReadStream(null, { fd: 0, autoClose: false });
  const output = createWriteStream(null, { fd: 1, autoClose: false });
  return new StdioPeer(input, output, options);
}
