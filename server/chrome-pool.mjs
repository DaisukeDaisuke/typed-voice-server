import { access, mkdir, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { CdpClient } from "./cdp.mjs";

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findChrome(configuredPath = null) {
  const candidates = [];
  if (configuredPath) candidates.push(configuredPath);
  if (process.platform === "win32") {
    if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"));
    if (process.env["ProgramFiles(x86)"]) candidates.push(join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"));
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"));
  }
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error("Google Chrome was not found");
}

async function readDevToolsPort(profileDir) {
  const text = await readFile(join(profileDir, "DevToolsActivePort"), "utf8");
  const port = Number(text.split(/\r?\n/u)[0]?.trim());
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid DevToolsActivePort");
  return port;
}

async function fetchJson(url, { timeoutMs = 1000, method = "GET" } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, method });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverInitialPage(port, deadline) {
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch (error) {
      lastError = error;
    }
    await sleep(50);
  }
  throw new Error(`Chrome page target unavailable: ${lastError?.message ?? "timeout"}`);
}

async function createPage(port, url) {
  const target = await fetchJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    timeoutMs: 5000,
    method: "PUT",
  });
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome did not return a debugger URL for the new engine tab");
  return target;
}

function normalizeWebMcp(value) {
  if (value && typeof value === "object" && typeof value.status === "string" && Object.hasOwn(value, "output")) {
    if (value.status === "Completed") return value.output;
    throw new Error(`WebMCP ${value.status}: ${typeof value.output === "string" ? value.output : value.error?.message ?? "failed"}`);
  }
  return value;
}

class EngineTab {
  constructor({ index, target, startupTimeoutMs, onDisconnect = () => {}, onDiagnostic = () => {} }) {
    this.index = index;
    this.target = target;
    this.startupTimeoutMs = startupTimeoutMs;
    this.onDisconnect = onDisconnect;
    this.onDiagnostic = onDiagnostic;
    this.cdp = null;
    this.busy = false;
    this.info = null;
    this.fatalError = null;
    this.lastDiagnostic = null;
  }

  async start() {
    this.cdp = new CdpClient(this.target.webSocketDebuggerUrl, {
      onClose: () => {
        this.info = null;
        this.busy = false;
        this.onDisconnect(this.index);
      },
      onEvent: (method, params) => this.#acceptCdpEvent(method, params),
      onProtocolError: (error) => {
        this.fatalError = error;
        this.#reportDiagnostic(error.message);
      },
    });
    await this.cdp.connect(10_000);
    await Promise.all([this.cdp.send("Page.enable"), this.cdp.send("Runtime.enable"), this.cdp.send("Log.enable")]);
    await this.#waitUntilReady(Date.now() + this.startupTimeoutMs);
  }

