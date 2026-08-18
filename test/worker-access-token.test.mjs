import assert from "node:assert/strict";
import test from "node:test";
import {
  WORKER_TOKEN_GRACE_MS,
  WORKER_TOKEN_WINDOW_MS,
  currentWorkerAccessToken,
  deriveWorkerAccessToken,
  millisecondsUntilWorkerTokenRotation,
  verifyWorkerAccessToken,
} from "../server/worker-access-token.mjs";

test("Worker接続tokenは64-byte secretからHMAC-SHA-512で10分ごとにローテーションする", () => {
  const secret = Buffer.alloc(64, 0x5a);
  const first = currentWorkerAccessToken(secret, 0);
  assert.match(first.token, /^[0-9a-f]{128}$/u);
  assert.equal(first.token, deriveWorkerAccessToken(secret, 0));
  assert.equal(first.validFrom, 0);
  assert.equal(first.expiresAt, WORKER_TOKEN_WINDOW_MS);
  assert.equal(millisecondsUntilWorkerTokenRotation(1234), WORKER_TOKEN_WINDOW_MS - 1234);

  const second = currentWorkerAccessToken(secret, WORKER_TOKEN_WINDOW_MS);
  assert.notEqual(second.token, first.token);
  assert.equal(verifyWorkerAccessToken(secret, second.token, WORKER_TOKEN_WINDOW_MS), true);
  assert.equal(verifyWorkerAccessToken(secret, first.token, WORKER_TOKEN_WINDOW_MS), true);
  assert.equal(verifyWorkerAccessToken(secret, first.token, WORKER_TOKEN_WINDOW_MS + WORKER_TOKEN_GRACE_MS - 1), true);
  assert.equal(verifyWorkerAccessToken(secret, first.token, WORKER_TOKEN_WINDOW_MS + WORKER_TOKEN_GRACE_MS), false);
  assert.equal(verifyWorkerAccessToken(secret, "0".repeat(128), WORKER_TOKEN_WINDOW_MS), false);
  assert.equal(verifyWorkerAccessToken(secret, "not-a-token", WORKER_TOKEN_WINDOW_MS), false);
});
