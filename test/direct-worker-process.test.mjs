import assert from "node:assert/strict";
import test from "node:test";

import { directWorkerProcessInternals } from "../server/direct-worker-process.mjs";

test("Linux direct-test worker environment excludes inherited secrets and Node injection", () => {
  const environment = directWorkerProcessInternals.directTestEnvironment({
    LANG: "C.UTF-8",
    TZ: "Asia/Tokyo",
    PATH: "/tmp/attacker",
    NODE_OPTIONS: "--import=/tmp/inject.mjs",
    SECRET_TOKEN: "secret",
  });
  assert.deepEqual(environment, { LANG: "C.UTF-8", TZ: "Asia/Tokyo" });
});
