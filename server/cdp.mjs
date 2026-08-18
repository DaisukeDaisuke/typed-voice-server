function protocolError(method, error) {
  const result = new Error(`${method}: ${error?.message ?? "Unknown CDP error"}`);
  result.code = error?.code;
  return result;
}

export class CdpClient {
  constructor(url, { onClose = () => {}, onEvent = () => {}, onProtocolError = () => {} } = {}) {
    this.url = url;
    this.onClose = onClose;
    this.onEvent = onEvent;
    this.onProtocolError = onProtocolError;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect(timeoutMs = 10_000) {
    if (typeof WebSocket !== "function") throw new Error("Node.js 22 or newer is required");
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP connection timed out")), timeoutMs);
      socket.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("CDP connection failed")); }, { once: true });
    });
    socket.addEventListener("message", (event) => this.#onMessage(event.data));
    socket.addEventListener("close", () => {
      this.#rejectPending(new Error("CDP connection closed"));
      this.onClose();
    });
  }

  #onMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === "string" ? data : String(data));
    } catch (error) {
      this.onProtocolError(new Error(`invalid CDP message: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (!Object.hasOwn(message, "id")) {
      this.onEvent(String(message.method ?? ""), message.params ?? {});
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) pending.reject(protocolError(pending.method, message.error));
    else pending.resolve(message.result ?? {});
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs = 30_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CDP is not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
    this.socket = null;
    this.#rejectPending(new Error("CDP closed"));
  }
}

