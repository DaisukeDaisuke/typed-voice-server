import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertConversationId(value) {
  const id = String(value ?? "").trim();
  if (!CONVERSATION_ID_PATTERN.test(id)) throw new Error("invalid conversation id");
  return id;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class HistoryStore {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
    this.indexPath = join(rootDirectory, "index.json");
    this.metadata = new Map();
    this.eventCache = new Map();
    this.writeTail = Promise.resolve();
  }

  async open() {
    await mkdir(this.rootDirectory, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8"));
      if (Array.isArray(parsed?.conversations)) {
        for (const item of parsed.conversations) {
          if (!item || !CONVERSATION_ID_PATTERN.test(String(item.id ?? ""))) continue;
          this.metadata.set(item.id, {
            id: item.id,
            createdAt: Number(item.createdAt || 0),
            lastAt: Number(item.lastAt || 0),
            requestCount: Number(item.requestCount || 0),
            successCount: Number(item.successCount || 0),
            failureCount: Number(item.failureCount || 0),
            cancelledCount: Number(item.cancelledCount || 0),
            totalDurationMs: Number(item.totalDurationMs || 0),
            lastPreview: String(item.lastPreview ?? "").slice(0, 160),
          });
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return this;
  }

  listMetadata({ limit = 200 } = {}) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 200));
    return [...this.metadata.values()]
      .sort((left, right) => right.lastAt - left.lastAt)
      .slice(0, safeLimit)
      .map(clone);
  }

  getMetadata(conversationId) {
    const id = assertConversationId(conversationId);
    const value = this.metadata.get(id);
    return value ? clone(value) : null;
  }

  async getContent(conversationId, { limit = 500 } = {}) {
    const id = assertConversationId(conversationId);
    const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 500));
    const events = await this.#events(id);
    return {
      metadata: this.getMetadata(id),
      events: events.slice(-safeLimit).map(clone),
      totalEvents: events.length,
    };
  }

  async recordRequest({ conversationId, requestId, text, at = Date.now() }) {
    const id = assertConversationId(conversationId);
    const normalizedText = String(text ?? "");
    const event = {
      kind: "request",
      conversationId: id,
      requestId: String(requestId),
      at: Number(at),
      text: normalizedText,
    };
    const metadata = this.metadata.get(id) ?? {
      id,
      createdAt: event.at,
      lastAt: event.at,
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      cancelledCount: 0,
      totalDurationMs: 0,
      lastPreview: "",
    };
    metadata.lastAt = event.at;
    metadata.requestCount += 1;
    metadata.lastPreview = normalizedText.slice(0, 160);
    this.metadata.set(id, metadata);
    await this.#append(id, event);
    return clone(event);
  }

  async recordResult({ conversationId, requestId, ok, durationMs = 0, cancelled = false, error = null, at = Date.now() }) {
    const id = assertConversationId(conversationId);
    const event = {
      kind: "result",
      conversationId: id,
      requestId: String(requestId),
      at: Number(at),
      ok: Boolean(ok),
      cancelled: Boolean(cancelled),
      durationMs: Math.max(0, Number(durationMs) || 0),
      error: error == null ? null : String(error).slice(0, 1024),
    };
    const metadata = this.metadata.get(id) ?? {
      id,
      createdAt: event.at,
      lastAt: event.at,
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      cancelledCount: 0,
      totalDurationMs: 0,
      lastPreview: "",
    };
    metadata.lastAt = event.at;
    if (event.cancelled) metadata.cancelledCount += 1;
    else if (event.ok) metadata.successCount += 1;
    else metadata.failureCount += 1;
    metadata.totalDurationMs += event.durationMs;
    this.metadata.set(id, metadata);
    await this.#append(id, event);
    return clone(event);
  }

  async flush() {
    await this.writeTail;
  }

  async #events(id) {
    if (this.eventCache.has(id)) return this.eventCache.get(id);
    let events = [];
    try {
      const text = await readFile(this.#eventPath(id), "utf8");
      events = text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.eventCache.set(id, events);
    return events;
  }

  async #append(id, event) {
    const task = this.writeTail.then(async () => {
      await appendFile(this.#eventPath(id), `${JSON.stringify(event)}\n`, "utf8");
      const cached = this.eventCache.get(id);
      if (cached) cached.push(event);
      await this.#persistIndex();
    });
    this.writeTail = task.catch(() => {});
    return task;
  }

  async #persistIndex() {
    const temporary = `${this.indexPath}.tmp`;
    const body = JSON.stringify({
      version: 1,
      conversations: this.listMetadata({ limit: 100000 }),
    });
    await writeFile(temporary, body, "utf8");
    await rename(temporary, this.indexPath);
  }

  #eventPath(id) {
    return join(this.rootDirectory, `${id}.ndjson`);
  }
}

