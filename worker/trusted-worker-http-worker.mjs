import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWorkerPool } from "../server/engine-pool.mjs";
import { OrchestratorHttpServer } from "../server/orchestrator-http.mjs";
import { createFdStdioPeer } from "../server/stdio-peer.mjs";
import { assertSiblingRoleAuthenticationDenied } from "../server/boundary-probe.mjs";
import { verifyWorkerAccessToken } from "../server/worker-access-token.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtEngineRoot = join(projectRoot, "engine");
const sourceEngineRoot = join(projectRoot, "engine-source");
const AUDIO_CHUNK_BYTES = 64 * 1024;

let pool = null;
let server = null;
let workerAccessSecret = null;
let publicOrigin = null;

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
    if (type === "synthesize") {
      const id = validateJobId(payload?.id);
      const text = String(payload?.text ?? "");
      if (!text.trim() || Buffer.byteLength(text, "utf8") > 16 * 1024) {
        peer.event("synth-error", { id, error: "invalid synthesis text" });
        return;
      }
      void pool.synthesize(id, text).then((audio) => streamSynthesisResult(id, audio)).catch((error) => {
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
        engineRoot: existsSync(join(builtEngineRoot, "index.html")) ? builtEngineRoot : sourceEngineRoot,
        workerPool: pool,
        publicOriginProvider: () => publicOrigin,
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
    if (method === "assert-sibling-auth-denied") return assertSiblingRoleAuthenticationDenied(params?.port, params?.role);
    if (method === "set-public-origin") {
      publicOrigin = params?.origin == null ? null : String(params.origin);
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
      server = null;
      pool = null;
      return true;
    }
    throw new Error(`unsupported trusted worker request: ${method}`);
  },
});
