import { spawn } from "node:child_process";
import { win32 } from "node:path";

function childRunning(child) {
  return Boolean(child)
    && child.exitCode === null
    && child.signalCode === null;
}

function waitForExit(child, timeoutMs) {
  if (!childRunning(child)) return Promise.resolve();
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off?.("exit", finish);
      resolvePromise();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once?.("exit", finish);
  });
}

function taskkillExecutable(env) {
  const systemRoot = String(env.SystemRoot || env.SYSTEMROOT || "").trim();
  return systemRoot ? win32.join(systemRoot, "System32", "taskkill.exe") : "taskkill.exe";
}

async function taskkillTree(pid, { env, spawnFn, timeoutMs }) {
  await new Promise((resolvePromise) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise();
    };
    let killer;
    try {
      killer = spawnFn(taskkillExecutable(env), ["/PID", String(pid), "/T", "/F"], {
        env,
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
    } catch {
      finish();
      return;
    }
    timer = setTimeout(() => {
      try { killer.kill?.("SIGKILL"); } catch {}
      finish();
    }, timeoutMs);
    killer.once?.("error", finish);
    killer.once?.("exit", finish);
  });
}

export async function terminateProcessTree(child, {
  platform = process.platform,
  env = process.env,
  spawnFn = spawn,
  timeoutMs = 3000,
} = {}) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  if (!childRunning(child)) return;

  if (platform === "win32") {
    // taskkill /T is intentional here: Codex can be a cmd/npm/native wrapper
    // around the actual sandbox command. Killing only the direct child leaves
    // cloudflared or a sandboxed Node worker alive after the server exits.
    await taskkillTree(child.pid, { env, spawnFn, timeoutMs });
    await waitForExit(child, Math.min(timeoutMs, 500));
    if (childRunning(child)) {
      try { child.kill("SIGKILL"); } catch {}
      await waitForExit(child, Math.min(timeoutMs, 500));
    }
    return;
  }

  if (!childRunning(child)) return;
  try { child.stdin?.end(); } catch {}
  try { child.kill("SIGTERM"); } catch {}
  await waitForExit(child, timeoutMs);
  if (!childRunning(child)) return;
  try { child.kill("SIGKILL"); } catch {}
  await waitForExit(child, Math.min(timeoutMs, 500));
}

export const processTreeInternals = { childRunning, taskkillExecutable };
