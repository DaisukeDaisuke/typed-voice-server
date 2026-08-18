import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: "string", default: "3000" },
    "token-file": { type: "string", default: "data/worker/reset-token.txt" },
  },
  strict: true,
  allowPositionals: false,
});

const port = Number(parsed.values.port);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("--port must be 1..65535");
const tokenFile = resolve(projectRoot, String(parsed.values["token-file"]));
const token = await readFile(tokenFile, "utf8");
if (!/^[0-9a-f]{128}$/.test(token)) throw new Error("worker reset token file must contain exactly 128 lowercase hex characters");

const response = await fetch(`http://127.0.0.1:${port}/worker/reset`, {
  method: "POST",
  cache: "no-store",
  headers: { "Content-Type": "text/plain;charset=UTF-8" },
  body: token,
});
if (!response.ok) throw new Error(`worker access reset failed: HTTP ${response.status}`);
process.stdout.write("Worker access reset completed.\n");
