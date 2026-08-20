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
  readClientAuth,
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

test("匿名端末ハッシュをサーバーsaltとAUTH証明へ結び付ける", () => {
  const authKey = randomBytes(32);
  const encryptionKey = randomBytes(32);
  const clientNonce = randomBytes(32);
  const clientBanSalt = randomBytes(32);
  const clientHash = randomBytes(32);
  const hello = Buffer.concat([
    Buffer.from([Opcode.HELLO_CLIENT, VERSION, AudioFormat.FLOAT32LE, 0]),
    clientNonce,
  ]);
  const accepted = acceptClientHello(hello, authKey, encryptionKey, { clientBanSalt });
  assert.equal(accepted.hello.length, 100);
  assert.equal(accepted.hello[3], 1);
  assert.deepEqual(accepted.hello.subarray(68), clientBanSalt);
  const serverNonce = accepted.hello.subarray(4, 36);
  const clientProof = createHmac("sha256", authKey)
    .update(Buffer.concat([proofInput("client", AudioFormat.FLOAT32LE, clientNonce, serverNonce), clientHash]))
    .digest();
  const auth = Buffer.concat([
    Buffer.from([Opcode.AUTH, VERSION, AudioFormat.FLOAT32LE, 0]),
    clientProof,
    clientHash,
  ]);
  const parsed = readClientAuth(auth, accepted.session);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.clientHash, clientHash.toString("hex"));
  const tampered = Buffer.from(auth);
  tampered[tampered.length - 1] ^= 1;
  assert.equal(readClientAuth(tampered, accepted.session).valid, false);
});

test("再接続用client instance IDは匿名端末ハッシュと一緒にAUTH証明へ結び付ける", () => {
  const authKey = randomBytes(32);
  const encryptionKey = randomBytes(32);
  const clientNonce = randomBytes(32);
  const clientBanSalt = randomBytes(32);
  const clientHash = randomBytes(32);
  const clientInstanceId = randomBytes(16);
  const hello = Buffer.concat([
    Buffer.from([Opcode.HELLO_CLIENT, VERSION, AudioFormat.FLOAT32LE, 0]),
    clientNonce,
  ]);
  const accepted = acceptClientHello(hello, authKey, encryptionKey, { clientBanSalt });
  const serverNonce = accepted.hello.subarray(4, 36);
  const clientProof = createHmac("sha256", authKey)
    .update(Buffer.concat([
      proofInput("client", AudioFormat.FLOAT32LE, clientNonce, serverNonce),
      clientHash,
      clientInstanceId,
    ]))
    .digest();
  const auth = Buffer.concat([
    Buffer.from([Opcode.AUTH, VERSION, AudioFormat.FLOAT32LE, 0]),
    clientProof,
    clientHash,
    clientInstanceId,
  ]);
  const parsed = readClientAuth(auth, accepted.session);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.clientHash, clientHash.toString("hex"));
  assert.equal(parsed.clientInstanceId, clientInstanceId.toString("hex"));

  const tampered = Buffer.from(auth);
  tampered[tampered.length - 1] ^= 1;
  assert.equal(readClientAuth(tampered, accepted.session).valid, false);
});
