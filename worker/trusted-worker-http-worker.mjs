import { BrowserWorkerPool } from "../server/engine-pool.mjs";
import { OrchestratorHttpServer } from "../server/orchestrator-http.mjs";
import { createFdStdioPeer } from "../server/stdio-peer.mjs";
import { verifyWorkerAccessToken } from "../server/worker-access-token.mjs";

const AUDIO_CHUNK_BYTES = 64 * 1024;

let pool = null;
let server = null;
let workerAccessSecret = null;
let publicOrigin = null;
let workerServerUrl = null;
const workerProxies = new Map();

function workerProxyId(value) {
  const id = String(value ?? "");
  if (!/^[0-9]{1,20}$/u.test(id)) throw new Error("invalid worker proxy id");
  return id;
}

function workerProxyPayload(value) {
  const encoded = String(value ?? "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length > 1_500_000) {
    throw new Error("invalid worker proxy payload");
  }
  return Buffer.from(encoded, "base64");
}

function finishWorkerProxy(proxy, { notifyRemote = false, code = 1000 } = {}) {
  if (!proxy || proxy.closed) return;
  proxy.closed = true;
  workerProxies.delete(proxy.id);
  if (notifyRemote) peer.event("worker-proxy-close", { id: proxy.id, code });
  proxy.onClose();
}

function createWorkerProxy(id) {
  const proxy = {
    id,
    closed: false,
    onMessage: () => {},
    onClose: () => {},
    sendBinary(payload) {
      if (proxy.closed) return false;
      return peer.event("worker-proxy-send", { id, data: Buffer.from(payload).toString("base64") });
    },
    close(code = 1000) {
      finishWorkerProxy(proxy, { notifyRemote: true, code });
    },
  };
  workerProxies.set(id, proxy);
  return proxy;
}

function decodeWorkerSecret(value) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9_-]{86}$/u.test(text)) throw new Error("worker access secret must be 64-byte base64url");
  const result = Buffer.from(text, "base64url");
  if (result.length !== 64) throw new Error("worker access secret must decode to 64 bytes");
  return result;
}

function validateJobId(value) {
  const id = String(value ?? "");
  if (!/^[0-9]{1,20}$/u.test(id)) throw new Error("invalid synthesis id");
  return id;
}

function streamSynthesisResult(id, audio) {
  const bytes = Buffer.from(audio.audio);
  peer.event("synth-start", {
    id,
    sampleRate: audio.sampleRate,
    sampleCount: audio.sampleCount,
    byteLength: bytes.length,
  });
  for (let offset = 0; offset < bytes.length; offset += AUDIO_CHUNK_BYTES) {
    peer.event("synth-chunk", {
      id,
      data: bytes.subarray(offset, Math.min(bytes.length, offset + AUDIO_CHUNK_BYTES)).toString("base64"),
    });
  }
  peer.event("synth-end", { id });
}

function workerStatus() {
  return pool?.status() ?? { engines: [], queued: 0, running: 0, profile: null };
}

const peer = createFdStdioPeer({
  onEvent(type, payload) {
    if (type === "worker-proxy-open") {
      const id = workerProxyId(payload?.id);
      if (workerProxies.has(id)) return;
      const proxy = createWorkerProxy(id);
      try {
        pool.attachTransport(proxy, {
          accessTokenValidator(token) {
            return verifyWorkerAccessToken(workerAccessSecret, token);
          },
        });
      } catch {
        proxy.close(1008);
      }
      return;
    }
    if (type === "worker-proxy-message") {
      const proxy = workerProxies.get(workerProxyId(payload?.id));
      if (proxy && !proxy.closed) proxy.onMessage(workerProxyPayload(payload?.data));
      return;
    }
    if (type === "worker-proxy-remote-close") {
      const proxy = workerProxies.get(workerProxyId(payload?.id));
      finishWorkerProxy(proxy);
      return;
    }
    if (type === "synthesize") {
      const id = validateJobId(payload?.id);
      const text = String(payload?.text ?? "");
      const speed = Number(payload?.speed ?? 1);
      if (!text.trim() || Buffer.byteLength(text, "utf8") > 16 * 1024) {
        peer.event("synth-error", { id, error: "invalid synthesis text" });
        return;
      }
      if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) {
        peer.event("synth-error", { id, error: "invalid synthesis speed" });
        return;
      }
      void pool.synthesize(id, text, { speed }).then((audio) => streamSynthesisResult(id, audio)).catch((error) => {
        peer.event("synth-error", {
          id,
          cancelled: error?.name === "AbortError",
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (type === "cancel") {
      const id = validateJobId(payload?.id);
      void pool.cancel(id).catch(() => {});
    }
  },
  onRequest: async (method, params) => {
    if (method === "start") {
      if (server || pool) throw new Error("trusted worker HTTP worker is already started");
      workerAccessSecret = decodeWorkerSecret(params?.workerAccessSecret);
      publicOrigin = params?.publicOrigin == null ? null : String(params.publicOrigin);
      pool = new BrowserWorkerPool({
        profile: params?.modelProfile,
        onState(partial) {
          peer.event("worker-state", { partial, status: workerStatus() });
        },
        onDiagnostic({ index, message }) {
          peer.event("diagnostic", { message: `worker:${index} ${String(message)}` });
        },
      });
      server = new OrchestratorHttpServer({
        host: "127.0.0.1",
        port: Number(params?.port ?? 0),
        roles: ["worker"],
        originCapabilityHost: params?.originCapabilityHost,
        workerPool: pool,
        publicOriginProvider: () => publicOrigin,
        workerServerUrlProvider: () => workerServerUrl,
        workerResetToken: params?.workerResetToken,
        workerPageUrl: params?.workerPageUrl,
        workerTokenValidator(token) {
          return verifyWorkerAccessToken(workerAccessSecret, token);
        },
        async onWorkerReset() {
          const result = await peer.request("worker-reset", {});
          workerAccessSecret = decodeWorkerSecret(result?.workerAccessSecret);
          pool.disconnectAll(1008);
        },
        onDiagnostic(message) {
          peer.event("diagnostic", { message: String(message) });
        },
      });
      const address = await server.start();
      return { address, status: workerStatus() };
    }
    if (method === "set-profile") {
      const status = await pool.reconfigure(params?.modelProfile);
      return status;
    }
    if (method === "set-public-origin") {
      publicOrigin = params?.origin == null ? null : String(params.origin);
      return true;
    }
    if (method === "set-worker-server-url") {
      const url = new URL(String(params?.url ?? ""));
      if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("worker server URL must use WebSocket");
      workerServerUrl = url.href;
      return true;
    }
    if (method === "set-worker-secret") {
      workerAccessSecret = decodeWorkerSecret(params?.workerAccessSecret);
      pool.disconnectAll(1008);
      return true;
    }
    if (method === "status") return workerStatus();
    if (method === "close") {
      await server?.close();
      await pool?.close();
      workerProxies.clear();
      server = null;
      pool = null;
      return true;
    }
    throw new Error(`unsupported trusted worker request: ${method}`);
  },
});
