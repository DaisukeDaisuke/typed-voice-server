import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { acceptWebSocketUpgrade } from "../worker/websocket.mjs";

const ADMIN_COOKIE = "typed_voice_admin_session";
const WORKER_COOKIE = "typed_voice_worker_session";
const ADMIN_LOGIN_HTML = Buffer.from(`<!doctype html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>typed-voice-server admin login</title></head>
<body><main><h1>typed-voice-server</h1><p id="status">管理セッションを確認しています。</p></main>
<script>
const status = document.getElementById("status");
const token = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
if (!/^[0-9a-f]{64}$/.test(token)) {
  status.textContent = "管理セッショントークンがありません。";
} else {
  fetch("./session", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: token })
    .then((response) => {
      if (!response.ok) throw new Error("管理セッショントークンを確認できませんでした。");
      location.replace("./");
    })
    .catch((error) => { status.textContent = error.message; });
}
</script></body></html>`, "utf8");
const WORKER_LOGIN_HTML = Buffer.from(`<!doctype html>
<html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>typed-voice trusted worker login</title></head>
<body><main><h1>typed-voice Trusted Worker</h1><p id="status">Worker接続トークンを確認しています。</p></main>
<script>
const status = document.getElementById("status");
const token = location.hash.slice(1);
history.replaceState(null, "", location.pathname);
if (!/^[0-9a-f]{128}$/.test(token)) {
  status.textContent = "有効なWorker接続トークンがありません。";
} else {
  fetch("./session", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: token })
    .then((response) => {
      if (!response.ok) throw new Error("Worker接続トークンを確認できませんでした。現在の10分トークンを使ってください。");
      location.replace("./");
    })
    .catch((error) => { status.textContent = error.message; });
}
</script></body></html>`, "utf8");
const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
});

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue ?? ""), "utf8");
  const right = Buffer.from(String(rightValue ?? ""), "utf8");
  return left.length === right.length && right.length > 0 && timingSafeEqual(left, right);
}

function cookieValue(request, name) {
  const source = String(request.headers.cookie ?? "");
  for (const part of source.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

function isHttps(request) {
  if (request.socket?.encrypted) return true;
  return String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim().toLowerCase() === "https";
}

function adminCookie(token, request) {
  return `${ADMIN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/admin${isHttps(request) ? "; Secure" : ""}`;
}

function workerCookie(token, request) {
  return `${WORKER_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/worker; Max-Age=630${isHttps(request) ? "; Secure" : ""}`;
}

function requestOrigin(request) {
  const forwardedHost = String(request.headers["x-forwarded-host"] ?? "").split(",")[0].trim();
  const host = forwardedHost || String(request.headers.host ?? "").trim();
  if (!host) return null;
  return `${isHttps(request) ? "https" : "http"}://${host}`;
}

async function readBoundedTextBody(request, maxBytes = 128) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maxBytes) throw new Error("request body is too large");
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
}

function noAccess(response) {
  response.writeHead(404, {
    "Cache-Control": "no-store",
    "Content-Length": "0",
    "Referrer-Policy": "no-referrer",
  });
  response.end();
}

function setIsolationHeaders(response) {
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
}

function safeAssetPath(root, relativePath) {
  const normalizedRoot = resolve(root);
  const path = resolve(normalizedRoot, relativePath);
  if (path !== normalizedRoot && !path.startsWith(`${normalizedRoot}${sep}`)) throw new Error("asset path escapes root");
  return path;
}

export class OrchestratorHttpServer {
  constructor({
    host = "0.0.0.0",
    port = 3000,
    sessionToken,
    webRoot,
    engineRoot,
    workerPool,
    remoteHub,
    stateProvider,
    pairingProvider,
    onDisconnect = () => {},
    onHistoryGet = async () => ({ metadata: null, events: [] }),
    onHistorySubscribe = () => {},
    onHistoryUnsubscribe = () => {},
    onModelSet = async () => {},
    onPublicOrigin = async () => {},
    publicOriginProvider = () => null,
    workerResetToken = null,
    onWorkerReset = async () => {},
    workerTokenValidator = () => false,
  }) {
    if (!/^[0-9a-f]{64}$/.test(String(sessionToken ?? ""))) throw new Error("admin session token must be 64 lowercase hex characters");
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("port must be 0..65535");
    this.host = host;
    this.port = port;
    this.sessionToken = sessionToken;
    this.webRoot = webRoot;
    this.engineRoot = engineRoot;
    this.workerPool = workerPool;
    this.remoteHub = remoteHub;
    this.stateProvider = stateProvider;
    this.pairingProvider = pairingProvider;
    this.onDisconnect = onDisconnect;
    this.onHistoryGet = onHistoryGet;
    this.onHistorySubscribe = onHistorySubscribe;
    this.onHistoryUnsubscribe = onHistoryUnsubscribe;
    this.onModelSet = onModelSet;
    this.onPublicOrigin = onPublicOrigin;
    this.publicOriginProvider = publicOriginProvider;
    this.workerResetToken = String(workerResetToken ?? "");
    if (this.workerResetToken && !/^[0-9a-f]{128}$/.test(this.workerResetToken)) {
      throw new Error("worker reset token must be 128 lowercase hex characters");
    }
    this.onWorkerReset = onWorkerReset;
    this.workerTokenValidator = workerTokenValidator;
    this.server = null;
    this.adminClients = new Set();
    this.adminAssets = null;
  }

