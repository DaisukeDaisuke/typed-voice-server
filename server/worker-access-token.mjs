import { createHmac, timingSafeEqual } from "node:crypto";

export const WORKER_TOKEN_WINDOW_MS = 10 * 60 * 1000;
export const WORKER_TOKEN_GRACE_MS = 30 * 1000;
const TOKEN_LABEL = Buffer.from("typed-voice-trusted-worker-access/v1\0", "utf8");

function validateSecret(secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== 64) throw new Error("worker access secret must be 64 bytes");
  return secret;
}

function windowNumber(now) {
  const value = Number(now);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("worker token time must be a non-negative safe integer");
  return Math.floor(value / WORKER_TOKEN_WINDOW_MS);
}

function windowBuffer(value) {
  const result = Buffer.allocUnsafe(8);
  result.writeBigUInt64BE(BigInt(value), 0);
  return result;
}

function safeTokenEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue ?? ""), "ascii");
  const right = Buffer.from(String(rightValue ?? ""), "ascii");
  return left.length === right.length && right.length === 128 && timingSafeEqual(left, right);
}

export function deriveWorkerAccessToken(secret, window) {
  validateSecret(secret);
  if (!Number.isSafeInteger(window) || window < 0) throw new Error("worker token window must be a non-negative safe integer");
  return createHmac("sha512", secret)
    .update(TOKEN_LABEL)
    .update(windowBuffer(window))
    .digest("hex");
}

export function currentWorkerAccessToken(secret, now = Date.now()) {
  validateSecret(secret);
  const currentWindow = windowNumber(now);
  const validFrom = currentWindow * WORKER_TOKEN_WINDOW_MS;
  return {
    token: deriveWorkerAccessToken(secret, currentWindow),
    window: currentWindow,
    validFrom,
    expiresAt: validFrom + WORKER_TOKEN_WINDOW_MS,
  };
}

export function verifyWorkerAccessToken(secret, token, now = Date.now()) {
  validateSecret(secret);
  const supplied = String(token ?? "");
  if (!/^[0-9a-f]{128}$/.test(supplied)) return false;
  const current = currentWorkerAccessToken(secret, now);
  if (safeTokenEqual(supplied, current.token)) return true;
  if (current.window === 0 || Number(now) - current.validFrom >= WORKER_TOKEN_GRACE_MS) return false;
  return safeTokenEqual(supplied, deriveWorkerAccessToken(secret, current.window - 1));
}

export function millisecondsUntilWorkerTokenRotation(now = Date.now()) {
  const value = Number(now);
  const currentWindow = windowNumber(value);
  return Math.max(1, ((currentWindow + 1) * WORKER_TOKEN_WINDOW_MS) - value);
}
