import { pathToFileURL } from "node:url";
import { probeRemoteEndpoint } from "./connectivity-probe.mjs";

const directExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const MODEL_PROFILES = new Set(["fp32", "fp16", "mobile-int8", "mobile-int4"]);

const tools = [{
  name: "probe_remote",
  title: "Probe typed-voice remote endpoint",
  description: "Runs the encrypted WSS synthesis probe from an online Codex sandbox.",
  inputSchema: {
    type: "object",
    required: ["endpoint", "authKey", "encryptionKey", "expectedModelProfile"],
    properties: {
      endpoint: { type: "string" },
      authKey: { type: "string" },
      encryptionKey: { type: "string" },
      expectedModelProfile: { type: "string", enum: [...MODEL_PROFILES] },
      text: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 },
    },
    additionalProperties: false,
  },
}];

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function protocolError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  };
}

function decodeKey(value, label) {
  const encoded = String(value ?? "");
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new Error(`${label} must be a 32-byte base64url key`);
  const key = Buffer.from(encoded, "base64url");
  if (key.length !== 32) throw new Error(`${label} must be 32 bytes`);
  return key;
}

export function createProbeMcpServer() {
  let initialized = false;
  return async (request) => {
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return protocolError(request?.id, -32600, "Invalid Request");
    }
    if (request.method === "initialize") {
      initialized = true;
      return response(request.id, {
        protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "typed-voice-connectivity-probe", version: "1.0.0" },
      });
    }
    if (request.method === "notifications/initialized") return null;
    if (!initialized) return protocolError(request.id, -32002, "Server not initialized");
    if (request.method === "ping") return response(request.id, {});
    if (request.method === "tools/list") return response(request.id, { tools });
    if (request.method !== "tools/call") return protocolError(request.id, -32601, "Method not found");
    try {
      if (request.params?.name !== "probe_remote") throw new Error(`Unknown tool: ${request.params?.name}`);
      const args = request.params?.arguments ?? {};
      const endpoint = new URL(String(args.endpoint ?? ""));
      if (endpoint.protocol !== "wss:" || endpoint.pathname !== "/remote") throw new Error("endpoint must be a WSS /remote URL");
      const expectedModelProfile = String(args.expectedModelProfile ?? "");
      if (!MODEL_PROFILES.has(expectedModelProfile)) throw new Error("unsupported model profile");
      const result = await probeRemoteEndpoint({
        endpoint: endpoint.href,
        authKey: decodeKey(args.authKey, "authKey"),
        encryptionKey: decodeKey(args.encryptionKey, "encryptionKey"),
        expectedModelProfile,
        text: args.text === undefined ? "疎通確認" : String(args.text),
        timeoutMs: args.timeoutMs === undefined ? 90_000 : Number(args.timeoutMs),
      });
      return response(request.id, toolResult(result));
    } catch (error) {
      return response(request.id, toolResult({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }, true));
    }
  };
}

export async function startProbeStdio(input = process.stdin, output = process.stdout) {
  const handle = createProbeMcpServer();
  let buffer = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += String(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify(protocolError(null, -32700, "Parse error"))}\n`);
        continue;
      }
      void handle(request).then((reply) => {
        if (reply) output.write(`${JSON.stringify(reply)}\n`);
      }, (error) => {
        output.write(`${JSON.stringify(protocolError(request.id, -32603, error instanceof Error ? error.message : String(error)))}\n`);
      });
    }
  });
}

if (directExecution) await startProbeStdio();
