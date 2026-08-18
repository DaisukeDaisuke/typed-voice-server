const ADMIN_TOKEN_KEY = "typed-voice-server-admin-token-v1";
const QR_MODULE_URL = "https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm";

const overallStatus = document.getElementById("server-overall-status");
const pairingCanvas = document.getElementById("server-pairing-qr");
const pairingPlaceholder = document.getElementById("server-pairing-placeholder");
const pairingEndpoint = document.getElementById("server-pairing-endpoint");
const pairingVersion = document.getElementById("server-pairing-version");
const historyForm = document.getElementById("server-history-form");
const historyUuidInput = document.getElementById("server-history-uuid");
const historyMetadata = document.getElementById("server-history-metadata");
const historyList = document.getElementById("server-history-list");
const historyEmpty = document.getElementById("server-history-empty");
const historyCount = document.getElementById("server-history-count");
const historyTemplate = document.getElementById("server-history-template");
const sessionList = document.getElementById("server-session-list");
const sessionEmpty = document.getElementById("server-session-empty");
const sessionCount = document.getElementById("server-session-count");
const sessionTemplate = document.getElementById("server-session-template");
const workerList = document.getElementById("server-worker-list");
const workerCount = document.getElementById("server-worker-count");
const workerTemplate = document.getElementById("server-worker-template");
const modelForm = document.getElementById("server-model-form");
const modelProfileSelect = document.getElementById("server-model-profile");
const modelStatus = document.getElementById("server-model-status");
const debugForm = document.getElementById("server-debug-form");
const debugSlotInput = document.getElementById("server-debug-slot");
const debugExpression = document.getElementById("server-debug-expression");
const debugResult = document.getElementById("server-debug-result");
const stateFields = {
  tunnel: document.getElementById("state-tunnel"),
  chrome: document.getElementById("state-chrome"),
  webmcp: document.getElementById("state-webmcp"),
  model: document.getElementById("state-model"),
  control: document.getElementById("state-control"),
  adminWorker: document.getElementById("state-admin-worker"),
  publicWorker: document.getElementById("state-public-worker"),
  client: document.getElementById("state-client"),
  work: document.getElementById("state-work"),
};

let socket = null;
let pairingFingerprint = null;
let qrModulePromise = null;
let selectedConversationId = null;
let selectedHistoryMetadata = null;
let selectedHistoryEvents = [];
const debugRequests = new Set();
const modelRequests = new Set();

