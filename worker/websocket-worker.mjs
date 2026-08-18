import http from "node:http";
import net from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH_DEADLINE_MS,
  AudioFlags,
  AudioFormat,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  ModelProfileCode,
  Opcode,
  acceptClientHello,
  decryptFrame,
  encryptFrame,
  randomId,
  verifyClientAuth,
} from "./protocol.mjs";
import { ControlType, createControlParser, encodeControlFrame } from "./control-protocol.mjs";
import { acceptWebSocketUpgrade } from "./websocket.mjs";
import { listenOnRandomHighPort } from "./high-port.mjs";

const modulePath = fileURLToPath(import.meta.url);
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(modulePath);
const MAX_TEXT_BYTES = 16 * 1024;
const AUDIO_CHUNK_BYTES = 64 * 1024;

function decodeKey(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${label} must be base64url`);
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32) throw new Error(`${label} must decode to 32 bytes`);
  return key;
}

function errorPayload(code, message) {
  const text = Buffer.from(String(message ?? ""), "utf8");
  const result = Buffer.allocUnsafe(2 + text.length);
  result.writeUInt16BE(code, 0);
  text.copy(result, 2);
  return result;
}

function float32ToPcm16(floatBytes, sampleCount) {
  if (floatBytes.length !== sampleCount * 4) throw new Error("float32 audio length mismatch");
  const result = Buffer.allocUnsafe(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.max(-1, Math.min(1, floatBytes.readFloatLE(index * 4)));
    const value = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    result.writeInt16LE(value, index * 2);
  }
  return result;
}

class WorkerRuntime {
  constructor() {
    this.server = null;
    this.publicPort = 0;
    this.authKey = null;
    this.encryptionKey = null;
    this.modelProfile = "fp16";
    this.control = null;
    this.controlParser = null;
    this.controlReady = false;
    this.clients = new Set();
    this.pending = new Map();
  }

  async start({ publicPort = null, controlPort, controlKey, authKey, encryptionKey, modelProfile = "fp16" }) {
    if (this.server) throw new Error("worker is already running");
    if (publicPort !== null && (!Number.isSafeInteger(publicPort) || publicPort < 49152 || publicPort > 65535)) throw new Error("publicPort must be 49152..65535");
    if (!Number.isSafeInteger(controlPort) || controlPort < 1 || controlPort > 65535) throw new Error("controlPort must be 1..65535");
    const rawControlKey = decodeKey(controlKey, "controlKey");
    this.authKey = decodeKey(authKey, "authKey");
    this.encryptionKey = decodeKey(encryptionKey, "encryptionKey");
    this.modelProfile = this.#normalizeModelProfile(modelProfile);
    try {
      await this.#connectControl(controlPort, rawControlKey);
      const server = http.createServer((request, response) => {
        if (request.method === "GET" && request.url === "/health") {
          response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
          response.end("ok");
          return;
        }
        response.writeHead(404, { "content-length": "0" });
        response.end();
      });
      server.on("upgrade", (request, socket, head) => {
        try {
          const ws = acceptWebSocketUpgrade(request, socket, head, { path: "/remote", maxMessageBytes: 1024 * 1024 });
          this.#attachClient(ws);
        } catch {
          socket.destroy();
        }
      });
      if (publicPort === null) await listenOnRandomHighPort(server);
      else await new Promise((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(publicPort, "127.0.0.1", resolvePromise);
      });
      this.server = server;
      this.publicPort = server.address().port;
      return this.status();
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  status() {
    let authenticatedClients = 0;
    for (const client of this.clients) if (client.authenticated) authenticatedClients += 1;
    return {
      running: Boolean(this.server?.listening),
      publicPort: this.publicPort,
      controlReady: this.controlReady,
      modelProfile: this.modelProfile,
      clients: this.clients.size,
      authenticatedClients,
      pendingRequests: this.pending.size,
      sessions: [...this.clients]
        .filter((client) => client.authenticated)
        .map((client) => ({
          connectionId: client.connectionId,
          conversationId: client.conversationId,
          connectedAt: client.connectedAt,
          lastSeenAt: client.lastSeenAt,
          requests: client.requests,
          pending: [...this.pending.values()].filter((owner) => owner === client).length,
        })),
    };
  }

  setConfig({ modelProfile }) {
    this.modelProfile = this.#normalizeModelProfile(modelProfile);
    for (const client of this.clients) {
      if (client.authenticated) this.#sendServerConfig(client);
    }
    return { modelProfile: this.modelProfile };
  }

  #emitStatus() {
    if (!this.controlReady || !this.control || this.control.destroyed) return;
    const status = this.status();
    const publicStatus = {
      clients: status.clients,
      authenticatedClients: status.authenticatedClients,
      pendingRequests: status.pendingRequests,
      sessions: status.sessions,
    };
    this.#sendControl(ControlType.STATUS, Buffer.from(JSON.stringify(publicStatus), "utf8"));
  }

  async stop() {
    for (const client of [...this.clients]) client.ws.close(1001);
    this.clients.clear();
    this.pending.clear();
    if (this.server?.listening) await new Promise((resolvePromise) => this.server.close(resolvePromise));
    this.server = null;
    this.publicPort = 0;
    this.controlReady = false;
    this.control?.destroy();
    this.control = null;
    this.controlParser = null;
    this.authKey = null;
    this.encryptionKey = null;
    this.modelProfile = "fp16";
  }

  async #connectControl(port, key) {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    this.control = socket;
    const ready = new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("control authentication timed out")), 5000);
      const fail = (error) => {
        clearTimeout(timer);
        rejectPromise(error instanceof Error ? error : new Error("control connection failed"));
      };
      socket.once("error", fail);
      this.controlParser = createControlParser((type, payload) => {
        if (!this.controlReady) {
          if (type !== ControlType.HELLO_ACK || payload.length !== 0) {
            fail(new Error("invalid control hello acknowledgement"));
            return;
          }
          clearTimeout(timer);
          socket.off("error", fail);
          this.controlReady = true;
          resolvePromise();
          this.#emitStatus();
          return;
        }
        this.#handleControlFrame(type, payload);
      });
      socket.on("data", (chunk) => {
        try { this.controlParser(chunk); } catch (error) { socket.destroy(error); }
      });
      socket.on("close", () => {
        this.controlReady = false;
        for (const client of [...this.clients]) client.ws.close(1011);
      });
      socket.once("connect", () => socket.write(encodeControlFrame(ControlType.HELLO, key)));
    });
    await ready;
  }

  #attachClient(ws) {
    const client = {
      ws,
      connectionId: randomId().toString(16).padStart(16, "0"),
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      conversationId: null,
      requests: 0,
      stage: "hello",
      session: null,
      authenticated: false,
      authTimer: null,
      heartbeatTimer: null,
      pongTimer: null,
      pendingPing: null,
    };
    this.clients.add(client);
    this.#emitStatus();
    client.authTimer = setTimeout(() => ws.close(1008), AUTH_DEADLINE_MS);
    ws.onMessage = (payload) => {
      try { this.#handleClientMessage(client, payload); } catch { ws.close(1008); }
    };
    ws.onClose = () => this.#dropClient(client);
  }

  #dropClient(client) {
    if (!this.clients.delete(client)) return;
    clearTimeout(client.authTimer);
    clearTimeout(client.heartbeatTimer);
    clearTimeout(client.pongTimer);
    for (const [id, owner] of [...this.pending]) {
      if (owner !== client) continue;
      this.pending.delete(id);
      this.#sendControl(ControlType.CANCEL, idBuffer(BigInt(id)));
    }
    this.#emitStatus();
  }

  #handleClientMessage(client, payload) {
    if (client.stage === "hello") {
      const accepted = acceptClientHello(payload, this.authKey, this.encryptionKey);
      client.session = accepted.session;
      client.stage = "auth";
      client.ws.sendBinary(accepted.hello);
      return;
    }
    if (client.stage === "auth") {
      if (!verifyClientAuth(payload, client.session)) throw new Error("authentication failed");
      clearTimeout(client.authTimer);
      client.authTimer = null;
      client.authenticated = true;
      client.stage = "ready";
      this.#emitStatus();
      this.#sendServerConfig(client);
      this.#sendPing(client);
      return;
    }
    if (client.stage !== "ready") throw new Error("invalid client stage");
    const frame = decryptFrame(client.session, payload);
    client.lastSeenAt = Date.now();
    if (frame.op === Opcode.PONG) {
      if (client.pendingPing === null || frame.id !== client.pendingPing) throw new Error("unexpected pong");
      client.pendingPing = null;
      clearTimeout(client.pongTimer);
      client.pongTimer = null;
      client.heartbeatTimer = setTimeout(() => this.#sendPing(client), HEARTBEAT_INTERVAL_MS);
      return;
    }
    if (frame.op === Opcode.SESSION) {
      if (frame.id !== 0n || frame.payload.length < 1 || frame.payload.length > 128) throw new Error("invalid session frame");
      const conversationId = new TextDecoder("utf-8", { fatal: true }).decode(frame.payload).trim();
      if (!conversationId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(conversationId)) throw new Error("invalid conversation id");
      client.conversationId = conversationId;
      this.#emitStatus();
      return;
    }
    if (frame.op === Opcode.TEXT) {
      if (frame.payload.length < 1 || frame.payload.length > MAX_TEXT_BYTES) throw new Error("invalid text length");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(frame.payload);
      if (!text.trim()) throw new Error("empty text");
      const key = frame.id.toString();
      if (this.pending.has(key)) throw new Error("duplicate request id");
      client.requests += 1;
      this.pending.set(key, client);
      this.#emitStatus();
      const conversationBytes = Buffer.from(client.conversationId ?? "", "utf8");
      const conversationLength = Buffer.allocUnsafe(2);
      conversationLength.writeUInt16BE(conversationBytes.length, 0);
      this.#sendControl(ControlType.SYNTH, Buffer.concat([
        idBuffer(frame.id),
        conversationLength,
        conversationBytes,
        Buffer.from(text, "utf8"),
      ]));
      return;
    }
    if (frame.op === Opcode.CANCEL) {
      const key = frame.id.toString();
      if (this.pending.get(key) === client) {
        this.pending.delete(key);
        this.#sendControl(ControlType.CANCEL, idBuffer(frame.id));
        this.#sendEncrypted(client, { op: Opcode.ERROR, id: frame.id, payload: errorPayload(6, "CANCELLED") });
        this.#emitStatus();
      }
      return;
    }
    throw new Error("unsupported client opcode");
  }

  #sendPing(client) {
    if (!client.authenticated || client.ws.closed) return;
    const id = randomId();
    client.pendingPing = id;
    this.#sendEncrypted(client, { op: Opcode.PING, id });
    client.pongTimer = setTimeout(() => client.ws.close(1001), HEARTBEAT_TIMEOUT_MS);
  }

  #sendEncrypted(client, message) {
    client.ws.sendBinary(encryptFrame(client.session, message));
  }

  #sendServerConfig(client) {
    this.#sendEncrypted(client, {
      op: Opcode.SERVER_CONFIG,
      payload: Buffer.from([ModelProfileCode[this.modelProfile]]),
    });
  }

  #normalizeModelProfile(value) {
    const profile = String(value ?? "");
    if (!["fp32", "fp16", "mobile-int8", "mobile-int4"].includes(profile)) throw new Error("invalid model profile");
    return profile;
  }

  #sendControl(type, payload) {
    if (!this.controlReady || !this.control || this.control.destroyed) throw new Error("control channel is unavailable");
    this.control.write(encodeControlFrame(type, payload));
  }

  #handleControlFrame(type, payload) {
    if (type === ControlType.DISCONNECT) {
      if (payload.length !== 8) return;
      const connectionId = payload.toString("hex");
      const client = [...this.clients].find((entry) => entry.connectionId === connectionId);
      client?.ws.close(1008);
      return;
    }
    if (type === ControlType.AUDIO) {
      if (payload.length < 16) return;
      const id = payload.readBigUInt64BE(0);
      const sampleRate = payload.readUInt32BE(8);
      const sampleCount = payload.readUInt32BE(12);
      const floatBytes = payload.subarray(16);
      const key = id.toString();
      const client = this.pending.get(key);
      if (!client || !client.authenticated) return;
      this.pending.delete(key);
      try { this.#sendAudio(client, id, sampleRate, sampleCount, floatBytes); }
      catch { client.ws.close(1011); }
      this.#emitStatus();
      return;
    }
    if (type === ControlType.ERROR) {
      if (payload.length < 8) return;
      const id = payload.readBigUInt64BE(0);
      const key = id.toString();
      const client = this.pending.get(key);
      if (!client || !client.authenticated) return;
      this.pending.delete(key);
      const message = payload.subarray(8).toString("utf8") || "SYNTH_FAILED";
      this.#sendEncrypted(client, { op: Opcode.ERROR, id, payload: errorPayload(5, message) });
      this.#emitStatus();
    }
  }

  #sendAudio(client, id, sampleRate, sampleCount, floatBytes) {
    if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error("invalid sample rate");
    if (!Number.isSafeInteger(sampleCount) || sampleCount < 0 || floatBytes.length !== sampleCount * 4) throw new Error("invalid sample count");
    const audio = client.session.audioFormat === AudioFormat.PCM16LE
      ? float32ToPcm16(floatBytes, sampleCount)
      : Buffer.from(floatBytes);
    const metadata = Buffer.allocUnsafe(10);
    metadata[0] = client.session.audioFormat;
    metadata[1] = 1;
    metadata.writeUInt32BE(sampleRate, 2);
    metadata.writeUInt32BE(sampleCount, 6);
    let offset = 0;
    const firstAudioBytes = Math.min(audio.length, AUDIO_CHUNK_BYTES - metadata.length);
    let flags = AudioFlags.START;
    if (firstAudioBytes === audio.length) flags |= AudioFlags.END;
    this.#sendEncrypted(client, {
      op: Opcode.AUDIO,
      flags,
      id,
      payload: Buffer.concat([metadata, audio.subarray(0, firstAudioBytes)]),
    });
    offset = firstAudioBytes;
    while (offset < audio.length) {
      const end = Math.min(audio.length, offset + AUDIO_CHUNK_BYTES);
      this.#sendEncrypted(client, {
        op: Opcode.AUDIO,
        flags: end === audio.length ? AudioFlags.END : 0,
        id,
        payload: audio.subarray(offset, end),
      });
      offset = end;
    }
  }
}

function idBuffer(id) {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(id, 0);
  return buffer;
}

const runtime = new WorkerRuntime();

const tools = [{
  name: "start",
  title: "Start typed-voice websocket worker",
  description: "Starts the loopback-only public origin listener and authenticated binary control channel.",
  inputSchema: {
    type: "object",
    required: ["controlPort", "controlKey", "authKey", "encryptionKey"],
    properties: {
      publicPort: { type: "integer", minimum: 49152, maximum: 65535 },
      controlPort: { type: "integer", minimum: 1, maximum: 65535 },
      controlKey: { type: "string" },
      authKey: { type: "string" },
      encryptionKey: { type: "string" },
      modelProfile: { type: "string", enum: ["fp32", "fp16", "mobile-int8", "mobile-int4"] },
    },
    additionalProperties: false,
  },
}, {
  name: "set_config",
  title: "Update typed-voice websocket worker config",
  description: "Updates encrypted client-visible server configuration without exposing pairing keys.",
  inputSchema: {
    type: "object",
    required: ["modelProfile"],
    properties: {
      modelProfile: { type: "string", enum: ["fp32", "fp16", "mobile-int8", "mobile-int4"] },
    },
    additionalProperties: false,
  },
}, {
  name: "status",
  title: "typed-voice websocket worker status",
  description: "Returns listener/client counts without returning pairing keys.",
  inputSchema: { type: "object", additionalProperties: false },
  annotations: { readOnlyHint: true },
}, {
  name: "stop",
  title: "Stop typed-voice websocket worker",
  description: "Stops the loopback listener, control channel, and active clients.",
  inputSchema: { type: "object", additionalProperties: false },
}];

function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function response(id, result) { return { jsonrpc: "2.0", id, result }; }
function protocolError(id, code, message) { return { jsonrpc: "2.0", id: id ?? null, error: { code, message } }; }

export function createMcpServer() {
  let initialized = false;
  return async (request) => {
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") return protocolError(request?.id, -32600, "Invalid Request");
    if (request.method === "notifications/initialized") return null;
    if (request.method === "initialize") {
      initialized = true;
      return response(request.id, {
        protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "typed-voice-websocket-worker", version: "1.0.0" },
      });
    }
    if (!initialized) return protocolError(request.id, -32002, "Server not initialized");
    if (request.method === "ping") return response(request.id, {});
    if (request.method === "tools/list") return response(request.id, { tools });
    if (request.method === "tools/call") {
      try {
        const name = request.params?.name;
        const args = request.params?.arguments ?? {};
        if (name === "start") return response(request.id, toolResult(await runtime.start(args)));
        if (name === "set_config") return response(request.id, toolResult(runtime.setConfig(args)));
        if (name === "status") return response(request.id, toolResult(runtime.status()));
        if (name === "stop") {
          await runtime.stop();
          return response(request.id, toolResult(runtime.status()));
        }
        throw new Error(`Unknown tool: ${name}`);
      } catch (error) {
        return response(request.id, toolResult({ ok: false, error: error instanceof Error ? error.message : String(error) }, true));
      }
    }
    return protocolError(request.id, -32601, "Method not found");
  };
}

export async function startStdio(input = process.stdin, output = process.stdout) {
  const handle = createMcpServer();
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let request;
      try { request = JSON.parse(line); }
      catch {
        output.write(`${JSON.stringify(protocolError(null, -32700, "Parse error"))}\n`);
        continue;
      }
      void handle(request).then((reply) => {
        if (reply) output.write(`${JSON.stringify(reply)}\n`);
      });
    }
  });
}

if (directExecution) await startStdio();

