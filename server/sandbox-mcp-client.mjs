import { CodexSandboxProcess } from "./codex-sandbox-launcher.mjs";

export class SandboxedMcpClient {
  constructor(config, { onStderr = () => {}, onExit = () => {}, onFailure = () => {} } = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.process = new CodexSandboxProcess(config, {
      onStdout: (chunk) => this.#acceptStdout(chunk),
      onStderr,
      onExit: (code, signal) => {
        this.#rejectAll(new Error("sandboxed MCP exited"));
        onExit(code, signal);
      },
      onFailure: (error) => {
        this.#rejectAll(error);
        onFailure(error);
      },
    });
  }

  async start() {
    await this.process.start();
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "typed-voice-server", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      this.process.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.process.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async callTool(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    if (result?.isError) {
      const detail = result.structuredContent?.error ?? result.content?.[0]?.text ?? `${name} failed`;
      throw new Error(String(detail));
    }
    return result?.structuredContent ?? result;
  }

  async close() {
    await this.process.close();
    this.#rejectAll(new Error("sandboxed MCP closed"));
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
      try { message = JSON.parse(line); } catch { continue; }
      if (!Object.hasOwn(message, "id")) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "MCP error"));
      else pending.resolve(message.result);
    }
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
