import assert from "node:assert/strict";
import test from "node:test";

import { permissionProfileOverrideFor } from "../server/codex-sandbox-launcher.mjs";

test("offline HTTP worker profile keeps network disabled without widening the network table", () => {
  const profile = permissionProfileOverrideFor({
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\repo\\worker\\remote-http-worker.mjs"],
    allowedDirectories: [],
    sandboxReadOnlyDirectories: ["C:\\repo\\worker", "C:\\repo\\server"],
    sandbox: "elevated",
  });
  assert.match(profile, /network=\{enabled=false\}\}$/u);
  assert.match(profile, /'C:\\repo\\worker'='read'/u);
  assert.match(profile, /'C:\\repo\\server'='read'/u);
  assert.doesNotMatch(profile, /='write'/u);
});

test("storage profile grants write only to the data root", () => {
  const profile = permissionProfileOverrideFor({
    command: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\repo\\server\\storage-worker.mjs"],
    allowedDirectories: ["C:\\repo\\data"],
    sandboxReadOnlyDirectories: ["C:\\repo\\server"],
    sandbox: "elevated",
  });
  assert.match(profile, /'C:\\repo\\data'='write'/u);
  assert.match(profile, /':minimal'='read'/u);
  assert.match(profile, /'C:\\repo\\server'='read'/u);
  assert.doesNotMatch(profile, /':root'='read'/u);
  assert.match(profile, /network=\{enabled=false\}\}$/u);
});

test("unelevated sandbox mode is rejected", () => {
  assert.throws(() => permissionProfileOverrideFor({
    command: "C:\\Program Files\\nodejs\\node.exe",
    sandbox: "unelevated",
  }), /unelevated Codex sandbox mode is not supported/u);
});

test("public HTTP worker profile explicitly denies the persistent data root", () => {
  const profile = permissionProfileOverrideFor({
    command: "C:\\Program Files\\nodejs\\node.exe",
    allowedDirectories: [],
    sandboxReadOnlyDirectories: ["C:\\repo\\worker", "C:\\repo\\server"],
    sandboxDeniedDirectories: ["C:\\repo\\data"],
    sandbox: "elevated",
  });
  assert.match(profile, /'C:\\repo\\data'='deny'/u);
  assert.match(profile, /network=\{enabled=false\}\}$/u);
});
