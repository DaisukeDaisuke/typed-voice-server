import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { OrchestratorHttpServer } from "../server/orchestrator-http.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sessionToken = "a".repeat(128);
const workerToken = "c".repeat(128);
const workerResetToken = "e".repeat(128);
const workerPageUrl = "https://rabbitdaisuke.github.io/typed-voice/worker.html";
const workerServerUrl = "wss://remote.example/remote";

function httpRequest(port, { method = "GET", path, cookie = null, origin = null, forwardedHost = null, forwardedProto = null, hostHeader = null, body = null }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const headers = {};
    if (hostHeader) headers.Host = hostHeader;
    if (cookie) headers.Cookie = cookie;
    if (origin) headers.Origin = origin;
    if (forwardedHost) headers["X-Forwarded-Host"] = forwardedHost;
    if (forwardedProto) headers["X-Forwarded-Proto"] = forwardedProto;
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

test("role別listenerは別roleを公開せずproxy経路ではport固有Host capabilityを要求する", async () => {
  const fakePool = {
    status() { return { engines: [], running: 0, queued: 0, profile: "fp16" }; },
    handleUpgrade(_request, socket) { socket.destroy(); },
  };
  const capabilityHost = "tv-worker-0123456789abcdef.invalid";
  const server = new OrchestratorHttpServer({
    host: "127.0.0.1",
    port: 0,
    roles: ["worker"],
    originCapabilityHost: capabilityHost,
    workerPool: fakePool,
    publicOriginProvider: () => "https://public.example",
    workerTokenValidator: (token) => token === workerToken,
  });
  try {
    const address = await server.start();
    const port = address.port;
    const admin = await httpRequest(port, { path: "/admin/login" });
    assert.equal(admin.statusCode, 404);

    const missingCapability = await httpRequest(port, {
      method: "POST",
      path: "/worker/session",
      origin: "https://public.example",
      forwardedHost: "public.example",
      forwardedProto: "https",
      body: workerToken,
    });
    assert.equal(missingCapability.statusCode, 404);

    const accepted = await httpRequest(port, {
      method: "POST",
      path: "/worker/session",
      hostHeader: capabilityHost,
      origin: "https://public.example",
      forwardedHost: "public.example",
      forwardedProto: "https",
      body: workerToken,
    });
    assert.equal(accepted.statusCode, 204);
  } finally {
    await server.close();
  }
});

function websocketUpgrade(port, cookie = null, origin = null, path = "/admin/ws", forwardedHost = null, forwardedProto = null) {
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
      if (forwardedHost) headers.push(`X-Forwarded-Host: ${forwardedHost}`);
      if (forwardedProto) headers.push(`X-Forwarded-Proto: ${forwardedProto}`);
      socket.write(`${headers.join("\r\n")}\r\n\r\n`);
    });
    socket.once("data", (chunk) => settle(chunk.toString("latin1")));
    socket.once("close", () => settle(""));
  });
}

