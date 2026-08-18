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
    await first.setAdminPort(54321);
    const reopened = await new ServerSettingsStore(path).open();
    assert.equal(reopened.modelProfile, "mobile-int8");
    assert.equal(reopened.adminPort, 54321);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
