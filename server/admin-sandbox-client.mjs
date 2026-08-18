import { CodexSandboxProcess } from "./codex-sandbox-launcher.mjs";

export class AdminSandboxClient {
  constructor(config, {
    onDisconnect = () => {},
    onSnapshotRequest = () => {},
    onHistoryGet = () => {},
    onHistorySubscribe = () => {},
    onHistoryUnsubscribe = () => {},
    onDebugEval = () => {},
    onModelSet = () => {},
    onStderr = () => {},
    onExit = () => {},
    onFailure = () => {},
  } = {}) {
    this.onDisconnect = onDisconnect;
    this.onSnapshotRequest = onSnapshotRequest;
    this.onHistoryGet = onHistoryGet;
    this.onHistorySubscribe = onHistorySubscribe;
    this.onHistoryUnsubscribe = onHistoryUnsubscribe;
    this.onDebugEval = onDebugEval;
    this.onModelSet = onModelSet;
    this.stdoutBuffer = "";
    this.readyPromise = null;
    this.resolveReady = null;
    this.rejectReady = null;
    this.process = new CodexSandboxProcess(config, {
      onStdout: (chunk) => this.#acceptStdout(chunk),
      onStderr,
      onExit: (code, signal) => {
        this.rejectReady?.(new Error(`admin sandbox exited (${signal ?? code ?? "unknown"})`));
        onExit(code, signal);
      },
      onFailure: (error) => {
        this.rejectReady?.(error);
        onFailure(error);
      },
    });
  }

  async start(timeoutMs = 15_000) {
    this.readyPromise = new Promise((resolvePromise, rejectPromise) => {
      this.resolveReady = resolvePromise;
      this.rejectReady = rejectPromise;
    });
    await this.process.start();
    const timeout = setTimeout(() => this.rejectReady?.(new Error("admin sandbox did not report its localhost port")), timeoutMs);
    try {
      return await this.readyPromise;
    } finally {
      clearTimeout(timeout);
      this.resolveReady = null;
      this.rejectReady = null;
    }
  }

  send(message) {
    this.process.write(`${JSON.stringify(message)}\n`);
  }

  async close() {
    await this.process.close();
  }

  #acceptStdout(chunk) {
    this.stdoutBuffer += String(chunk);
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "ready" && Number.isSafeInteger(message.port) && message.port > 0 && message.port <= 65535) {
        this.resolveReady?.(message.port);
        continue;
      }
      if (message.type === "fatal") {
        const error = new Error(String(message.message ?? "admin sandbox failed to start"));
        error.code = String(message.code ?? "ADMIN_START_FAILED");
        this.rejectReady?.(error);
        continue;
      }
      if (message.type === "disconnect") {
        this.onDisconnect(message.connectionId);
        continue;
      }
      if (message.type === "snapshot-request") this.onSnapshotRequest();
      if (message.type === "history-get") {
        this.onHistoryGet(message.requestId, message.conversationId);
        continue;
      }
      if (message.type === "history-subscribe") {
        this.onHistorySubscribe(message.conversationId);
        continue;
      }
      if (message.type === "history-unsubscribe") this.onHistoryUnsubscribe(message.conversationId);
      if (message.type === "debug-eval") this.onDebugEval(message.requestId, message.slot, message.expression);
      if (message.type === "model-set") this.onModelSet(message.requestId, message.modelProfile);
    }
  }
}
