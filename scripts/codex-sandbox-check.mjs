import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const NON_INTERACTIVE = process.argv.includes("--non-interactive");
const IS_WINDOWS = process.platform === "win32";
const WINDOWS_SETUP_VERSION = 5;

function runCodex(args, { inherit = false } = {}) {
  const executable = IS_WINDOWS ? (process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe") : "codex";
  const executableArgs = IS_WINDOWS ? ["/d", "/s", "/c", "codex", ...args] : args;
  const result = spawnSync(executable, executableArgs, {
    encoding: "utf8",
    shell: false,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (!inherit) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return result;
}

function smokeCommand() {
  if (IS_WINDOWS) {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    return [`${systemRoot}\\System32\\cmd.exe`, "/d", "/c", "exit", "0"];
  }
  return [existsSync("/usr/bin/true") ? "/usr/bin/true" : "/bin/true"];
}

function windowsSetupIsCompatible() {
  const home = process.env.USERPROFILE;
  if (!home) return false;
  const markerPath = `${home}\\.codex\\.sandbox\\setup_marker.json`;
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    return marker?.version === WINDOWS_SETUP_VERSION
      && marker?.offline_username === "CodexSandboxOffline"
      && marker?.online_username === "CodexSandboxOnline";
  } catch {
    return false;
  }
}

async function requestWindowsSetup() {
  const instruction = "codex sandbox setup --elevated --current-user";
  if (NON_INTERACTIVE || !input.isTTY || !output.isTTY) {
    console.error("Windows Codex elevated sandbox setup is missing or incompatible.");
    console.error("Administrator approval is required once. Run this manually and approve the Windows UAC prompt:");
    console.error(`  ${instruction}`);
    return false;
  }

  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      `Windows Codex elevated sandbox setup is missing or incompatible. Administrator approval is required once. Run \"${instruction}\" now? [y/N] `,
    );
    if (answer.trim().toLowerCase() !== "y") return false;
  } finally {
    rl.close();
  }

  const setup = runCodex(["sandbox", "setup", "--elevated", "--current-user"], { inherit: true });
  return setup.status === 0;
}

async function main() {
  if (IS_WINDOWS && !windowsSetupIsCompatible()) {
    if (!(await requestWindowsSetup())) process.exit(2);
  }

  const result = runCodex(["sandbox", ...smokeCommand()]);
  if (result.error) {
    console.error(`Unable to start Codex CLI: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`Codex sandbox smoke test failed with exit code ${result.status ?? "unknown"}.`);
    if (IS_WINDOWS) {
      console.error("If Windows sandbox provisioning needs to be refreshed, follow INSTALL.md; this script will not elevate automatically after an existing setup is detected.");
    }
    process.exit(result.status ?? 1);
  }

  console.log(`Codex ${IS_WINDOWS ? "Windows" : "Linux"} sandbox smoke test passed.`);
}

await main();
