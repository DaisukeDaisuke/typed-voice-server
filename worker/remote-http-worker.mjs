import { RemoteClientHub } from "../server/remote-hub.mjs";
import { OrchestratorHttpServer } from "../server/orchestrator-http.mjs";
import { createFdStdioPeer } from "../server/stdio-peer.mjs";

const MAX_AUDIO_BYTES = 256 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024;

function abortError() {
  const error = new Error("Synthesis cancelled");
  error.name = "AbortError";
  return error;
}

function decode32(value, label) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9_-]{43}$/u.test(text)) throw new Error(`${label} must be 32-byte base64url`);
  const result = Buffer.from(text, "base64url");
  if (result.length !== 32) throw new Error(`${label} must decode to 32 bytes`);
  return result;
}

function validateJobId(value) {
  const id = String(value ?? "");
  if (!/^[0-9]{1,20}$/u.test(id)) throw new Error("invalid synthesis id");
  return id;
}

class ParentWorkerPool {
  constructor() {
    this.pending = new Map();
    this.workerStatus = { engines: [], queued: 0, running: 0, profile: null };
  }

  status() {
    return this.workerStatus;
  }

  setStatus(status) {
    if (!status || typeof status !== "object" || !Array.isArray(status.engines)) throw new Error("invalid worker status");
    this.workerStatus = status;
  }

  synthesize(id, text) {
    const normalizedId = validateJobId(id);
    const normalizedText = String(text ?? "");
    if (!normalizedText.trim() || Buffer.byteLength(normalizedText, "utf8") > 16 * 1024) throw new Error("invalid synthesis text");
    if (this.pending.has(normalizedId)) throw new Error("duplicate synthesis id");
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(normalizedId, {
        resolve: resolvePromise,
        reject: rejectPromise,
        metadata: null,
        chunks: [],
        received: 0,
      });
      peer.event("synth-request", { id: normalizedId, text: normalizedText });
    });
  }

  async cancel(id) {
    const normalizedId = validateJobId(id);
    const pending = this.pending.get(normalizedId);
    if (pending) {
      this.pending.delete(normalizedId);
      pending.reject(abortError());
    }
    peer.event("synth-cancel", { id: normalizedId });
    return Boolean(pending);
  }

  accept(type, payload) {
    const id = validateJobId(payload?.id);
    const pending = this.pending.get(id);
    if (!pending) return;
    if (type === "synth-start") {
      const sampleRate = Number(payload?.sampleRate);
      const sampleCount = Number(payload?.sampleCount);
      const byteLength = Number(payload?.byteLength);
      if (pending.metadata) throw new Error("duplicate synthesis metadata");
      if (!Number.isSafeInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) throw new Error("invalid synthesis sample rate");
      if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) throw new Error("invalid synthesis sample count");
      if (!Number.isSafeInteger(byteLength) || byteLength !== sampleCount * 4 || byteLength > MAX_AUDIO_BYTES) throw new Error("invalid synthesis byte length");
      pending.metadata = { sampleRate, sampleCount, byteLength };
      return;
    }
    if (type === "synth-chunk") {
      if (!pending.metadata) throw new Error("synthesis metadata is required before audio");
      const encoded = String(payload?.data ?? "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new Error("invalid synthesis base64 chunk");
      const chunk = Buffer.from(encoded, "base64");
      if (!chunk.length || chunk.length > MAX_CHUNK_BYTES) throw new Error("invalid synthesis chunk size");
      pending.received += chunk.length;
      if (pending.received > pending.metadata.byteLength) throw new Error("synthesis audio exceeds declared length");
      pending.chunks.push(chunk);
      return;
    }
    if (type === "synth-end") {
      if (!pending.metadata || pending.received !== pending.metadata.byteLength) throw new Error("incomplete synthesis audio");
      this.pending.delete(id);
      pending.resolve({
        sampleRate: pending.metadata.sampleRate,
        sampleCount: pending.metadata.sampleCount,
        audio: Buffer.concat(pending.chunks, pending.received),
      });
      return;
    }
    if (type === "synth-error") {
      this.pending.delete(id);
      const error = new Error(String(payload?.error ?? "synthesis failed"));
      if (payload?.cancelled) error.name = "AbortError";
      pending.reject(error);
    }
  }

  close() {
    for (const pending of this.pending.values()) pending.reject(new Error("remote worker closed"));
    this.pending.clear();
  }
}

const parentPool = new ParentWorkerPool();
const clientBans = new Set();
let hub = null;
let server = null;

const peer = createFdStdioPeer({
  onEvent(type, payload) {
    if (["synth-start", "synth-chunk", "synth-end", "synth-error"].includes(type)) {
      try { parentPool.accept(type, payload); } catch (error) {
        const id = String(payload?.id ?? "");
        const pending = parentPool.pending.get(id);
        if (pending) {
          parentPool.pending.delete(id);
          pending.reject(error);
        }
      }
      return;
    }
    if (type === "worker-status") {
      parentPool.setStatus(payload?.status);
      hub?.broadcastWorkerStatus();
    }
  },
  onRequest: async (method, params) => {
    if (method === "start") {
      if (hub || server) throw new Error("remote HTTP worker is already started");
      clientBans.clear();
      for (const entry of params?.clientBans ?? []) {
        const hash = String(entry ?? "").toLowerCase();
        if (/^[0-9a-f]{64}$/u.test(hash)) clientBans.add(hash);
      }
      parentPool.setStatus(params?.workerStatus ?? { engines: [], queued: 0, running: 0, profile: params?.modelProfile ?? null });
      hub = new RemoteClientHub({
        pool: parentPool,
        authKey: decode32(params?.authKey, "authKey"),
        encryptionKey: decode32(params?.encryptionKey, "encryptionKey"),
        modelProfile: params?.modelProfile,
        clientBanSalt: decode32(params?.clientBanSalt, "clientBanSalt"),
        isClientBanned(clientHash) {
          return clientBans.has(String(clientHash ?? "").toLowerCase());
        },
        onStatus(status) {
          peer.event("remote-status", { status });
        },
        onHistory(entry) {
          peer.event("history", { entry });
        },
      });
      server = new OrchestratorHttpServer({
        host: "127.0.0.1",
        port: Number(params?.port ?? 0),
        roles: ["remote"],
        originCapabilityHost: params?.originCapabilityHost,
        remoteHub: hub,
      });
      return server.start();
    }
    if (method === "set-model") return hub.setModelProfile(params?.modelProfile);
    if (method === "set-client-bans") {
      clientBans.clear();
      for (const entry of params?.clientBans ?? []) {
        const hash = String(entry ?? "").toLowerCase();
        if (/^[0-9a-f]{64}$/u.test(hash)) clientBans.add(hash);
      }
      for (const hash of clientBans) hub.disconnectClientHash(hash);
      return true;
    }
    if (method === "disconnect") return hub.disconnect(params?.connectionId);
    if (method === "disconnect-client-hash") return hub.disconnectClientHash(params?.clientHash);
    if (method === "close") {
      await hub?.close();
      await server?.close();
      parentPool.close();
      hub = null;
      server = null;
      return true;
    }
    throw new Error(`unsupported remote HTTP worker request: ${method}`);
  },
});
