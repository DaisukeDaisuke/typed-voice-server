import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const MIN_CODEX_VERSION = [0, 147, 0];
const MIN_CLOUDFLARED_VERSION = [2026, 8, 2];
const WINDOWS_SANDBOX_SETUP_VERSION = 5;
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));
const PROBLEM_BOX_WIDTH = 72;
const ANSI = Object.freeze({
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
});

function colorEnabled(stream) {
  return Boolean(stream?.isTTY) && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb";
}

function colorize(text, ...codes) {
  return `${codes.join("")}${text}${ANSI.reset}`;
}

function okLine(label, value = "") {
  const text = value ? `[OK] ${label}: ${value}` : `[OK] ${label}`;
  console.log(colorEnabled(process.stdout) ? colorize(text, ANSI.green) : text);
}

export function parseVersionText(value) {
  const match = String(value ?? "").match(/(?:^|[^0-9])(\d+)\.(\d+)\.(\d+)(?:[^0-9]|$)/u);
  if (!match) return null;
  return match.slice(1, 4).map((part) => Number(part));
}

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = Number(left[index] ?? 0) - Number(right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function nodeVersionSupported(value) {
  const version = parseVersionText(value);
  if (!version) return false;
  const [major, minor] = version;
  return (major === 22 && minor >= 13) || major === 23 || major === 24;
}

function versionLabel(version) {
  return version ? version.join(".") : "不明";
}

function terminalDisplayWidth(value) {
  let width = 0;
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    const wide = (codePoint >= 0x3000 && codePoint <= 0x30ff)
      || (codePoint >= 0x3400 && codePoint <= 0x9fff)
      || (codePoint >= 0xff01 && codePoint <= 0xff60)
      || (codePoint >= 0xffe0 && codePoint <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function problemBoxLine(value) {
  const prefix = `|  ${String(value)}`;
  const spaces = Math.max(1, PROBLEM_BOX_WIDTH - terminalDisplayWidth(prefix) - 1);
  return `${prefix}${" ".repeat(spaces)}|`;
}

export function formatProblemBox(problem, { color = false } = {}) {
  const border = "-=".repeat(PROBLEM_BOX_WIDTH / 2);
  const title = problemBoxLine(problem.title);
  const command = problemBoxLine(problem.command);
  const lines = [
    color ? colorize(border, ANSI.red) : border,
    color ? colorize(title, ANSI.red, ANSI.bold) : title,
    color ? colorize(command, ANSI.yellow) : command,
  ];
  if (problem.detail) {
    const detail = problemBoxLine(problem.detail);
    lines.push(color ? colorize(detail, ANSI.dim) : detail);
  }
  lines.push(color ? colorize(border, ANSI.red) : border);
  return lines.join("\n");
}

function addProblem(problems, title, command, detail = "") {
  problems.push({ title, command, detail });
}

function whereExecutable(candidates) {
  for (const candidate of candidates) {
    const result = spawnSync("where.exe", [candidate], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) continue;
    const path = String(result.stdout ?? "")
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .find(Boolean);
    if (path) return path;
  }
  return null;
}

function cmdArgument(value) {
  const text = String(value);
  if (/[\r\n"%^]/u.test(text)) throw new Error(`安全に実行できないコマンド引数です: ${text}`);
  return `"${text}"`;
}

function runExecutable(executable, args) {
  const options = {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  };
  if (!/\.(?:cmd|bat)$/iu.test(executable)) return spawnSync(executable, args, options);
  const commandLine = [executable, ...args].map(cmdArgument).join(" ");
  const comspec = process.env.ComSpec || process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
  return spawnSync(comspec, ["/d", "/v:off", "/s", "/c", `"${commandLine}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

function commandVersion({ label, candidates, minimum, installCommand, problems }) {
  const executable = whereExecutable(candidates);
  if (!executable) {
    addProblem(problems, `${label} がインストールされていません！`, installCommand);
    return;
  }

  const result = runExecutable(executable, ["--version"]);
  if (result.error || result.status !== 0) {
    addProblem(
      problems,
      `${label} のバージョンを確認できません！`,
      installCommand,
      `実行ファイル: ${executable}`,
    );
    return;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const version = parseVersionText(output);
  if (!version) {
    addProblem(
      problems,
      `${label} のバージョンを読み取れません！`,
      installCommand,
      `出力: ${output || "(空)"}`,
    );
    return;
  }
  if (compareVersions(version, minimum) < 0) {
    addProblem(
      problems,
      `${label} のバージョンが古すぎます！`,
      installCommand,
      `現在: ${versionLabel(version)} / 必要: ${versionLabel(minimum)} 以上`,
    );
    return;
  }

  okLine(label, versionLabel(version));
}

function checkNode(problems) {
  const current = String(process.versions.node ?? "");
  if (!nodeVersionSupported(current)) {
    addProblem(
      problems,
      "Node.js のバージョンが対応していません！",
      "winget install -e --id OpenJS.NodeJS.LTS",
      `現在: ${current || "不明"} / 必要: 22.13以上、25未満`,
    );
    return;
  }
  okLine("Node.js", current);
}

function checkSandboxSetup(problems) {
  const home = process.env.USERPROFILE;
  if (!home) {
    addProblem(
      problems,
      "Codex sandbox のセットアップ状態を確認できません！",
      "codex sandbox setup --elevated --current-user",
      "Windowsのユーザーフォルダーを確認できません。",
    );
    return;
  }

  const markerPath = join(home, ".codex", ".sandbox", "setup_marker.json");
  if (!existsSync(markerPath)) {
    addProblem(
      problems,
      "Codex sandbox がセットアップされていません！",
      "codex sandbox setup --elevated --current-user",
    );
    return;
  }

  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    const compatible = marker?.version === WINDOWS_SANDBOX_SETUP_VERSION
      && marker?.offline_username === "CodexSandboxOffline"
      && marker?.online_username === "CodexSandboxOnline";
    if (!compatible) {
      addProblem(
        problems,
        "Codex sandbox のセットアップが古いか互換性がありません！",
        "codex sandbox setup --elevated --current-user",
      );
      return;
    }
    okLine("Codex sandbox setup", `version ${marker.version}`);
  } catch (error) {
    addProblem(
      problems,
      "Codex sandbox のセットアップ情報を読めません！",
      "codex sandbox setup --elevated --current-user",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function checkReleaseFiles(problems) {
  const requiredFiles = [
    "server-main.mjs",
    "docker.mjs",
    "package.json",
    "server/storage-worker.mjs",
    "server/sandbox-worker-client.mjs",
    "server/codex-sandbox-launcher.mjs",
    "server/node-permission.mjs",
    "server/quick-tunnel.mjs",
    "server/worker-access-token.mjs",
    "admin/admin-http-worker.mjs",
    "worker/trusted-worker-http-worker.mjs",
    "worker/remote-http-worker.mjs",
    "worker/protocol.mjs",
    "worker/websocket.mjs",
    "web/index.html",
    "web/server-ui.css",
    "web/server-ui.js",
  ];
  const requiredDirectories = ["data"];
  const missing = [];
  for (const relativePath of requiredFiles) {
    const path = join(PROJECT_ROOT, relativePath);
    if (!existsSync(path)) {
      missing.push(relativePath);
      continue;
    }
    try {
      const info = statSync(path);
      if (!info.isFile()) missing.push(relativePath);
    } catch {
      missing.push(relativePath);
    }
  }
  for (const relativePath of requiredDirectories) {
    const path = join(PROJECT_ROOT, relativePath);
    if (!existsSync(path)) {
      missing.push(`${relativePath}/`);
      continue;
    }
    try {
      const info = statSync(path);
      if (!info.isDirectory()) missing.push(`${relativePath}/`);
    } catch {
      missing.push(`${relativePath}/`);
    }
  }
  if (missing.length) {
    addProblem(
      problems,
      "typed-voice-server の配布ファイルが不足しています！",
      "https://github.com/DaisukeDaisuke/typed-voice-server/releases/download/typed-voice-server-latest/typed-voice-server.zip",
      `不足: ${missing.join(", ")} / ZIPをもう一度ダウンロードし、「すべて展開」してください。`,
    );
    return;
  }
  okLine("typed-voice-server 配布ファイル");
}

export function main() {
  const problems = [];
  console.log("typed-voice-server の起動環境を確認します。\n");

  if (process.platform !== "win32") {
    addProblem(
      problems,
      "Server.cmd はWindows専用です！",
      "Windows上でServer.cmdをダブルクリックしてください。",
      `現在のOS: ${process.platform}`,
    );
  } else {
    checkNode(problems);
    commandVersion({
      label: "cloudflared",
      candidates: ["cloudflared.exe", "cloudflared"],
      minimum: MIN_CLOUDFLARED_VERSION,
      installCommand: "winget install -e --id Cloudflare.cloudflared",
      problems,
    });
    commandVersion({
      label: "Codex CLI",
      candidates: ["codex.cmd", "codex.exe", "codex"],
      minimum: MIN_CODEX_VERSION,
      installCommand: "npm install -g @openai/codex",
      problems,
    });
    checkSandboxSetup(problems);
  }
  checkReleaseFiles(problems);

  if (problems.length) {
    console.error("\n[NG] 起動に必要なものが足りないか、対応条件を満たしていません。\n");
    const useColor = colorEnabled(process.stderr);
    for (const problem of problems) {
      console.error(formatProblemBox(problem, { color: useColor }));
    }
    console.error("\nINSTALL.md の手順を確認してから、もう一度 Server.cmd を開いてください。");
    return 1;
  }

  console.log("\n[OK] 起動条件をすべて満たしています。サーバーを開始します。");
  return 0;
}

const currentPath = process.argv[1] ? resolve(process.argv[1]) : "";
const modulePath = resolve(fileURLToPath(import.meta.url));
const isDirect = process.platform === "win32"
  ? win32.normalize(currentPath).toLowerCase() === win32.normalize(modulePath).toLowerCase()
  : currentPath === modulePath;
if (isDirect) process.exitCode = main();
