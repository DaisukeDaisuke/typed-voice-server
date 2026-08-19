import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  POSIX_PRIVATE_FILE_MODE,
  privateFileWriteOptions,
  writePrivateFileAtomic,
} from "../server/private-file.mjs";

test("WindowsではPOSIX modeをwriteFileへ渡さない", () => {
  assert.deepEqual(privateFileWriteOptions("win32", "utf8"), { encoding: "utf8" });
});

test("POSIXでは0600をwriteFileへ渡す", () => {
  assert.deepEqual(privateFileWriteOptions("linux", "utf8"), {
    encoding: "utf8",
    mode: POSIX_PRIVATE_FILE_MODE,
  });
});

test("private fileは原子的に置換しPOSIXでは0600を維持する", async () => {
  const root = await mkdtemp(join(tmpdir(), "typed-voice-private-file-"));
  const path = join(root, "nested", "token.txt");
  try {
    await writePrivateFileAtomic(path, "first", { encoding: "utf8" });
    await writePrivateFileAtomic(path, "second", { encoding: "utf8" });
    assert.equal(await readFile(path, "utf8"), "second");
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});