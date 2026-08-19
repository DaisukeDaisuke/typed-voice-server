import { CodexSandboxProcess } from "./codex-sandbox-launcher.mjs";
import { DirectWorkerProcess } from "./direct-worker-process.mjs";
import { StdioPeer } from "./stdio-peer.mjs";

export class SandboxWorkerClient {
  constructor(config, {
    onRequest = async () => { throw new Error("sandbox child request is unsupported"); },
    onEvent = () => {},
    onStderr = () => {},
    onExit = () => {},
    onFailure = () => {},
  } = {}) {
    this.onRequest = onRequest;
    this.onEvent = onEvent;
    this.peer = null;
    const ProcessBackend = config.backend === "direct-test" ? DirectWorkerProcess : CodexSandboxProcess;
    this.process = new ProcessBackend(config, {
      onStderr,
      onExit: (code, signal) => {
        this.peer?.close(new Error(`sandbox worker exited (${signal ?? code ?? "unknown"})`));
        onExit(code, signal);
      },
      onFailure: (error) => {
        this.peer?.close(error);
        onFailure(error);
      },
    });
  }

  async start() {
    const child = await this.process.start();
    this.peer = new StdioPeer(child.stdout, child.stdin, {
      onEvent: (type, payload) => this.onEvent(type, payload),
      onRequest: (method, params) => this.onRequest(method, params),
    });
    return this;
  }

  request(method, params = null) {
    if (!this.peer) return Promise.reject(new Error("sandbox worker is not started"));
    return this.peer.request(method, params);
  }

  event(type, payload = null) {
    if (!this.peer) throw new Error("sandbox worker is not started");
    return this.peer.event(type, payload);
  }

  async close() {
    this.peer?.close(new Error("sandbox worker closed"));
    this.peer = null;
    await this.process.close();
  }
}
