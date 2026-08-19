import assert from "node:assert/strict";
import test from "node:test";

import { restrictedNodeArgs } from "../server/node-permission.mjs";

test("sandbox Node children enable Permission Model without process/addon escape flags", () => {
  const args = restrictedNodeArgs("C:\\repo\\worker\\remote-http-worker.mjs", {
    readRoots: ["C:\\repo\\worker", "C:\\repo\\server"],
  });
  assert.equal(args[0], "--permission");
  assert.ok(args.includes("--allow-fs-read=C:\\repo\\worker"));
  assert.ok(args.includes("--allow-fs-read=C:\\repo\\server"));
  assert.equal(args.at(-1), "C:\\repo\\worker\\remote-http-worker.mjs");
  assert.equal(args.some((arg) => arg === "--allow-child-process"), false);
  assert.equal(args.some((arg) => arg === "--allow-worker"), false);
  assert.equal(args.some((arg) => arg === "--allow-addons"), false);
  assert.equal(args.some((arg) => arg === "--allow-wasi"), false);
});

test("storage Node child gets write permission only for its fixed data root", () => {
  const args = restrictedNodeArgs("C:\\repo\\server\\storage-worker.mjs", {
    readRoots: ["C:\\repo\\server"],
    writeRoots: ["C:\\repo\\data"],
  });
  assert.ok(args.includes("--allow-fs-read=C:\\repo\\data"));
  assert.ok(args.includes("--allow-fs-write=C:\\repo\\data"));
  assert.equal(args.filter((arg) => arg.startsWith("--allow-fs-write=")).length, 1);
});