function readAdminToken() {
  const fragment = location.hash.slice(1);
  if (fragment) {
    if (/^[A-Za-z0-9_-]{40,100}$/.test(fragment)) {
      sessionStorage.setItem(ADMIN_TOKEN_KEY, fragment);
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      return fragment;
    }
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
  const stored = sessionStorage.getItem(ADMIN_TOKEN_KEY) || "";
  return /^[A-Za-z0-9_-]{40,100}$/.test(stored) ? stored : null;
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(new TextEncoder().encode(JSON.stringify(message)));
  return true;
}

function renderState(state) {
  overallStatus.textContent = state.overall || "準備中";
  overallStatus.dataset.state = state.pairingReady ? "ready" : state.overall === "起動失敗" ? "error" : "waiting";
  stateFields.tunnel.textContent = state.tunnel || "待機中";
  stateFields.chrome.textContent = state.chrome || "待機中";
  stateFields.webmcp.textContent = state.webmcp || "待機中";
  stateFields.model.textContent = state.model || "待機中";
  stateFields.control.textContent = state.control || "待機中";
  stateFields.adminWorker.textContent = state.adminWorker || "待機中";
  stateFields.publicWorker.textContent = state.publicWorker || "待機中";
  stateFields.client.textContent = String(state.clients ?? 0);
  stateFields.work.textContent = `${state.runningJobs ?? 0} / ${state.queuedJobs ?? 0}`;
  pairingEndpoint.textContent = state.pairingEndpoint || "未準備";
  pairingVersion.textContent = state.pairingReady ? "v1" : "接続情報待ち";
  if (state.modelProfile && modelProfileSelect.value !== state.modelProfile) modelProfileSelect.value = state.modelProfile;
  if (state.modelProfile) modelStatus.textContent = `現在: ${state.modelProfile}`;
  renderSessions(state.sessions);
  renderWorkers(state.engineSlots);
}

function renderWorkers(slots) {
  const values = Array.isArray(slots) ? slots : [];
  workerList.replaceChildren();
  workerCount.textContent = `${values.length}件`;
  for (const slot of values) {
    const row = workerTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector(".server-worker-name").textContent = `slot ${slot.index}`;
    row.querySelector(".server-worker-state").textContent = slot.connected
      ? slot.busy ? "合成中" : slot.info ? "待機" : "接続中"
      : "切断";
    row.querySelector(".server-worker-backend").textContent = slot.info
      ? `${slot.info.backend || "unknown"} / ${slot.info.profile || "profile?"}`
      : "WebMCP未準備";
    workerList.append(row);
  }
}

function renderSessions(sessions) {
  const values = Array.isArray(sessions) ? sessions : [];
  sessionList.replaceChildren();
  sessionCount.textContent = `${values.length}件`;
  sessionEmpty.hidden = values.length > 0;
  for (const session of values) {
    const row = sessionTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector(".server-session-id").textContent = session.conversationId || `接続 ${session.connectionId}`;
    const seen = new Date(Number(session.lastSeenAt || session.connectedAt || Date.now()));
    row.querySelector(".server-session-seen").textContent = `最終通信 ${seen.toLocaleString("ja-JP")}`;
    row.querySelector(".server-session-count-value").textContent = `合成 ${Number(session.requests || 0)} / 処理中 ${Number(session.pending || 0)}`;
    row.querySelector(".server-session-text").textContent = session.conversationId ? `connection ${session.connectionId}` : "会話UUIDの通知待ち";
    const historyButton = row.querySelector(".server-session-history");
    historyButton.disabled = !session.conversationId;
    historyButton.addEventListener("click", () => {
      if (session.conversationId) void openHistory(session.conversationId);
    });
    row.querySelector(".server-session-disconnect").addEventListener("click", () => {
      send({ type: "disconnect", connectionId: session.connectionId });
    });
    sessionList.append(row);
  }
}

async function openHistory(conversationId) {
  const id = String(conversationId ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
    showError(new Error("会話UUIDの形式が正しくありません。"));
    return;
  }
  if (selectedConversationId && selectedConversationId !== id) send({ type: "history-unsubscribe" });
  selectedConversationId = id;
  selectedHistoryMetadata = null;
  selectedHistoryEvents = [];
  historyUuidInput.value = id;
  historyCount.textContent = "取得中";
  historyMetadata.hidden = true;
  historyEmpty.hidden = false;
  historyEmpty.querySelector("strong").textContent = "履歴を取得しています";
  historyEmpty.querySelector("span").textContent = id;
  renderHistory();
  const requestId = crypto.randomUUID().replace(/-/g, "");
  send({ type: "history-get", requestId, conversationId: id });
  send({ type: "history-subscribe", conversationId: id });
}

function acceptHistoryResponse(message) {
  if (message.conversationId !== selectedConversationId) return;
  if (!message.ok) {
    showError(new Error(message.error || "履歴を取得できませんでした。"));
    return;
  }
  selectedHistoryMetadata = message.metadata ?? null;
  selectedHistoryEvents = Array.isArray(message.events) ? message.events : [];
  renderHistory();
}

function acceptHistoryEvent(message) {
  if (message.conversationId !== selectedConversationId || !message.event) return;
  selectedHistoryMetadata = message.metadata ?? selectedHistoryMetadata;
  selectedHistoryEvents.push(message.event);
  if (selectedHistoryEvents.length > 5000) selectedHistoryEvents = selectedHistoryEvents.slice(-5000);
  renderHistory();
}

function acceptDebugResponse(message) {
  if (!debugRequests.has(message.requestId)) return;
  debugRequests.delete(message.requestId);
  if (!message.ok) {
    debugResult.textContent = `ERROR\n${message.error || "debug evaluation failed"}`;
    return;
  }
  debugResult.textContent = JSON.stringify(message.result, null, 2);
}

function acceptModelResponse(message) {
  if (!modelRequests.has(message.requestId)) return;
  modelRequests.delete(message.requestId);
  modelProfileSelect.disabled = false;
  modelForm.querySelector('button[type="submit"]').disabled = false;
  modelStatus.textContent = message.ok
    ? `変更済み: ${message.modelProfile}`
    : `変更失敗: ${message.error || "unknown error"}`;
}

function renderHistory() {
  historyList.replaceChildren();
  if (!selectedConversationId) {
    historyCount.textContent = "未選択";
    historyMetadata.hidden = true;
    historyEmpty.hidden = false;
    historyEmpty.querySelector("strong").textContent = "UUIDを指定してください";
    historyEmpty.querySelector("span").textContent = "指定した会話だけを取得・監視します。";
    return;
  }
  historyCount.textContent = `${selectedHistoryEvents.length}イベント`;
  if (selectedHistoryMetadata) {
    historyMetadata.hidden = false;
    historyMetadata.textContent = [
      `UUID: ${selectedHistoryMetadata.id}`,
      `要求: ${selectedHistoryMetadata.requestCount} / 成功: ${selectedHistoryMetadata.successCount} / 失敗: ${selectedHistoryMetadata.failureCount} / キャンセル: ${selectedHistoryMetadata.cancelledCount}`,
      `初回: ${formatTimestamp(selectedHistoryMetadata.createdAt)} / 最終: ${formatTimestamp(selectedHistoryMetadata.lastAt)}`,
      `合計処理時間: ${selectedHistoryMetadata.totalDurationMs} ms`,
    ].join("\n");
  } else {
    historyMetadata.hidden = true;
  }
  historyEmpty.hidden = selectedHistoryEvents.length > 0;
  if (!selectedHistoryEvents.length) {
    historyEmpty.querySelector("strong").textContent = "このUUIDの履歴はありません";
    historyEmpty.querySelector("span").textContent = selectedConversationId;
    return;
  }
  for (const event of selectedHistoryEvents.slice(-500).reverse()) {
    const row = historyTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector(".server-history-time").textContent = formatTimestamp(event.at);
    row.querySelector(".server-history-text").textContent = event.kind === "request"
      ? event.text || "(空)"
      : event.error || `request ${event.requestId}`;
    row.querySelector(".server-history-result").textContent = event.kind === "request"
      ? "要求"
      : event.cancelled
        ? "キャンセル"
        : event.ok
          ? `${event.durationMs} ms`
          : "失敗";
    historyList.append(row);
  }
}

function formatTimestamp(value) {
  const date = new Date(Number(value || 0));
  return Number.isNaN(date.valueOf()) ? "-" : date.toLocaleString("ja-JP");
}

async function renderPairing(pairing) {
  if (!pairing || typeof pairing !== "object") return;
  const json = JSON.stringify(pairing);
  const fingerprint = `${pairing.u}\n${pairing.c}`;
  if (pairingFingerprint === fingerprint) return;
  pairingFingerprint = fingerprint;
  qrModulePromise ||= import(QR_MODULE_URL);
  const module = await qrModulePromise;
  const toCanvas = module.toCanvas ?? module.default?.toCanvas;
  if (typeof toCanvas !== "function") throw new Error("QR生成ライブラリを読み込めませんでした。");
  await toCanvas(pairingCanvas, json, { errorCorrectionLevel: "M", margin: 2, width: 320 });
  pairingPlaceholder.hidden = true;
}

function decodeMessage(data) {
  if (typeof data === "string") return JSON.parse(data);
  if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(data)));
  throw new Error("管理WebSocketから不正な形式を受信しました。");
}

