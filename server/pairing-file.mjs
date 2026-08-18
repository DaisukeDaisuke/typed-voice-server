import { createCipheriv } from "node:crypto";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const FILE_MAGIC = Buffer.from("TVRKEY1\0", "ascii");
const FILE_AAD = Buffer.from("typed-voice-remote-pairing-file/v1", "utf8");
const FILE_WRAP_KEY = Buffer.from("7f4b44d58e50e4b0de47d486bb11e16af31d8a78f4bbcd221ffb6b349911929a", "hex");

export function encodeEncryptedPairingFile(pairing, iv) {
  if (!Buffer.isBuffer(iv) || iv.length !== 12) throw new Error("pairing file IV must be 12 bytes");
  const plaintext = Buffer.from(JSON.stringify(pairing), "utf8");
  const cipher = createCipheriv("aes-256-gcm", FILE_WRAP_KEY, iv, { authTagLength: 16 });
  cipher.setAAD(FILE_AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([FILE_MAGIC, iv, ciphertext, cipher.getAuthTag()]);
}

export async function writeEncryptedPairingFile(path, pairing, { randomBytes }) {
  if (typeof randomBytes !== "function") throw new Error("randomBytes function is required");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  const bytes = encodeEncryptedPairingFile(pairing, randomBytes(12));
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
  return realpath(path);
}

export async function removeEncryptedPairingFile(path) {
  await rm(path, { force: true }).catch(() => {});
  await rm(`${path}.tmp`, { force: true }).catch(() => {});
}

export const PAIRING_FILE_FORMAT = Object.freeze({
  magic: FILE_MAGIC.toString("ascii"),
  aad: FILE_AAD.toString("utf8"),
});
