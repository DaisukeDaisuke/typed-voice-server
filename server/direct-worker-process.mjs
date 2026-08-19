import { spawn } from "node:child_process";

function directTestEnvironment(env = process.env) {
  const result = {};
  for (const name of ["LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
    if (typeof env[name] === "string" && env[name]) result[name] = env[name];
  }
  return result;
}

export class DirectWorkerProcess {
  constructor(config, {
    env = process.env,
    spawnFn = spawn,
    onStdout = () => {},
    onStderr = () => {},
    onExit = () => {},
    onFailure = () => {},
  } = {}) {
    this.config = config;
    this.env = env;
    this.spawnFn = spawnFn;
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
    const child = this.spawnFn(this.config.command, this.config.args ?? [], {
      cwd: this.config.cwd,
      env: directTestEnvironment(this.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
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

export const directWorkerProcessInternals = { directTestEnvironment };
