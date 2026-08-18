import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { OrchestratorHttpServer } from "../server/orchestrator-http.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sessionToken = "a".repeat(64);
const workerToken = "c".repeat(128);

function httpRequest(port, { method = "GET", path, cookie = null, origin = null, body = null }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (origin) headers.Origin = origin;
    if (body !== null) {
      headers["Content-Type"] = "text/plain;charset=UTF-8";
      headers["Content-Length"] = String(Buffer.byteLength(body));
    }
    const request = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolvePromise({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", rejectPromise);
    if (body !== null) request.write(body);
    request.end();
  });
}

function websocketUpgrade(port, cookie = null, origin = null, path = "/admin/ws") {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      rejectPromise(new Error("websocket upgrade timed out"));
    }, 2000);
    const settle = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolvePromise(value);
    };
    socket.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    socket.once("connect", () => {
      const headers = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==",
      ];
      if (cookie) headers.push(`Cookie: ${cookie}`);
      if (origin) headers.push(`Origin: ${origin}`);
      socket.write(`${headers.join("\r\n")}\r\n\r\n`);
    });
    socket.once("data", (chunk) => settle(chunk.toString("latin1")));
    socket.once("close", () => settle(""));
  });
}

test("管理画面と管理WebSocketはセッショントークン由来Cookieなしでは到達できない", async () => {
  let workerUpgradeCalls = 0;
  const fakePool = {
    status() { return { engines: [], running: 0, queued: 0, profile: "fp16" }; },
    handleUpgrade(_request, socket) {
      workerUpgradeCalls += 1;
      socket.destroy();
    },
  };
  const fakeRemoteHub = {
    handleUpgrade(_request, socket) { socket.destroy(); },
  };
  const server = new OrchestratorHttpServer({
    host: "127.0.0.1",
    port: 0,
    sessionToken,
    webRoot: resolve(projectRoot, "web"),
    engineRoot: resolve(projectRoot, "engine-source"),
    workerPool: fakePool,
    remoteHub: fakeRemoteHub,
    stateProvider: () => ({ overall: "test" }),
    pairingProvider: () => null,
    publicOriginProvider: () => "https://public.example",
    workerTokenValidator: (token) => token === workerToken,
  });
  try {
    const address = await server.start();
    const port = address.port;

    const missing = await httpRequest(port, { path: "/admin/" });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.body, "");

    const login = await httpRequest(port, { path: "/admin/login" });
    assert.equal(login.statusCode, 200);
    assert.match(login.body, /location\.hash/u);
    assert.doesNotMatch(login.body, new RegExp(sessionToken, "u"));

    const wrong = await httpRequest(port, {
      method: "POST",
      path: "/admin/session",
      origin: `http://127.0.0.1:${port}`,
      body: "b".repeat(64),
    });
    assert.equal(wrong.statusCode, 404);

    const crossOrigin = await httpRequest(port, {
      method: "POST",
      path: "/admin/session",
      origin: "https://attacker.invalid",
      body: sessionToken,
    });
    assert.equal(crossOrigin.statusCode, 404);

    const publicOriginAccepted = await httpRequest(port, {
      method: "POST",
      path: "/admin/session",
      origin: "https://public.example",
      body: sessionToken,
    });
    assert.equal(publicOriginAccepted.statusCode, 204);

    const accepted = await httpRequest(port, {
      method: "POST",
      path: "/admin/session",
      origin: `http://127.0.0.1:${port}`,
      body: sessionToken,
    });
    assert.equal(accepted.statusCode, 204);
    const setCookie = accepted.headers["set-cookie"]?.[0] ?? "";
    assert.match(setCookie, /^typed_voice_admin_session=/u);
    assert.match(setCookie, /HttpOnly/u);
    assert.match(setCookie, /SameSite=Strict/u);
    const cookie = setCookie.split(";", 1)[0];

    const authorized = await httpRequest(port, { path: "/admin/", cookie });
    assert.equal(authorized.statusCode, 200);
    assert.match(authorized.body, /typed-voice-server/u);

    const rejectedUpgrade = await websocketUpgrade(port);
    assert.doesNotMatch(rejectedUpgrade, /^HTTP\/1\.1 101 /u);

    const rejectedCrossOriginUpgrade = await websocketUpgrade(port, cookie, "https://attacker.invalid");
    assert.doesNotMatch(rejectedCrossOriginUpgrade, /^HTTP\/1\.1 101 /u);

    const acceptedUpgrade = await websocketUpgrade(port, cookie, `http://127.0.0.1:${port}`);
    assert.match(acceptedUpgrade, /^HTTP\/1\.1 101 Switching Protocols/u);

    const missingWorker = await httpRequest(port, { path: "/worker/" });
    assert.equal(missingWorker.statusCode, 404);
    const workerLogin = await httpRequest(port, { path: "/worker/login" });
    assert.equal(workerLogin.statusCode, 200);
    assert.match(workerLogin.body, /128/u);

    const wrongWorker = await httpRequest(port, {
      method: "POST",
      path: "/worker/session",
      origin: `http://127.0.0.1:${port}`,
      body: "d".repeat(128),
    });
    assert.equal(wrongWorker.statusCode, 404);

    const acceptedWorker = await httpRequest(port, {
      method: "POST",
      path: "/worker/session",
      origin: `http://127.0.0.1:${port}`,
      body: workerToken,
    });
    assert.equal(acceptedWorker.statusCode, 204);

    const publicWorker = await httpRequest(port, {
      method: "POST",
      path: "/worker/session",
      origin: "https://public.example",
      body: workerToken,
    });
    assert.equal(publicWorker.statusCode, 204);
    const workerSetCookie = acceptedWorker.headers["set-cookie"]?.[0] ?? "";
    assert.match(workerSetCookie, /^typed_voice_worker_session=/u);
    assert.match(workerSetCookie, /HttpOnly/u);
    assert.match(workerSetCookie, /SameSite=Strict/u);
    const workerCookie = workerSetCookie.split(";", 1)[0];

    const authorizedWorker = await httpRequest(port, { path: "/worker/", cookie: workerCookie });
    assert.equal(authorizedWorker.statusCode, 200);
    assert.match(authorizedWorker.body, /Trusted Worker/u);

    await websocketUpgrade(port, null, `http://127.0.0.1:${port}`, "/worker/ws");
    assert.equal(workerUpgradeCalls, 0);
    await websocketUpgrade(port, workerCookie, "https://attacker.invalid", "/worker/ws");
    assert.equal(workerUpgradeCalls, 0);
    await websocketUpgrade(port, workerCookie, `http://127.0.0.1:${port}`, "/worker/ws");
    assert.equal(workerUpgradeCalls, 1);
    await websocketUpgrade(port, workerCookie, "https://public.example", "/worker/ws");
    assert.equal(workerUpgradeCalls, 2);
  } finally {
    await server.close();
  }
});
