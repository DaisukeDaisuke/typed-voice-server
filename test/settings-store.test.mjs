import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServerSettingsStore } from "../server/settings-store.mjs";

test("選択モデルをNode側設定へ永続化して次回起動で復元する", async () => {
  const root = await mkdtemp(join(tmpdir(), "typed-voice-settings-"));
  try {
    const path = join(root, "settings.json");
    const first = await new ServerSettingsStore(path).open();
    assert.equal(first.modelProfile, "fp16");
    await first.setModelProfile("mobile-int8");
    const reopened = await new ServerSettingsStore(path).open();
    assert.equal(reopened.modelProfile, "mobile-int8");
    assert.match(reopened.clientBanSalt, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(reopened.clientBans, []);
    const clientHash = "ab".repeat(32);
    await reopened.setClientBanned(clientHash, true);
    assert.equal(reopened.isClientBanned(clientHash), true);
    const banned = await new ServerSettingsStore(path).open();
    assert.equal(banned.clientBanSalt, reopened.clientBanSalt);
    assert.deepEqual(banned.clientBans, [clientHash]);
    await banned.setClientBanned(clientHash, false);
    assert.equal(banned.isClientBanned(clientHash), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