  #reportDiagnostic(message) {
    const normalized = String(message ?? "").trim();
    if (!normalized || normalized === this.lastDiagnostic) return;
    this.lastDiagnostic = normalized;
    this.onDiagnostic(normalized);
  }

  #acceptCdpEvent(method, params) {
    if (method === "Runtime.exceptionThrown") {
      const details = params?.exceptionDetails;
      const message = details?.exception?.description ?? details?.text ?? "browser exception";
      this.fatalError = new Error(`engine tab ${this.index}: ${message}`);
      this.#reportDiagnostic(this.fatalError.message);
      return;
    }
    if (method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(params?.type)) {
      const message = (params.args ?? []).map((argument) => argument.value ?? argument.description ?? argument.type).join(" ");
      this.#reportDiagnostic(`browser console ${params.type}: ${message}`);
      return;
    }
    if (method === "Log.entryAdded" && ["error", "warning"].includes(params?.entry?.level)) {
      this.#reportDiagnostic(`browser ${params.entry.level}: ${params.entry.text ?? "log entry"}`);
    }
  }

  async #callWebMcp(toolName, input = {}, timeoutMs = 600_000) {
    const global = await this.cdp.send("Runtime.evaluate", { expression: "globalThis", returnByValue: false }, timeoutMs);
    const objectId = global.result?.objectId;
    if (!objectId) throw new Error("page global object unavailable");
    const result = await this.cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `async function(toolName, input) {
        const modelContext = document.modelContext;
        if (!modelContext || typeof modelContext.getTools !== 'function' || typeof modelContext.executeTool !== 'function') throw new Error('WebMCP API unavailable');
        const tools = await modelContext.getTools();
        const matches = tools.filter((tool) => tool.name === toolName);
        if (matches.length !== 1) throw new Error('WebMCP tool ' + toolName + ' count=' + matches.length);
        return await modelContext.executeTool(matches[0], JSON.stringify(input));
      }`,
      arguments: [{ value: toolName }, { value: input }],
      awaitPromise: true,
      returnByValue: true,
    }, timeoutMs);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "WebMCP execution failed");
    }
    return normalizeWebMcp(result.result?.value ?? null);
  }

  async #waitUntilReady(deadline) {
    let lastError;
    while (Date.now() < deadline) {
      if (this.fatalError) throw this.fatalError;
      let raw;
      try {
        raw = await this.#callWebMcp("typed-voice.status", {}, 5000);
      } catch (error) {
        lastError = error;
        this.#reportDiagnostic(`WebMCP待機中: ${error instanceof Error ? error.message : String(error)}`);
        const pageFailure = await this.#readPageFailure().catch((diagnosticError) => {
          this.#reportDiagnostic(`ページ状態取得失敗: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`);
          return null;
        });
        if (pageFailure) throw new Error(pageFailure);
        await sleep(200);
        continue;
      }
      const status = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (status?.error) throw new Error(`engine tab ${this.index}: ${status.error}`);
      if (status?.ready) {
        this.info = status;
        return;
      }
      await sleep(200);
    }
    throw new Error(`engine tab ${this.index} did not become ready: ${lastError?.message ?? "timeout"}`);
  }

  async #readPageFailure() {
    const result = await this.cdp.send("Runtime.evaluate", {
      expression: "document.getElementById('server-engine-status')?.textContent || ''",
      returnByValue: true,
    }, 5000);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "page status evaluation failed");
    }
    const status = String(result.result?.value ?? "");
    return status.startsWith("起動失敗:") ? `engine tab ${this.index}: ${status}` : null;
  }

  async synthesize(id, text) {
    const raw = await this.#callWebMcp("typed-voice.synthesize", { id, text });
    const result = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!result?.audioBase64 || !Number.isSafeInteger(result.sampleRate) || !Number.isSafeInteger(result.sampleCount)) {
      throw new Error("typed-voice.synthesize returned invalid audio metadata");
    }
    const audio = Buffer.from(result.audioBase64, "base64");
    if (audio.length !== result.sampleCount * 4) throw new Error("typed-voice.synthesize returned invalid Float32 byte length");
    return { sampleRate: result.sampleRate, sampleCount: result.sampleCount, audio };
  }

  async cancel(id) {
    await this.#callWebMcp("typed-voice.cancel", { id }, 10_000).catch(() => {});
  }

  async debugEvaluate(expression) {
    const source = String(expression ?? "");
    if (!source.trim()) throw new Error("debug expression is empty");
    if (source.length > 64 * 1024) throw new Error("debug expression is too large");
    const result = await this.cdp.send("Runtime.evaluate", {
      expression: source,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, 60_000);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "browser debug evaluation failed");
    }
    return {
      type: result.result?.type ?? "undefined",
      value: result.result?.value ?? null,
      description: result.result?.description ?? null,
    };
  }

  close() {
    this.cdp?.close();
    this.cdp = null;
  }
}