function connect() {
  const token = readAdminToken();
  if (!token) {
    overallStatus.textContent = "server-main.mjsから開き直してください";
    overallStatus.dataset.state = "error";
    return;
  }
  socket = new WebSocket(`ws://${location.host}/admin`);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => send({ type: "auth", token }));
  socket.addEventListener("message", (event) => {
    try {
      const message = decodeMessage(event.data);
      if (message.type === "snapshot") {
        renderState(message.state || {});
        void renderPairing(message.pairing).catch(showError);
      } else if (message.type === "state") {
        renderState(message.state || {});
      } else if (message.type === "pairing") {
        void renderPairing(message.pairing).catch(showError);
      } else if (message.type === "history-response") {
        acceptHistoryResponse(message);
      } else if (message.type === "history-event") {
        acceptHistoryEvent(message);
      } else if (message.type === "debug-response") {
        acceptDebugResponse(message);
      } else if (message.type === "model-response") {
        acceptModelResponse(message);
      }
    } catch (error) {
      showError(error);
    }
  });
  socket.addEventListener("close", () => {
    overallStatus.textContent = "ローカル管理WebSocketが切断されました";
    overallStatus.dataset.state = "error";
  });
  socket.addEventListener("error", () => showError(new Error("ローカル管理WebSocketへ接続できません。")));
}

function showError(error) {
  overallStatus.textContent = error instanceof Error ? error.message : String(error);
  overallStatus.dataset.state = "error";
}

historyForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void openHistory(historyUuidInput.value);
});
debugForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const slot = Number(debugSlotInput.value);
  const expression = debugExpression.value;
  if (!Number.isSafeInteger(slot) || slot < 0 || !expression.trim()) {
    debugResult.textContent = "slotとJavaScriptを指定してください。";
    return;
  }
  const requestId = crypto.randomUUID().replace(/-/g, "");
  debugRequests.add(requestId);
  debugResult.textContent = "実行中…";
  send({ type: "debug-eval", requestId, slot, expression });
});
modelForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const modelProfile = modelProfileSelect.value;
  if (!["fp32", "fp16", "mobile-int8", "mobile-int4"].includes(modelProfile)) return;
  const requestId = crypto.randomUUID().replace(/-/g, "");
  modelRequests.add(requestId);
  modelProfileSelect.disabled = true;
  modelForm.querySelector('button[type="submit"]').disabled = true;
  modelStatus.textContent = `切り替え中: ${modelProfile}`;
  send({ type: "model-set", requestId, modelProfile });
});
renderHistory();
connect();
