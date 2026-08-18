import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const watchdogScript = fileURLToPath(import.meta.url);
const watchdogMode = process.argv.includes("--watchdog");

function validPid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function watchdogParentPid() {
  const argument = process.argv.find((value) => value.startsWith("--parent="));
  const parentPid = Number(argument?.slice("--parent=".length));
  if (!validPid(parentPid)) throw new Error("watchdog parent PID is invalid");
  return parentPid;
}

function taskkillPath(env = process.env) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return join(systemRoot, "System32", "taskkill.exe");
}

async function terminateProcessTree(pid) {
  await new Promise((resolvePromise) => {
    const child = spawn(taskkillPath(), ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    child.once("error", resolvePromise);
    child.once("exit", resolvePromise);
  });
}

async function runWatchdog() {
  if (process.platform !== "win32") throw new Error("process tree watchdog requires Windows");
  const parentPid = watchdogParentPid();
  const roots = new Set();
  let buffer = "";
  let cleaning = false;
  let parentTimer = null;

  const acceptLine = (line) => {
    const match = /^([+-])(\d+)$/.exec(line.trim());
    if (!match) return;
    const pid = Number(match[2]);
    if (!validPid(pid)) return;
    if (match[1] === "+") roots.add(pid);
    else roots.delete(pid);
  };

  const cleanup = async () => {
    if (cleaning) return;
    cleaning = true;
    if (parentTimer) clearInterval(parentTimer);
    process.stdin.pause();
    for (const pid of [...roots].reverse()) await terminateProcessTree(pid);
    process.exit(0);
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += String(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      acceptLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });
  process.stdin.once("end", () => void cleanup());
  process.stdin.once("close", () => void cleanup());
  process.stdin.once("error", () => void cleanup());
  parentTimer = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      void cleanup();
    }
  }, 250);
}

export class ProcessTreeWatchdog {
  constructor({ nodePath = process.execPath, scriptPath = watchdogScript } = {}) {
    this.nodePath = nodePath;
    this.scriptPath = scriptPath;
    this.child = null;
    this.started = false;
    this.closed = false;
  }

  async start() {
    if (this.started) return;
    if (this.closed) throw new Error("process tree watchdog is closed");
    if (process.platform !== "win32") throw new Error("process tree watchdog requires Windows");
    const child = spawn(this.nodePath, [this.scriptPath, "--watchdog", `--parent=${process.pid}`], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      shell: false,
    });
    this.child = child;
    await new Promise((resolvePromise, rejectPromise) => {
      child.once("spawn", resolvePromise);
      child.once("error", rejectPromise);
    });
    child.once("exit", () => {
      this.started = false;
    });
    child.unref();
    this.started = true;
  }

  track(pid) {
    this.#write("+", pid);
  }

  untrack(pid) {
    this.#write("-", pid);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.started = false;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
    if (child.stdin.writable) child.stdin.end();
    await Promise.race([
      exited,
      new Promise((resolvePromise) => setTimeout(resolvePromise, 15_000)),
    ]);
    if (child.exitCode === null && !child.killed) child.kill();
  }

  #write(operation, pid) {
    if (!validPid(pid)) throw new Error("tracked process PID is invalid");
    if (!this.started || this.closed || !this.child?.stdin?.writable) {
      throw new Error("process tree watchdog is unavailable");
    }
    this.child.stdin.write(`${operation}${pid}\n`);
  }
}

if (watchdogMode) {
  await runWatchdog();
}
