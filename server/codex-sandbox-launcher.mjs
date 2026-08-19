import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";

const PERMISSION_PROFILE_ID = "typed_voice_server";
const SANITIZED_CHILD_ENVIRONMENT_OVERRIDE = "shell_environment_policy={inherit='core',ignore_default_excludes=false,set={},experimental_use_profile=false}";

function tomlLiteral(value, label) {
  const text = String(value);
  if (/[\u0000-\u001f\u007f']/u.test(text)) throw new Error(`${label} cannot be represented safely in the Codex permission profile`);
  return `'${text}'`;
}

function pathDirname(value) {
  return win32.isAbsolute(value) ? win32.dirname(value) : dirname(value);
}

function configuredWithin(root, candidate) {
  const windows = win32.isAbsolute(root) || win32.isAbsolute(candidate);
  const path = windows ? win32.relative(root, candidate) : relative(root, candidate);
  const separator = windows ? win32.sep : sep;
  const absolute = windows ? win32.isAbsolute(path) : isAbsolute(path);
  return path === "" || (path !== ".." && !path.startsWith(`..${separator}`) && !absolute);
}

async function canonicalRegularFile(path, label) {
  const info = await lstat(path);
  const actual = await realpath(path);
  const actualInfo = info.isSymbolicLink() ? await stat(actual) : info;
  if (!actualInfo.isFile()) throw new Error(`${label} must resolve to a regular file`);
  return actual;
}

export function permissionProfileOverrideFor(config) {
  const writableRoots = [...new Set(config.allowedDirectories ?? [])];
  const readableRoots = [...new Set([
    ...(config.allowedFiles ?? []),
    ...(config.sandboxReadOnlyFiles ?? []),
    ...(config.sandboxReadOnlyDirectories ?? []),
    ...(isAbsolute(config.command) || win32.isAbsolute(config.command) ? [pathDirname(config.command)] : []),
  ])];
  const deniedPaths = [...new Set([
    ...(config.sandboxDeniedDirectories ?? []),
    ...(config.sandboxDeniedFiles ?? []),
  ])];
  const entries = new Map([[config.fullDiskRead ? ":root" : ":minimal", "read"]]);
  for (const path of readableRoots) {
    if (!writableRoots.some((root) => configuredWithin(root, path))) entries.set(path, "read");
  }
  for (const path of writableRoots) entries.set(path, "write");
  for (const path of deniedPaths) entries.set(path, "deny");
  const filesystem = [...entries.entries()]
    .map(([path, access]) => `${tomlLiteral(path, "sandbox path")}=${tomlLiteral(access, "sandbox access")}`)
    .join(",");
  const networkEnabled = config.sandbox === "onlineworkspace";
  return `permissions.${PERMISSION_PROFILE_ID}={filesystem={${filesystem}},network={enabled=${networkEnabled}}}`;
}

function windowsSandboxOverride(mode) {
  if (mode === "onlineworkspace" || mode === "elevated") return "windows.sandbox='elevated'";
  if (mode === "unelevated") return "windows.sandbox='unelevated'";
  throw new Error(`unsupported Windows Codex sandbox mode: ${mode}`);
}

function resolveCommand(name, { platform = process.platform, env = process.env, spawnSyncFn = spawnSync } = {}) {
  const value = String(name ?? "").trim();
  if (!value) throw new Error("executable name is required");
  if (value.includes("/") || value.includes("\\")) return platform === "win32" ? win32.resolve(value) : resolve(value);
  const finder = platform === "win32" ? "where.exe" : "which";
  const result = spawnSyncFn(finder, [value], { encoding: "utf8", windowsHide: true });
  if (result.status === 0) {
    const match = String(result.stdout ?? "").split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean);
    if (match) return match;
  }
  if (platform === "win32" && env.APPDATA) {
    const fallback = win32.join(env.APPDATA, "npm", value.toLowerCase().startsWith("codex") ? "codex.cmd" : value);
    if (existsSync(fallback)) return fallback;
  }
  throw new Error(`${value} executable was not found on PATH`);
}

function cmdArgument(value) {
  const text = String(value);
  if (/[\r\n"%^]/u.test(text)) throw new Error(`unsafe cmd argument: ${text}`);
  return `"${text}"`;
}

function spawnCodex(codex, args, { cwd, spawnFn = spawn, env = process.env } = {}) {
  const options = { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false };
  if (!/\.(?:cmd|bat)$/iu.test(codex)) return spawnFn(codex, args, options);
  const commandLine = [codex, ...args].map(cmdArgument).join(" ");
  const comspec = env.ComSpec || env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
  return spawnFn(comspec, ["/d", "/v:off", "/s", "/c", `"${commandLine}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

export class CodexSandboxProcess {
  constructor(config, {
    env = process.env,
    spawnFn = spawn,
    spawnSyncFn = spawnSync,
    onStdout = () => {},
    onStderr = () => {},
    onExit = () => {},
    onFailure = () => {},
  } = {}) {
    this.config = config;
    this.env = env;
    this.spawnFn = spawnFn;
    this.spawnSyncFn = spawnSyncFn;
    this.onStdout = onStdout;
    this.onStderr = onStderr;
    this.onExit = onExit;
    this.onFailure = onFailure;
    this.child = null;
    this.closed = false;
  }

  get stdin() { return this.child?.stdin ?? null; }
  get stdout() { return this.child?.stdout ?? null; }

  async start() {
    if (this.child) return this.child;
    const resolvedCodex = resolveCommand(this.config.codexExecutable ?? (process.platform === "win32" ? "codex.cmd" : "codex"), {
      env: this.env,
      spawnSyncFn: this.spawnSyncFn,
    });
    const resolvedCommand = resolveCommand(this.config.command, { env: this.env, spawnSyncFn: this.spawnSyncFn });
    const codex = await canonicalRegularFile(resolvedCodex, "codex executable");
    const command = await canonicalRegularFile(resolvedCommand, `${this.config.name} command`);
    for (const root of this.config.allowedDirectories ?? []) {
      if (configuredWithin(root, codex)) throw new Error(`${this.config.name} codex executable resolves inside a writable root`);
      if (configuredWithin(root, command)) throw new Error(`${this.config.name} command resolves inside a writable root`);
    }
    const executionConfig = { ...this.config, command };
    const args = ["-c", permissionProfileOverrideFor(executionConfig)];
    if (process.platform === "win32") args.push("-c", windowsSandboxOverride(this.config.sandbox ?? "elevated"));
    args.push(
      "-c", SANITIZED_CHILD_ENVIRONMENT_OVERRIDE,
      "sandbox", "--permission-profile", PERMISSION_PROFILE_ID,
      "-C", this.config.cwd,
      "--", command, ...(this.config.args ?? []),
    );
    const child = spawnCodex(codex, args, { cwd: this.config.cwd, spawnFn: this.spawnFn, env: this.env });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", this.onStdout);
    child.stderr?.on("data", this.onStderr);
    child.once("error", (error) => {
      this.child = null;
      if (!this.closed) this.onFailure(error);
    });
    child.once("exit", (code, signal) => {
      this.child = null;
      if (!this.closed) this.onExit(code, signal);
    });
    return child;
  }

  async close() {
    this.closed = true;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.stdin?.end();
    child.kill("SIGTERM");
  }
}