  async start() {
    this.adminAssets = {
      html: await readFile(resolve(this.webRoot, "index.html")),
      css: await readFile(resolve(this.webRoot, "server-ui.css")),
      js: await readFile(resolve(this.webRoot, "server-ui.js")),
    };
    const server = http.createServer((request, response) => {
      void this.#handleHttp(request, response).catch((error) => {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        response.end(error instanceof Error ? error.message : String(error));
      });
    });
    server.on("upgrade", (request, socket, head) => {
      try {
        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/worker/ws") {
          if (!this.#workerAuthorized(request) || !this.#originAllowed(request)) {
            socket.destroy();
            return;
          }
          this.workerPool.handleUpgrade(request, socket, head);
          return;
        }
        if (url.pathname === "/remote") {
          this.remoteHub.handleUpgrade(request, socket, head);
          return;
        }
        if (url.pathname === "/admin/ws") {
          const origin = String(request.headers.origin ?? "");
          if (!this.#adminAuthorized(request) || !this.#originAllowed(request)) {
            socket.destroy();
            return;
          }
          const ws = acceptWebSocketUpgrade(request, socket, head, { path: "/admin/ws", maxMessageBytes: 64 * 1024 });
          this.#attachAdmin(ws, origin);
          return;
        }
        socket.destroy();
      } catch {
        socket.destroy();
      }
    });
    await new Promise((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(this.port, this.host, resolvePromise);
    });
    this.server = server;
    return server.address();
  }

  broadcastState() {
    this.#broadcastAdmin({ type: "state", state: this.stateProvider() });
  }

  broadcastPairing() {
    this.#broadcastAdmin({ type: "pairing", pairing: this.pairingProvider() });
  }

  async close() {
    for (const client of [...this.adminClients]) client.ws.close(1001);
    this.adminClients.clear();
    if (this.server?.listening) await new Promise((resolvePromise) => this.server.close(resolvePromise));
    this.server = null;
  }

  async #handleHttp(request, response) {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ ok: true, workers: this.workerPool.status().engines.length }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(302, { Location: "/worker/login", "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/admin/login") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(ADMIN_LOGIN_HTML.length),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(ADMIN_LOGIN_HTML);
      return;
    }
    if (request.method === "POST" && url.pathname === "/admin/session") {
      if (!this.#originAllowed(request)) {
        noAccess(response);
        return;
      }
      const supplied = await readBoundedTextBody(request, 128).catch(() => "");
      if (!safeEqual(supplied, this.sessionToken)) {
        noAccess(response);
        return;
      }
      response.writeHead(204, {
        "Set-Cookie": adminCookie(this.sessionToken, request),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/worker/login") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": String(WORKER_LOGIN_HTML.length),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(WORKER_LOGIN_HTML);
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/session") {
      if (!this.#originAllowed(request)) {
        noAccess(response);
        return;
      }
      const supplied = await readBoundedTextBody(request, 256).catch(() => "");
      if (!this.workerTokenValidator(supplied)) {
        noAccess(response);
        return;
      }
      response.writeHead(204, {
        "Set-Cookie": workerCookie(supplied, request),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/worker/reset") {
      const supplied = await readBoundedTextBody(request, 128).catch(() => "");
      if (!this.workerResetToken || !safeEqual(supplied, this.workerResetToken)) {
        noAccess(response);
        return;
      }
      await this.onWorkerReset();
      response.writeHead(204, {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
      if (!this.#adminAuthorized(request)) {
        noAccess(response);
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      response.end(this.adminAssets.html);
      return;
    }
    if (request.method === "GET" && url.pathname === "/admin/server-ui.css") {
      if (!this.#adminAuthorized(request)) return noAccess(response);
      response.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store" });
      response.end(this.adminAssets.css);
      return;
    }
    if (request.method === "GET" && url.pathname === "/admin/server-ui.js") {
      if (!this.#adminAuthorized(request)) return noAccess(response);
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      response.end(this.adminAssets.js);
      return;
    }
    if (request.method === "GET" && (url.pathname === "/worker" || url.pathname === "/worker/")) {
      if (!this.#workerAuthorized(request)) return noAccess(response);
      await this.#serveEngineAsset("server-engine.html", response, false);
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/worker/")) {
      if (!this.#workerAuthorized(request)) return noAccess(response);
      const relativePath = decodeURIComponent(url.pathname.slice("/worker/".length));
      const immutable = relativePath.startsWith("assets/");
      await this.#serveEngineAsset(relativePath, response, immutable);
      return;
    }
    response.writeHead(404, { "Content-Length": "0", "Cache-Control": "no-store" });
    response.end();
  }

  async #serveEngineAsset(relativePath, response, immutable) {
    const path = safeAssetPath(this.engineRoot, relativePath);
    try {
      const bytes = await readFile(path);
      setIsolationHeaders(response);
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[extname(path).toLowerCase()] || "application/octet-stream",
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      });
      response.end(bytes);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      response.writeHead(404, { "Content-Length": "0" });
      response.end();
    }
  }

  #adminAuthorized(request) {
    return safeEqual(cookieValue(request, ADMIN_COOKIE), this.sessionToken);
  }

  #workerAuthorized(request) {
    return this.workerTokenValidator(cookieValue(request, WORKER_COOKIE));
  }

  #originAllowed(request) {
    const supplied = String(request.headers.origin ?? "");
    if (!supplied) return false;
    const direct = requestOrigin(request);
    if (direct && supplied === direct) return true;
    const configured = this.publicOriginProvider();
    if (!configured) return false;
    try {
      return supplied === new URL(String(configured)).origin;
    } catch {
      return false;
    }
  }

  #attachAdmin(ws, origin) {
    const client = {
      ws,
      origin,
      historySubscription: null,
      historyRequests: new Set(),
      modelRequests: new Set(),
    };
    this.adminClients.add(client);
    this.#sendAdmin(client, { type: "snapshot", state: this.stateProvider(), pairing: this.pairingProvider() });
    ws.onMessage = (payload) => {
      try {
        const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
        this.#handleAdminMessage(client, message);
      } catch {
        ws.close(1008);
      }
    };
    ws.onClose = () => {
      if (client.historySubscription) this.onHistoryUnsubscribe(client.historySubscription);
      this.adminClients.delete(client);
    };
  }

  #handleAdminMessage(client, message) {
    if (!message || typeof message !== "object") throw new Error("invalid admin message");
    if (message.type === "refresh") {
      this.#sendAdmin(client, { type: "snapshot", state: this.stateProvider(), pairing: this.pairingProvider() });
      return;
    }
    if (message.type === "disconnect") {
      this.onDisconnect(message.connectionId);
      return;
    }
    if (message.type === "history-get") {
      const conversationId = String(message.conversationId ?? "").trim();
      const requestId = String(message.requestId ?? "");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(conversationId) || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) throw new Error("invalid history request");
      client.historyRequests.add(requestId);
      void this.onHistoryGet(conversationId).then((content) => {
        if (!client.historyRequests.delete(requestId) || client.ws.closed) return;
        this.#sendAdmin(client, { type: "history-response", requestId, conversationId, ok: true, ...content });
      }).catch((error) => {
        if (!client.historyRequests.delete(requestId) || client.ws.closed) return;
        this.#sendAdmin(client, {
          type: "history-response",
          requestId,
          conversationId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (message.type === "history-subscribe") {
      const conversationId = String(message.conversationId ?? "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(conversationId)) throw new Error("invalid history subscription");
      if (client.historySubscription === conversationId) return;
      if (client.historySubscription) this.onHistoryUnsubscribe(client.historySubscription);
      client.historySubscription = conversationId;
      this.onHistorySubscribe(conversationId);
      return;
    }
    if (message.type === "history-unsubscribe") {
      if (client.historySubscription) this.onHistoryUnsubscribe(client.historySubscription);
      client.historySubscription = null;
      return;
    }
    if (message.type === "model-set") {
      const requestId = String(message.requestId ?? "");
      const modelProfile = String(message.modelProfile ?? "");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId) || !["fp32", "fp16", "mobile-int8", "mobile-int4"].includes(modelProfile)) throw new Error("invalid model request");
      client.modelRequests.add(requestId);
      void this.onModelSet(modelProfile).then(() => {
        if (!client.modelRequests.delete(requestId) || client.ws.closed) return;
        this.#sendAdmin(client, { type: "model-response", requestId, ok: true, modelProfile });
      }).catch((error) => {
        if (!client.modelRequests.delete(requestId) || client.ws.closed) return;
        this.#sendAdmin(client, {
          type: "model-response",
          requestId,
          ok: false,
          modelProfile,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    if (message.type === "public-origin") {
      const origin = String(message.origin ?? "");
      if (origin !== client.origin) throw new Error("public origin does not match the authenticated admin connection");
      void this.onPublicOrigin(origin).catch(() => {});
      return;
    }
    throw new Error("unsupported admin message");
  }

  sendHistoryEvent(conversationId, event, metadata) {
    for (const client of this.adminClients) {
      if (client.historySubscription !== conversationId) continue;
      this.#sendAdmin(client, { type: "history-event", conversationId, event, metadata });
    }
  }

  #sendAdmin(client, message) {
    if (client.ws.closed) return false;
    return client.ws.sendBinary(Buffer.from(JSON.stringify(message), "utf8"));
  }

  #broadcastAdmin(message) {
    for (const client of this.adminClients) this.#sendAdmin(client, message);
  }
}
