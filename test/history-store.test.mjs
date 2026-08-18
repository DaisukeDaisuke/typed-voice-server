import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HistoryStore } from "../server/history-store.mjs";

test("UUIDごとにmetadata索引とappend-only履歴を永続化する", async () => {
  const root = await mkdtemp(join(tmpdir(), "typed-voice-history-"));
  try {
    const store = await new HistoryStore(root).open();
    await store.recordRequest({
      conversationId: "conversation-123",
      requestId: "99",
      text: "東京都税関関税許可局、関税許可を急遽却下",
      at: 1000,
    });
    await store.recordResult({
      conversationId: "conversation-123",
      requestId: "99",
      ok: true,
      durationMs: 2345,
      at: 4000,
    });
    const content = await store.getContent("conversation-123");
    assert.equal(content.metadata.requestCount, 1);
    assert.equal(content.metadata.successCount, 1);
    assert.equal(content.metadata.totalDurationMs, 2345);
    assert.equal(content.events.length, 2);
    assert.equal(content.events[0].kind, "request");
    assert.equal(content.events[1].kind, "result");
    const lines = (await readFile(join(root, "conversation-123.ndjson"), "utf8")).trim().split(/\r?\n/u);
    assert.equal(lines.length, 2);
    const reopened = await new HistoryStore(root).open();
    assert.equal(reopened.getMetadata("conversation-123").lastAt, 4000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