export class ChromeEnginePool {
  constructor({ count = 1, chromePath, engineUrl, startupTimeoutMs = 600_000, onState = () => {}, onDiagnostic = () => {}, profileDir = null, processTracker = null }) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 8) throw new Error("multi must be 1..8");
    this.count = count;
    this.chromePath = chromePath;
    this.engineUrl = engineUrl;
    this.startupTimeoutMs = startupTimeoutMs;
    this.onState = onState;
    this.onDiagnostic = onDiagnostic;
    if (!profileDir) throw new Error("profileDir is required so the Chrome model cache survives restarts");
    this.profileDir = profileDir;
    this.processTracker = processTracker;
    this.chrome = null;
    this.chromeStartError = null;
    this.port = 0;
    this.engines = [];
    this.jobs = new Map();
    this.queue = [];
    this.dispatchPaused = false;
    this.idleWaiters = new Set();
  }

  #engineUrl(index) {
    const url = new URL(this.engineUrl);
    url.searchParams.set("slot", String(index));
    return url.href;
  }

  async start() {
    await mkdir(this.profileDir, { recursive: true });
    this.onState({ chrome: `起動中 0/${this.count}`, webmcp: "待機中", model: "読み込み中" });
    const args = [
      `--user-data-dir=${this.profileDir}`,
      "--remote-debugging-port=0",
      "--enable-features=WebMCPTesting,DevToolsWebMCPSupport",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--no-first-run",
      "--no-default-browser-check",
      this.#engineUrl(0),
    ];
    const chrome = spawn(this.chromePath, args, { stdio: "ignore", windowsHide: true });
    this.chrome = chrome;
    this.chromeStartError = null;
    let tracked = false;
    const untrack = () => {
      if (!tracked) return;
      tracked = false;
      try { this.processTracker?.untrack(chrome.pid); } catch {}
    };
    try {
      this.processTracker?.track(chrome.pid);
      tracked = Boolean(this.processTracker);
    } catch (error) {
      if (chrome.exitCode === null && !chrome.killed) chrome.kill();
      throw error;
    }
    chrome.once("error", (error) => {
      untrack();
      if (this.chrome === chrome) this.chromeStartError = error;
    });
    chrome.once("exit", (code, signal) => {
      untrack();
      if (this.chrome !== chrome) return;
      this.onState({
        chrome: `停止 (${signal ?? code ?? "unknown"})`,
        webmcp: "切断",
        model: "停止",
        engineSlots: this.status().engines,
      });
    });
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (this.chromeStartError) throw this.chromeStartError;
      if (this.chrome.exitCode !== null) throw new Error(`Chrome exited during startup (${this.chrome.exitCode})`);
      try {
        this.port = await readDevToolsPort(this.profileDir);
        break;
      } catch {}
      await sleep(50);
    }
    if (!this.port) throw new Error("Chrome DevTools port unavailable");

    const firstTarget = await discoverInitialPage(this.port, deadline);
    const first = new EngineTab({
      index: 0,
      target: firstTarget,
      startupTimeoutMs: this.startupTimeoutMs,
      onDisconnect: () => this.#notifySlots(),
      onDiagnostic: (message) => this.onDiagnostic({ index: 0, message }),
    });
    this.engines.push(first);
    await first.start();
    this.onState({ chrome: `起動済み 1/${this.count}`, webmcp: `接続済み 1/${this.count}`, model: `準備済み 1/${this.count}` });
    this.#notifySlots();

    const remaining = [];
    for (let index = 1; index < this.count; index += 1) {
      remaining.push((async () => {
        const target = await createPage(this.port, this.#engineUrl(index));
        const engine = new EngineTab({
          index,
          target,
          startupTimeoutMs: this.startupTimeoutMs,
          onDisconnect: () => this.#notifySlots(),
          onDiagnostic: (message) => this.onDiagnostic({ index, message }),
        });
        this.engines.push(engine);
        await engine.start();
        const ready = this.engines.filter((entry) => entry.info).length;
        this.onState({
          chrome: `起動済み ${ready}/${this.count}`,
          webmcp: `接続済み ${ready}/${this.count}`,
          model: `準備済み ${ready}/${this.count}`,
        });
        this.#notifySlots();
      })());
    }
    await Promise.all(remaining);
    this.engines.sort((left, right) => left.index - right.index);
    return this.status();
  }

  status() {
    return {
      engines: this.engines.map((engine) => ({
        index: engine.index,
        busy: engine.busy,
        connected: Boolean(engine.cdp?.socket && engine.cdp.socket.readyState === WebSocket.OPEN),
        info: engine.info,
      })),
      queued: this.queue.length,
      running: this.jobs.size,
    };
  }

  synthesize(id, text) {
    if (this.engines.length !== this.count) throw new Error("Chrome engine pool is not ready");
    if (this.jobs.has(id) || this.queue.some((job) => job.id === id)) throw new Error("duplicate synthesis id");
    const promise = new Promise((resolvePromise, rejectPromise) => {
      this.queue.push({ id, text, resolve: resolvePromise, reject: rejectPromise });
    });
    this.#notifyWork();
    this.#dispatch();
    return promise;
  }

  async reconfigure(engineUrl) {
    const nextUrl = String(engineUrl);
    if (nextUrl === this.engineUrl) return this.status();
    const previousUrl = this.engineUrl;
    this.dispatchPaused = true;
    await this.#waitForRunningJobs();
    await this.#stopChromeOnly();
    this.engineUrl = nextUrl;
    try {
      await this.start();
      return this.status();
    } catch (error) {
      await this.#stopChromeOnly().catch(() => {});
      this.engineUrl = previousUrl;
      try {
        await this.start();
      } catch (rollbackError) {
        for (const job of this.queue.splice(0)) job.reject(rollbackError);
        this.#notifyWork();
        throw new AggregateError([error, rollbackError], "model switch and rollback both failed");
      }
      throw error;
    } finally {
      this.dispatchPaused = false;
      this.#dispatch();
    }
  }

  async cancel(id) {
    const queuedIndex = this.queue.findIndex((job) => job.id === id);
    if (queuedIndex >= 0) {
      const [job] = this.queue.splice(queuedIndex, 1);
      job.reject(new DOMException("Synthesis cancelled", "AbortError"));
      this.#notifyWork();
      return true;
    }
    const engine = this.jobs.get(id);
    if (!engine) return false;
    await engine.cancel(id);
    return true;
  }

  async debugEvaluate(slot, expression) {
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= this.count) throw new Error("invalid engine slot");
    const engine = this.engines.find((entry) => entry.index === slot);
    if (!engine?.cdp || !engine.info) throw new Error(`engine slot ${slot} is not ready`);
    return engine.debugEvaluate(expression);
  }

  #dispatch() {
    if (this.dispatchPaused) return;
    for (const engine of this.engines) {
      if (engine.busy || this.queue.length === 0) continue;
      const job = this.queue.shift();
      engine.busy = true;
      this.jobs.set(job.id, engine);
      this.#notifyWork();
      void engine.synthesize(job.id, job.text).then(job.resolve, job.reject).finally(() => {
        engine.busy = false;
        if (this.jobs.get(job.id) === engine) this.jobs.delete(job.id);
        this.#notifyWork();
        this.#dispatch();
      });
    }
  }

  #notifyWork() {
    this.onState({
      runningJobs: this.jobs.size,
      queuedJobs: this.queue.length,
      engineSlots: this.status().engines,
    });
    if (this.jobs.size === 0) {
      for (const resolvePromise of this.idleWaiters) resolvePromise();
      this.idleWaiters.clear();
    }
  }

  #notifySlots() {
    this.onState({ engineSlots: this.status().engines });
  }

  #waitForRunningJobs() {
    if (this.jobs.size === 0) return Promise.resolve();
    return new Promise((resolvePromise) => this.idleWaiters.add(resolvePromise));
  }

  async #stopChromeOnly() {
    for (const engine of this.engines) engine.close();
    this.engines = [];
    this.jobs.clear();
    if (this.chrome?.exitCode === null && !this.chrome.killed) this.chrome.kill();
    this.chrome = null;
    this.port = 0;
    this.#notifyWork();
  }

  async close() {
    for (const job of this.queue.splice(0)) job.reject(new Error("Chrome engine pool closed"));
    this.dispatchPaused = true;
    await this.#stopChromeOnly();
    this.dispatchPaused = false;
  }
}
