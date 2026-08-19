import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve, win32 } from "node:path";

const TRY_CLOUDFLARE_URL_RE = /https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com\b/i;
const ONLINE_WORKSPACE_PROFILE = "typed_voice_quick_tunnel";

export function extractTryCloudflareUrl(text) {
  const match = String(text ?? "").match(TRY_CLOUDFLARE_URL_RE);
  return match ? match[0] : null;
}

function tomlPath(path) {
  const value = String(path);
  if (/[\u0000-\u001f\u007f']/.test(value)) throw new Error(`unsafe path: ${value}`);
  return `'${value}'`;
}

function cmdArgument(value) {
  const text = String(value);
  if (/[\r\n"%^]/.test(text)) throw new Error(`unsafe cmd argument: ${text}`);
  return `"${text}"`;
}

function resolveCommand(name, { platform = process.platform, env = process.env, spawnSyncFn = spawnSync } = {}) {
  const value = String(name ?? "").trim();
  if (!value) throw new Error("executable name is required");
  if (value.includes("/") || value.includes("\\")) return platform === "win32" ? win32.resolve(value) : resolve(value);
  const finder = platform === "win32" ? "where.exe" : "which";
  const result = spawnSyncFn(finder, [value], { encoding: "utf8", windowsHide: true });
  if (result.status === 0) {
    const match = String(result.stdout ?? "").split(/\r?\n/).map((entry) => entry.trim()).find(Boolean);
    if (match) return match;
  }
  if (platform === "win32" && env.APPDATA) {
    const fallback = win32.join(env.APPDATA, "npm", value.toLowerCase().startsWith("codex") ? "codex.cmd" : value);
    if (existsSync(fallback)) return fallback;
  }
  throw new Error(`${value} executable was not found on PATH`);
}

function spawnCodex(codex, args, { cwd, spawnFn = spawn, env = process.env } = {}) {
  if (!/\.(?:cmd|bat)$/i.test(codex)) {
    return spawnFn(codex, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
  }
  const commandLine = [codex, ...args].map(cmdArgument).join(" ");
  const comspec = env.ComSpec || env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
  return spawnFn(comspec, ["/d", "/v:off", "/s", "/c", `"${commandLine}"`], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    windowsVerbatimArguments: true,
    shell: false,
  });
}

export function buildQuickTunnelSandboxArgs({ cloudflaredExecutable, localOrigin, cwd = process.cwd(), platform = process.platform }) {
  const pathDirname = platform === "win32" ? win32.dirname : dirname;
  const filesystem = new Map([
    [cwd, "read"],
    [platform === "win32" ? win32.dirname(process.execPath) : dirname(process.execPath), "read"],
    [pathDirname(cloudflaredExecutable), "read"],
  ]);
  const filesystemToml = [...filesystem].map(([path, permission]) => `${tomlPath(path)}='${permission}'`).join(",");
  const permissionProfile = `permissions.${ONLINE_WORKSPACE_PROFILE}={filesystem={':minimal'='read',${filesystemToml}},network={enabled=true}}`;
  const args = ["-c", permissionProfile];
  if (platform === "win32") {
    args.push(
      "-c", "windows.sandbox='elevated'",
      "-c", "shell_environment_policy={inherit='all',ignore_default_excludes=true,exclude=[],set={},include_only=[],use_profile=false}",
    );
  }
  args.push(
    "sandbox", "--permission-profile", ONLINE_WORKSPACE_PROFILE,
    "-C", cwd,
    "--", cloudflaredExecutable,
    "tunnel", "--url", localOrigin, "--no-autoupdate",
  );
  return args;
}

export class QuickTunnelProcess {
  constructor({
    localOrigin,
    executable = process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
    codexExecutable = process.platform === "win32" ? "codex.cmd" : "codex",
    cwd = process.cwd(),
    spawnFn = spawn,
    spawnSyncFn = spawnSync,
    platform = process.platform,
    env = process.env,
    startupTimeoutMs = 45_000,
    onLog = () => {},
  }) {
    const origin = new URL(String(localOrigin));
    if (origin.protocol !== "http:" && origin.protocol !== "https:") throw new Error("Quick Tunnel local origin must use http or https");
    if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1) throw new Error("startupTimeoutMs must be positive");
    this.localOrigin = origin.href.replace(/\/$/, "");
    this.executable = String(executable);
    this.codexExecutable = String(codexExecutable);
    this.cwd = platform === "win32" ? win32.resolve(String(cwd)) : resolve(String(cwd));
    this.spawnFn = spawnFn;
    this.spawnSyncFn = spawnSyncFn;
    this.platform = platform;
    this.env = env;
    this.startupTimeoutMs = startupTimeoutMs;
    this.onLog = onLog;
    this.child = null;
    this.publicOrigin = null;
    this.startPromise = null;
  }

  async start() {
    if (this.publicOrigin) return this.publicOrigin;
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolvePromise, rejectPromise) => {
      const cloudflaredExecutable = resolveCommand(this.executable, {
        platform: this.platform,
        env: this.env,
        spawnSyncFn: this.spawnSyncFn,
      });
      const codexExecutable = resolveCommand(this.codexExecutable, {
        platform: this.platform,
        env: this.env,
        spawnSyncFn: this.spawnSyncFn,
      });
      const args = buildQuickTunnelSandboxArgs({
        cloudflaredExecutable,
        localOrigin: this.localOrigin,
        cwd: this.cwd,
        platform: this.platform,
      });
      const child = spawnCodex(codexExecutable, args, {
        cwd: this.cwd,
        spawnFn: this.spawnFn,
        env: this.env,
      });
      this.child = child;
      let settled = false;
      let buffered = "";
      const finish = (error, value = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectPromise(error);
        else resolvePromise(value);
      };
      const acceptChunk = (chunk, streamName) => {
        const text = Buffer.from(chunk).toString("utf8");
        this.onLog({ stream: streamName, text });
        buffered = `${buffered}${text}`.slice(-32 * 1024);
        const url = extractTryCloudflareUrl(buffered);
        if (!url || this.publicOrigin) return;
        const parsed = new URL(url);
        parsed.pathname = "/";
        parsed.search = "";
        parsed.hash = "";
        this.publicOrigin = parsed.origin;
        finish(null, this.publicOrigin);
      };
      child.stdout?.on("data", (chunk) => acceptChunk(chunk, "stdout"));
      child.stderr?.on("data", (chunk) => acceptChunk(chunk, "stderr"));
      child.once("error", (error) => finish(new Error(`cloudflaredを起動できませんでした: ${error.message}`)));
      child.once("exit", (code, signal) => {
        if (!settled) finish(new Error(`cloudflaredが公開URLを出す前に終了しました (code=${code ?? "null"}, signal=${signal ?? "null"})`));
      });
      const timer = setTimeout(() => {
        finish(new Error(`cloudflaredのQuick Tunnel URLを${this.startupTimeoutMs}ms以内に確認できませんでした`));
      }, this.startupTimeoutMs);
      timer.unref?.();
    });
    try {
      return await this.startPromise;
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    } finally {
      this.startPromise = null;
    }
  }

  async stop() {
    const child = this.child;
    this.child = null;
    this.publicOrigin = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise();
      }, 3000);
      timer.unref?.();
      child.once("exit", () => {
        clearTimeout(timer);
        resolvePromise();
      });
      child.kill("SIGTERM");
    });
  }
}
