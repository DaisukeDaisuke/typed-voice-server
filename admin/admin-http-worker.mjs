import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OrchestratorHttpServer } from "../server/orchestrator-http.mjs";
import { createFdStdioPeer } from "../server/stdio-peer.mjs";
import { assertLoopbackConnectDenied } from "../server/boundary-probe.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = join(projectRoot, "web");

let server = null;
let state = {};
let pairing = null;
let publicOrigin = null;

const peer = createFdStdioPeer({
  onRequest: async (method, params) => {
    if (method === "start") {
      if (server) throw new Error("admin HTTP worker is already started");
      state = params?.state && typeof params.state === "object" ? params.state : {};
      pairing = params?.pairing && typeof params.pairing === "object" ? params.pairing : null;
      publicOrigin = params?.publicOrigin == null ? null : String(params.publicOrigin);
      server = new OrchestratorHttpServer({
        host: "127.0.0.1",
        port: Number(params?.port ?? 0),
        roles: ["admin"],
        originCapabilityHost: params?.originCapabilityHost,
        sessionToken: params?.sessionToken,
        webRoot,
        stateProvider: () => state,
        pairingProvider: () => pairing,
        publicOriginProvider: () => publicOrigin,
        onDisconnect(connectionId) {
          peer.event("disconnect", { connectionId });
        },
        onHistoryGet(conversationId) {
          return peer.request("history-get", { conversationId });
        },
        onHistorySubscribe(conversationId) {
          peer.event("history-subscribe", { conversationId });
        },
        onHistoryUnsubscribe(conversationId) {
          peer.event("history-unsubscribe", { conversationId });
        },
        onModelSet(modelProfile) {
          return peer.request("model-set", { modelProfile });
        },
        onClientBanSet(clientHash, banned) {
          return peer.request("client-ban-set", { clientHash, banned });
        },
        onPublicOrigin(origin) {
          peer.event("public-origin", { origin });
          return Promise.resolve();
        },
        onDiagnostic(message) {
          peer.event("diagnostic", { message: String(message) });
        },
      });
      return server.start();
    }
    if (method === "set-state") {
      state = params?.state && typeof params.state === "object" ? params.state : {};
      server?.broadcastState();
      return true;
    }
    if (method === "assert-loopback-denied") return assertLoopbackConnectDenied(params?.port);
    if (method === "set-pairing") {
      pairing = params?.pairing && typeof params.pairing === "object" ? params.pairing : null;
      server?.broadcastPairing();
      return true;
    }
    if (method === "set-public-origin") {
      publicOrigin = params?.origin == null ? null : String(params.origin);
      return true;
    }
    if (method === "history-event") {
      server?.sendHistoryEvent(params?.conversationId, params?.event, params?.metadata);
      return true;
    }
    if (method === "close") {
      await server?.close();
      server = null;
      return true;
    }
    throw new Error(`unsupported admin HTTP worker request: ${method}`);
  },
});
