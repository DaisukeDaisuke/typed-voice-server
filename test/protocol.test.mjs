import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import {
  AudioFormat,
  Opcode,
  VERSION,
  acceptClientHello,
  decryptFrame,
  encryptFrame,
  verifyClientAuth,
} from "../worker/protocol.mjs";

function proofInput(label, audioFormat, clientNonce, serverNonce) {
  return Buffer.concat([
    Buffer.from(label, "utf8"),
    Buffer.from([VERSION, audioFormat]),
    clientNonce,
    serverNonce,
  ]);
}

test("HELLO/AUTH後に方向別AES-GCMフレームを復号でき、seq再利用を拒否する", () => {
  const authKey = randomBytes(32);
  const encryptionKey = randomBytes(32);
  const clientNonce = randomBytes(32);
  const hello = Buffer.concat([
    Buffer.from([Opcode.HELLO_CLIENT, VERSION, AudioFormat.FLOAT32LE, 0]),
    clientNonce,
  ]);
  const accepted = acceptClientHello(hello, authKey, encryptionKey);
  const serverNonce = accepted.hello.subarray(4, 36);
  const clientProof = createHmac("sha256", authKey)
    .update(proofInput("client", AudioFormat.FLOAT32LE, clientNonce, serverNonce))
    .digest();
  const auth = Buffer.concat([
    Buffer.from([Opcode.AUTH, VERSION, AudioFormat.FLOAT32LE, 0]),
    clientProof,
  ]);
  assert.equal(verifyClientAuth(auth, accepted.session), true);
  const clientReceive = {
    receiveKey: accepted.session.sendKey,
    receiveNoncePrefix: accepted.session.sendNoncePrefix,
    receiveSeq: 0n,
  };
  const encrypted = encryptFrame(accepted.session, {
    op: Opcode.PING,
    id: 123n,
    payload: Buffer.from("ok", "utf8"),
  });
  const decrypted = decryptFrame(clientReceive, encrypted);
  assert.equal(decrypted.op, Opcode.PING);
  assert.equal(decrypted.id, 123n);
  assert.equal(decrypted.payload.toString("utf8"), "ok");
  assert.throws(() => decryptFrame(clientReceive, encrypted), /unexpected receive seq/);
});
