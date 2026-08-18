import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { acceptWebSocketUpgrade } from "../worker/websocket.mjs";


const modulePath = fileURLToPath(import.meta.url);
const moduleDirectory = dirname(modulePath);
const projectRoot = resolve(moduleDirectory, "..");
const webRoot = join(projectRoot, "web");
const engineRoot = join(projectRoot, "engine");
const directExecution = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(modulePath);
const portArgument = process.argv.find((value) => value.startsWith("--port="));
const configuredPort = Number(portArgument?.slice("--port=".length));
if (directExecution && (!Number.isSafeInteger(configuredPort) || configuredPort < 49152 || configuredPort > 65535)) {
  throw new Error("admin worker requires --port=49152..65535");
}

const clients = new Set();
let adminToken = null;
let state = {
  overall: "準備中",
  tunnel: "待機中",
  chrome: "待機中",
  webmcp: "待機中",
  model: "待機中",
  control: "待機中",
  clients: 0,
  runningJobs: 0,
  queuedJobs: 0,
  sessions: [],
  pairingEndpoint: null,
  pairingReady: false,
};
let pairing = null;

function writeParent(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function send(client, message) {
  if (!client.authenticated || client.ws.closed) return;
  client.ws.sendBinary(Buffer.from(JSON.stringify(message), "utf8"));
}

function broadcast(message) {
  for (const client of clients) send(client, message);
}

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

async function serveEngineAsset(url, response) {
  const rawRelative = decodeURIComponent(url.pathname.slice("/engine/".length));
  const relativePath = normalize(rawRelative || "server-engine.html");
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || resolve(engineRoot, relativePath).startsWith(`${resolve(engineRoot)}${sep}`) === false) {
    response.writeHead(400, { "Content-Length": "0" });
    response.end();
    return;
  }
  const path = resolve(engineRoot, relativePath);
  try {
    const bytes = await readFile(path);
    const cacheControl = relativePath.endsWith(".html") || relativePath.endsWith("app-service-worker.js")
      ? "no-cache"
      : "public, max-age=31536000, immutable";
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[extname(path).toLowerCase()] || "application/octet-stream",
      "Cache-Control": cacheControl,
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    response.end(bytes);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    response.writeHead(404, { "Content-Length": "0" });
    response.end();
  }
}

function safeTokenEqual(supplied) {
  const left = Buffer.from(String(supplied ?? ""), "utf8");
  const right = Buffer.from(String(adminToken ?? ""), "utf8");
  return left.length === right.length && right.length > 0 && timingSafeEqual(left, right);
}

function attachClient(ws) {
  const client = { ws, authenticated: false, timer: null, historySubscription: null, historyRequests: new Set(), debugRequests: new Set(), modelRequests: new Set() };
  clients.add(client);
  client.timer = setTimeout(() => ws.close(1008), 5000);
  ws.onMessage = (payload) => {
    let message;
    try {
      message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
    } catch {
      ws.close(1008);
      return;
    }
    if (!client.authenticated) {
      if (message?.type !== "auth" || !safeTokenEqual(message.token)) {
        ws.close(1008);
        return;
      }
      client.authenticated = true;
      clearTimeout(client.timer);
      client.timer = null;
      send(client, { type: "snapshot", state, pairing });
      writeParent({ type: "snapshot-request" });
      return;
    }
    if (message?.type === "disconnect") {
      writeParent({ type: "disconnect", connectionId: message.connectionId });
      return;
    }
    if (message?.type === "refresh") {
      writeParent({ type: "snapshot-request" });
      return;
    }
    if (message?.type === "history-get") {
      const conversationId = String(message.conversationId ?? "").trim();
      const requestId = String(message.requestId ?? "");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(conversationId) || !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) {
        ws.close(1008);
        return;
      }
      client.historyRequests.add(requestId);
      writeParent({ type: "history-get", requestId, conversationId });
      return;
    }
    if (message?.type === "history-subscribe") {
      const conversationId = String(message.conversationId ?? "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(conversationId)) {
        ws.close(1008);
        return;
      }
      if (client.historySubscription === conversationId) return;
      if (client.historySubscription && client.historySubscription !== conversationId) {
        writeParent({ type: "history-unsubscribe", conversationId: client.historySubscription });
      }
      client.historySubscription = conversationId;
      writeParent({ type: "history-subscribe", conversationId });
      return;
    }
    if (message?.type === "history-unsubscribe") {
      if (client.historySubscription) {
        writeParent({ type: "history-unsubscribe", conversationId: client.historySubscription });
        client.historySubscription = null;
      }
      return;
    }
    if (message?.type === "debug-eval") {
      const requestId = String(message.requestId ?? "");
      const slot = Number(message.slot);
      const expression = String(message.expression ?? "");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId) || !Number.isSafeInteger(slot) || slot < 0 || slot > 63 || !expression.trim() || expression.length > 64 * 1024) {
        ws.close(1008);
        return;
      }
      client.debugRequests.add(requestId);
      writeParent({ type: "debug-eval", requestId, slot, expression });
      return;
    }
    if (message?.type === "model-set") {
      const requestId = String(message.requestId ?? "");
      const modelProfile = String(message.modelProfile ?? "");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId) || !["fp32", "fp16", "mobile-int8", "mobile-int4"].includes(modelProfile)) {
        ws.close(1008);
        return;
      }
      client.modelRequests.add(requestId);
      writeParent({ type: "model-set", requestId, modelProfile });
      return;
    }
    ws.close(1008);
  };
  ws.onClose = () => {
    clearTimeout(client.timer);
    if (client.historySubscription) writeParent({ type: "history-unsubscribe", conversationId: client.historySubscription });
    clients.delete(client);
  };
}

