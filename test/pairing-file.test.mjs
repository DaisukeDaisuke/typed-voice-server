import test from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import { encodeEncryptedPairingFile, encodeEncryptedPairingText } from "../server/pairing-file.mjs";

const WRAP_KEY = Buffer.from("7f4b44d58e50e4b0de47d486bb11e16af31d8a78f4bbcd221ffb6b349911929a", "hex");
const AAD = Buffer.from("typed-voice-remote-pairing-file/v1", "utf8");

test("pairing fileはAES-GCMでJSONを包み、生JSONを露出しない", () => {
  const pairing = {
    v: 1,
    u: "wss://example.trycloudflare.com/remote",
    a: "authentication-secret",
    e: "encryption-secret",
    c: "checksum",
  };
  const iv = Buffer.from("000102030405060708090a0b", "hex");
  const encoded = encodeEncryptedPairingFile(pairing, iv);
  assert.equal(encoded.includes(Buffer.from(pairing.u, "utf8")), false);
  assert.equal(encoded.subarray(0, 8).toString("ascii"), "TVRKEY1\0");
  const tag = encoded.subarray(encoded.length - 16);
  const ciphertext = encoded.subarray(20, encoded.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", WRAP_KEY, iv, { authTagLength: 16 });
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  const decoded = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
  assert.deepEqual(decoded, pairing);
});

test("QR向けpairing textも生JSONを含まない", () => {
  const pairing = {
    v: 1,
    u: "wss://example.trycloudflare.com/remote",
    a: "authentication-secret",
    e: "encryption-secret",
    c: "checksum",
  };
  const encoded = encodeEncryptedPairingText(pairing, Buffer.from("000102030405060708090a0b", "hex"));
  assert.match(encoded, /^tvrkey1:[A-Za-z0-9_-]+$/);
  assert.equal(encoded.includes(pairing.u), false);
});
