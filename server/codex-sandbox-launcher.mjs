import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, sep, win32 } from "node:path";

const PERMISSION_PROFILE_ID = "typed_voice_server";
const SANITIZED_CHILD_ENVIRONMENT_OVERRIDE = "shell_environment_policy={inherit='all',ignore_default_excludes=true,exclude=[],set={},include_only=[],use_profile=false}";

function within(root, candidate) {
  const path = win32.relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${win32.sep}`) && !win32.isAbsolute(path));
}

async function canonicalRegularFile(path, label) {
  const info = await lstat(path);
  const actual = await realpath(path);
  const actualInfo = info.isSymbolicLink() ? await stat(actual) : info;
  if (!actualInfo.isFile()) throw new Error(`${label} must point to a regular file`);
  return actual;
}

function tomlLiteral(value, label) {
  const text = String(value);
  if (/[\u0000-\u001f\u007f']/.test(text)) throw new Error(`${label} cannot be represented safely in the Codex permission profile`);
  return `'${text}'`;
}

function absolutePath(value) {
  return typeof value === "string" && (isAbsolute(value) || win32.isAbsolute(value));
}

function pathDirname(value) {
  return win32.isAbsolute(value) ? win32.dirname(value) : dirname(value);
}

function pathBasename(value) {
  return win32.isAbsolute(value) ? win32.basename(value) : basename(value);
}

function configuredWithin(root, candidate) {
  const windows = win32.isAbsolute(root) || win32.isAbsolute(candidate);
  const path = windows ? win32.relative(root, candidate) : relative(root, candidate);
  const separator = windows ? win32.sep : sep;
  const absolute = windows ? win32.isAbsolute(path) : isAbsolute(path);
  return path === "" || (path !== ".." && !path.startsWith(`..${separator}`) && !absolute);
}

export function permissionProfileOverrideFor(config) {
  const writableRoots = [...new Set([
    ...(config.allowedDirectories ?? []),
    ...(config.sandboxInternalWritableDirectories ?? []),
  ])];
  const deniedPaths = [...new Set([
    ...(config.sandboxDeniedDirectories ?? config.disallowedDirectories ?? []),
    ...(config.sandboxDeniedFiles ?? config.disallowedFiles ?? []),
  ])];
  const forcedReadOnlyRoots = [...new Set([
    ...(config.sandboxForcedReadOnlyDirectories ?? []),
    ...(config.sandboxForcedReadOnlyFiles ?? []),
  ])];
  const executableName = typeof config.command === "string" ? pathBasename(config.command).toLowerCase() : "";
  const interpreterEntryDirectory = ["node", "node.exe", "python", "python.exe", "python3", "python3.exe"].includes(executableName)
    && absolutePath(config.args?.[0])
    ? pathDirname(config.args[0])
    : null;
  const readableRoots = [...new Set([
    ...(config.allowedFiles ?? []),
    ...(config.sandboxReadOnlyFiles ?? []),
    ...(config.sandboxReadOnlyDirectories ?? []),
    ...(absolutePath(config.command) ? [pathDirname(config.command)] : []),
    ...(interpreterEntryDirectory ? [interpreterEntryDirectory] : []),
  ])];
  const entries = new Map([[":minimal", "read"]]);
  for (const path of readableRoots) {
    if (!writableRoots.some((root) => configuredWithin(root, path))) entries.set(path, "read");
  }
  for (const path of writableRoots) entries.set(path, "write");
  for (const path of forcedReadOnlyRoots) entries.set(path, "read");
  for (const path of deniedPaths) entries.set(path, "deny");
  const filesystem = [...entries.entries()]
    .map(([path, access]) => `${tomlLiteral(path, "sandbox path")}=${tomlLiteral(access, "sandbox access")}`)
    .join(",");
  const networkEnabled = config.sandbox === "onlineworkspace";
  const localBinding = typeof config.allowLocalBinding === "boolean"
    ? `,allow_local_binding=${config.allowLocalBinding}`
    : "";
  return `permissions.${PERMISSION_PROFILE_ID}={filesystem={${filesystem}},network={enabled=${networkEnabled}${localBinding}}}`;
}

function windowsSandboxOverride(mode) {
  if (mode === "onlineworkspace") return "windows.sandbox='elevated'";
  if (mode !== "elevated" && mode !== "unelevated") throw new Error(`unsupported Windows Codex sandbox mode: ${mode}`);
  return `windows.sandbox='${mode}'`;
}

function commandInterpreterFor(env) {
  const configured = env.ComSpec || env.COMSPEC;
  if (configured && win32.isAbsolute(configured)) return configured;
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
  return win32.join(systemRoot, "System32", "cmd.exe");
}

function renderCmdArgument(argument) {
  const text = String(argument);
  if (/[\r\n"%^]/.test(text)) throw new Error("Codex .cmd launch arguments contain unsafe characters");
  return `"${text}"`;
}

function launchSpec(codexExecutable, config, env) {
  const permissionProfileOverride = permissionProfileOverrideFor(config);
  const args = [
    "-c", permissionProfileOverride,
    "-c", windowsSandboxOverride(config.sandbox),
    "-c", SANITIZED_CHILD_ENVIRONMENT_OVERRIDE,
    "sandbox",
    "--permission-profile", PERMISSION_PROFILE_ID,
    "-C", config.cwd,
    "--",
    config.command,
    ...(config.args ?? []),
  ];
  const options = {
    cwd: config.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  };
  if (/\.(?:cmd|bat)$/i.test(codexExecutable)) {
    const commandLine = [codexExecutable, ...args].map(renderCmdArgument).join(" ");
    return {
      command: commandInterpreterFor(env),
      args: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
      options: { ...options, windowsVerbatimArguments: true },
    };
  }
  return { command: codexExecutable, args, options };
}

export class CodexSandboxProcess {
  constructor(config, { env = process.env, onStdout = () => {}, onStderr = () => {}, onExit = () => {}, onFailure = () => {} } = {}) {
    this.config = config;
    this.env = env;
    this.onStdout = onStdout;
    this.onStderr = onStderr;
    this.onExit = onExit;
    this.onFailure = onFailure;
    this.child = null;
    this.ready = false;
    this.closed = false;
  }

  get writable() {
    return this.ready && !this.closed && Boolean(this.child?.stdin?.writable);
  }

  async start() {
    if (this.ready) return;
    const codexExecutable = await canonicalRegularFile(this.config.codexExecutable, "codexExecutable");
    const command = await canonicalRegularFile(this.config.command, `${this.config.name} command`);
    const roots = this.config.allowedDirectories ?? [];
    if (roots.some((root) => within(root, codexExecutable))) throw new Error(`${this.config.name} codexExecutable resolves inside a writable sandbox root`);
    if (roots.some((root) => within(root, command))) throw new Error(`${this.config.name} command resolves inside a writable sandbox root`);
    const executionConfig = { ...this.config, command };
    const launch = launchSpec(codexExecutable, executionConfig, this.env);
    this.child = spawn(launch.command, launch.args, launch.options);
    const childPid = this.child.pid;
    let tracked = false;
    const untrack = () => {
      if (!tracked) return;
      tracked = false;
      try { this.config.processTracker?.untrack(childPid); } catch {}
    };
    try {
      this.config.processTracker?.track(childPid);
      tracked = Boolean(this.config.processTracker);
    } catch (error) {
      if (this.child.exitCode === null && !this.child.killed) this.child.kill();
      throw error;
    }
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", this.onStdout);
    this.child.stderr.on("data", this.onStderr);
    this.child.once("error", (error) => {
      untrack();
      this.ready = false;
      if (!this.closed) this.onFailure(error);
    });
    this.child.once("exit", (code, signal) => {
      untrack();
      this.ready = false;
      if (!this.closed) this.onExit(code, signal);
    });
    this.ready = true;
  }

  write(value) {
    if (!this.writable) throw new Error(`${this.config.name} sandboxed process is not ready`);
    this.child.stdin.write(String(value));
  }

  async close() {
    this.closed = true;
    this.ready = false;
    if (!this.child) return;
    if (this.child.stdin?.writable) this.child.stdin.end();
    if (this.child.exitCode === null && !this.child.killed) this.child.kill();
  }
}