async function startServer() {
  const [html, css, js] = await Promise.all([
    readFile(join(webRoot, "index.html")),
    readFile(join(webRoot, "server-ui.css")),
    readFile(join(webRoot, "server-ui.js")),
  ]);
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self'; img-src 'self' data:; connect-src 'self' https://huggingface.co https://*.huggingface.co https://*.hf.co; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (request.method === "GET" && url.pathname.startsWith("/engine/")) {
      await serveEngineAsset(url, response);
      return;
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && url.pathname === "/server-ui.css") {
      response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      response.end(css);
      return;
    }
    if (request.method === "GET" && url.pathname === "/server-ui.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(js);
      return;
    }
    response.writeHead(404, { "Content-Length": "0" });
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    try {
      const ws = acceptWebSocketUpgrade(request, socket, head, { path: "/admin", maxMessageBytes: 64 * 1024 });
      attachClient(ws);
    } catch {
      socket.destroy();
    }
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(configuredPort, "127.0.0.1", resolvePromise);
  });
  writeParent({ type: "ready", port: server.address().port });
  return server;
}

function acceptParent(message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "init") {
    adminToken = String(message.token ?? "");
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(adminToken)) throw new Error("invalid admin token");
    if (message.state && typeof message.state === "object") state = message.state;
    if (message.pairing && typeof message.pairing === "object") pairing = message.pairing;
    broadcast({ type: "snapshot", state, pairing });
    return;
  }
  if (message.type === "state" && message.state && typeof message.state === "object") {
    state = message.state;
    broadcast({ type: "state", state });
    return;
  }
  if (message.type === "pairing") {
    pairing = message.pairing && typeof message.pairing === "object" ? message.pairing : null;
    broadcast({ type: "pairing", pairing });
    return;
  }
  if (message.type === "snapshot") {
    if (message.state && typeof message.state === "object") state = message.state;
    if (Object.hasOwn(message, "pairing")) pairing = message.pairing;
    broadcast({ type: "snapshot", state, pairing });
    return;
  }
  if (message.type === "history-response") {
    for (const client of clients) {
      if (!client.authenticated || !client.historyRequests.has(message.requestId)) continue;
      client.historyRequests.delete(message.requestId);
      send(client, message);
    }
    return;
  }
  if (message.type === "history-event") {
    for (const client of clients) {
      if (!client.authenticated || client.historySubscription !== message.conversationId) continue;
      send(client, message);
    }
    return;
  }
  if (message.type === "debug-response") {
    for (const client of clients) {
      if (!client.authenticated || !client.debugRequests.has(message.requestId)) continue;
      client.debugRequests.delete(message.requestId);
      send(client, message);
    }
    return;
  }
  if (message.type === "model-response") {
    for (const client of clients) {
      if (!client.authenticated || !client.modelRequests.has(message.requestId)) continue;
      client.modelRequests.delete(message.requestId);
      send(client, message);
    }
  }
}

function startParentProtocol() {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        acceptParent(JSON.parse(line));
      } catch (error) {
        process.stderr.write(`[admin-worker] ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  });
}

if (directExecution) {
  startParentProtocol();
  try {
    await startServer();
  } catch (error) {
    writeParent({
      type: "fatal",
      code: typeof error?.code === "string" ? error.code : "ADMIN_START_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    process.stdin.pause();
    process.exitCode = 1;
  }
}
