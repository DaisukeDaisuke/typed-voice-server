import test from "node:test";
import assert from "node:assert/strict";

import { compareVersions, formatProblemBox, nodeVersionSupported, parseVersionText } from "../docker.mjs";

test("parseVersionText reads tool version output", () => {
  assert.deepEqual(parseVersionText("codex-cli 0.147.0"), [0, 147, 0]);
  assert.deepEqual(parseVersionText("cloudflared version 2026.8.2 (built 2026-08-12)"), [2026, 8, 2]);
  assert.equal(parseVersionText("version unknown"), null);
});

test("compareVersions compares three numeric components", () => {
  assert.equal(compareVersions([0, 147, 0], [0, 147, 0]), 0);
  assert.equal(compareVersions([0, 148, 0], [0, 147, 0]), 1);
  assert.equal(compareVersions([2026, 8, 1], [2026, 8, 2]), -1);
});

test("nodeVersionSupported matches the server runtime range", () => {
  assert.equal(nodeVersionSupported("22.12.0"), false);
  assert.equal(nodeVersionSupported("22.13.0"), true);
  assert.equal(nodeVersionSupported("23.9.0"), true);
  assert.equal(nodeVersionSupported("24.99.0"), true);
  assert.equal(nodeVersionSupported("25.0.0"), false);
});

test("formatProblemBox closes every content line", () => {
  const output = formatProblemBox({
    title: "cloudflared がインストールされていません！",
    command: "winget install -e --id Cloudflare.cloudflared",
  });
  const lines = output.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^\|  cloudflared .+\|$/u);
  assert.match(lines[2], /^\|  winget install -e --id Cloudflare\.cloudflared +\|$/u);
  assert.equal(lines[0], lines[3]);
});