test("管理画面と管理WebSocketはセッショントークン由来Cookieなしでは到達できない", async () => {
  let workerUpgradeCalls = 0;
  let workerUpgradeAccessTokenValidator = null;
  let workerResetCalls = 0;
  const fakePool = {
    status() { return { engines: [], running: 0, queued: 0, profile: "fp16" }; },
    handleUpgrade(_request, socket, _head, { accessTokenValidator = null } = {}) {
      workerUpgradeCalls += 1;
      workerUpgradeAccessTokenValidator = accessTokenValidator;
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
    workerPool: fakePool,
    remoteHub: fakeRemoteHub,
    stateProvider: () => ({ overall: "test" }),
    pairingProvider: () => null,
    publicOriginProvider: () => "https://public.example",
    workerResetToken,
    workerPageUrl,
    workerServerUrlProvider: () => workerServerUrl,
    onWorkerReset: async () => { workerResetCalls += 1; },
    workerTokenValidator: (token) => token === workerToken,
  });
  try {
    const address = await server.start();
    const port = address.port;

    await assert.rejects(
      httpRequest(port, { path: "/" }),
      (error) => error?.code === "ECONNRESET",
    );

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
      body: "b".repeat(128),
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
    assert.equal(missingWorker.statusCode, 302);
    assert.equal(missingWorker.headers.location, "/worker/login");
    assert.match(missingWorker.headers["set-cookie"]?.[0] ?? "", /^typed_voice_worker_session=;/u);
    assert.match(missingWorker.headers["set-cookie"]?.[0] ?? "", /Max-Age=0/u);

    const malformedWorkerCookie = await httpRequest(port, {
      path: "/worker/",
      cookie: "typed_voice_worker_session=%E0%A4%A",
    });
    assert.equal(malformedWorkerCookie.statusCode, 302);
    assert.equal(malformedWorkerCookie.headers.location, "/worker/login");
    // 裏AI編集あり / isolation: typedvoice-worker-auth-20260819 / END
    const workerLogin = await httpRequest(port, { path: "/worker/login" });
    assert.equal(workerLogin.statusCode, 200);
    assert.match(workerLogin.body, /128/u);
    assert.match(workerLogin.body, /daisukedaisuke\.github\.io\/typed-voice\/worker\.html/u);
    assert.match(workerLogin.body, /wss:\/\/remote\.example\/remote/u);
    assert.match(workerLogin.body, /searchParams\.set\("server", workerServerUrl\)/u);
    assert.match(workerLogin.body, /destination\.hash = token/u);

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

    const proxiedWorker = await httpRequest(port, {
      method: "POST",
      path: "/worker/session",
      origin: `http://localhost:${port}`,
      forwardedHost: "public.example",
      forwardedProto: "https",
      body: workerToken,
    });
    assert.equal(proxiedWorker.statusCode, 204);

    const forgedProxyWorker = await httpRequest(port, {
      method: "POST",
      path: "/worker/session",
      origin: `http://localhost:${port}`,
      forwardedHost: "attacker.invalid",
      forwardedProto: "https",
      body: workerToken,
    });
    assert.equal(forgedProxyWorker.statusCode, 404);

    const workerSetCookie = acceptedWorker.headers["set-cookie"]?.[0] ?? "";
    assert.match(workerSetCookie, /^typed_voice_worker_session=/u);
    assert.match(workerSetCookie, /HttpOnly/u);
    assert.match(workerSetCookie, /SameSite=Strict/u);
    const workerCookie = workerSetCookie.split(";", 1)[0];
    assert.doesNotMatch(workerSetCookie, new RegExp(workerToken, "u"));

    const authorizedWorker = await httpRequest(port, { path: "/worker/", cookie: workerCookie });
    assert.equal(authorizedWorker.statusCode, 404);
    assert.equal(authorizedWorker.body, "");

    await websocketUpgrade(port, null, `http://127.0.0.1:${port}`, "/worker/ws");
    assert.equal(workerUpgradeCalls, 0);
    await websocketUpgrade(port, workerCookie, "https://attacker.invalid", "/worker/ws");
    assert.equal(workerUpgradeCalls, 0);
    await websocketUpgrade(port, workerCookie, `http://127.0.0.1:${port}`, "/worker/ws");
    assert.equal(workerUpgradeCalls, 1);
    await websocketUpgrade(port, workerCookie, "https://public.example", "/worker/ws");
    assert.equal(workerUpgradeCalls, 2);
    await websocketUpgrade(port, workerCookie, `http://localhost:${port}`, "/worker/ws", "public.example", "https");
    assert.equal(workerUpgradeCalls, 3);
    await websocketUpgrade(port, workerCookie, `http://localhost:${port}`, "/worker/ws", "attacker.invalid", "https");
    assert.equal(workerUpgradeCalls, 3);
    await websocketUpgrade(port, null, "https://rabbitdaisuke.github.io", "/worker/ws");
    assert.equal(workerUpgradeCalls, 4);
    assert.equal(typeof workerUpgradeAccessTokenValidator, "function");
    assert.equal(workerUpgradeAccessTokenValidator(workerToken), true);
    assert.equal(workerUpgradeAccessTokenValidator("d".repeat(128)), false);

    const rejectedReset = await httpRequest(port, {
      method: "POST",
      path: "/worker/reset",
      body: "f".repeat(128),
    });
    assert.equal(rejectedReset.statusCode, 404);
    assert.equal(workerResetCalls, 0);

    const acceptedReset = await httpRequest(port, {
      method: "POST",
      path: "/worker/reset",
      body: workerResetToken,
    });
    assert.equal(acceptedReset.statusCode, 204);
    assert.equal(workerResetCalls, 1);

    const expiredWorkerSession = await httpRequest(port, { path: "/worker/", cookie: workerCookie });
    assert.equal(expiredWorkerSession.statusCode, 302);
    assert.equal(expiredWorkerSession.headers.location, "/worker/login");

    const proxiedReset = await httpRequest(port, {
      method: "POST",
      path: "/worker/reset",
      forwardedHost: "public.example",
      forwardedProto: "https",
      body: workerResetToken,
    });
    assert.equal(proxiedReset.statusCode, 404);
    assert.equal(workerResetCalls, 1);
  } finally {
    await server.close();
  }
});
