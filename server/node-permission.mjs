import { isAbsolute, win32 } from "node:path";

function absolutePath(value, label) {
  const path = String(value ?? "");
  if (!(isAbsolute(path) || win32.isAbsolute(path))) throw new Error(`${label} must be absolute`);
  if (/[\r\n\u0000]/u.test(path)) throw new Error(`${label} contains unsafe characters`);
  return path;
}

export function restrictedNodeArgs(script, { readRoots = [], writeRoots = [] } = {}) {
  const scriptPath = absolutePath(script, "Node entry script");
  const read = [...new Set([...readRoots, ...writeRoots].map((path) => absolutePath(path, "Node read root")))];
  const write = [...new Set(writeRoots.map((path) => absolutePath(path, "Node write root")))];
  return [
    "--permission",
    ...read.map((path) => `--allow-fs-read=${path}`),
    ...write.map((path) => `--allow-fs-write=${path}`),
    scriptPath,
  ];
}
