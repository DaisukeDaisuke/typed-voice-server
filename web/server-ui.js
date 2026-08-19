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
const clientDialog = document.getElementById("server-client-dialog");
const clientDialogTitle = document.getElementById("server-client-dialog-title");
const clientDialogId = document.getElementById("server-client-dialog-id");
const clientDialogSessions = document.getElementById("server-client-dialog-sessions");
const clientBanButton = document.getElementById("server-client-ban");
const clientUnbanButton = document.getElementById("server-client-unban");
const clientBanList = document.getElementById("server-client-ban-list");
const clientBanEmpty = document.getElementById("server-client-ban-empty");
const workerList = document.getElementById("server-worker-list");
const workerCount = document.getElementById("server-worker-count");
const workerTemplate = document.getElementById("server-worker-template");
const modelForm = document.getElementById("server-model-form");
const modelProfileSelect = document.getElementById("server-model-profile");
const modelStatus = document.getElementById("server-model-status");
const stateFields = {
  tunnel: document.getElementById("state-tunnel"),
  engine: document.getElementById("state-engine"),
  model: document.getElementById("state-model"),
  client: document.getElementById("state-client"),
  work: document.getElementById("state-work"),
};

let socket = null;
let pairingFingerprint = null;
let qrModulePromise = null;
let selectedConversationId = null;
let selectedHistoryMetadata = null;
let selectedHistoryEvents = [];
let serverModelProfile = null;
let modelSelectionDirty = false;
let currentSessions = [];
let currentClientBans = [];
let selectedClientHash = null;
const modelRequests = new Set();
const clientBanRequests = new Set();

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(new TextEncoder().encode(JSON.stringify(message)));
  return true;
}

function renderState(state) {
  overallStatus.textContent = state.overall || "準備中";
  overallStatus.dataset.state = state.pairingReady ? "ready" : state.overall === "起動失敗" ? "error" : "waiting";
  stateFields.tunnel.textContent = state.tunnel || "待機中";
  stateFields.engine.textContent = state.engine || "待機中";
  stateFields.model.textContent = state.model || "待機中";
  stateFields.client.textContent = String(state.clients ?? 0);
  stateFields.work.textContent = `${state.runningJobs ?? 0} / ${state.queuedJobs ?? 0}`;
  pairingEndpoint.textContent = state.pairingEndpoint || "未準備";
  pairingVersion.textContent = state.pairingReady ? "v1" : "接続情報待ち";
  if (state.modelProfile) {
    serverModelProfile = state.modelProfile;
    if (!modelSelectionDirty && modelRequests.size === 0 && modelProfileSelect.value !== state.modelProfile) {
      modelProfileSelect.value = state.modelProfile;
    }
    if (!modelSelectionDirty && modelRequests.size === 0) modelStatus.textContent = `現在: ${state.modelProfile}`;
  }
  renderSessions(state.sessions);
  renderWorkers(state.engineSlots);
  currentClientBans = Array.isArray(state.clientBans) ? state.clientBans : [];
  renderClientBanList();
  if (selectedClientHash && clientDialog.open) renderClientDialog(selectedClientHash);
}

function renderWorkers(slots) {
  const values = Array.isArray(slots) ? slots : [];
  workerList.replaceChildren();
  workerCount.textContent = `${values.length}件`;
  for (const slot of values) {
    const row = workerTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector(".server-worker-name").textContent = `slot ${slot.index}`;
    row.querySelector(".server-worker-state").textContent = slot.connected
      ? slot.busy ? "合成中" : slot.info?.ready ? "待機" : slot.authenticated ? "モデル準備中" : "鍵交換中"
      : "切断";
    row.querySelector(".server-worker-backend").textContent = slot.info
      ? `${slot.info.backend || "unknown"} / ${slot.info.profile || "profile?"}${slot.lastPongAt ? ` / PONG ${new Date(slot.lastPongAt).toLocaleTimeString("ja-JP")}` : ""}`
      : "暗号化Workerセッション準備中";
    workerList.append(row);
  }
}

function renderSessions(sessions) {
  const values = Array.isArray(sessions) ? sessions : [];
  currentSessions = values;
  sessionList.replaceChildren();
  sessionCount.textContent = `${values.length}件`;
  sessionEmpty.hidden = values.length > 0;
  for (const session of values) {
    const row = sessionTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector(".server-session-id").textContent = session.conversationId || `接続 ${session.connectionId}`;
    const seen = new Date(Number(session.lastSeenAt || session.connectedAt || Date.now()));
    row.querySelector(".server-session-seen").textContent = `最終通信 ${seen.toLocaleString("ja-JP")}`;
    row.querySelector(".server-session-count-value").textContent = `合成 ${Number(session.requests || 0)} / 処理中 ${Number(session.pending || 0)}`;
    const shortClientId = /^[0-9a-f]{64}$/.test(String(session.clientHash ?? "")) ? `${session.clientHash.slice(0, 12)}…` : "ID待機中";
    row.querySelector(".server-session-text").textContent = session.conversationId
      ? `connection ${session.connectionId} / client ${shortClientId}`
      : `会話UUIDの通知待ち / client ${shortClientId}`;
    const clientButton = row.querySelector(".server-session-client");
    clientButton.disabled = !/^[0-9a-f]{64}$/.test(String(session.clientHash ?? ""));
    clientButton.addEventListener("click", () => {
      if (session.clientHash) openClientDialog(session.clientHash);
    });
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

function openClientDialog(clientHash) {
  const normalized = String(clientHash ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) return;
  selectedClientHash = normalized;
  renderClientDialog(normalized);
  clientDialog.showModal();
}

function renderClientDialog(clientHash) {
  const sessions = currentSessions.filter((session) => session.clientHash === clientHash);
  const banned = currentClientBans.includes(clientHash);
  clientDialogTitle.textContent = `${sessions.length}件の接続をまとめて表示`;
  clientDialogId.textContent = clientHash;
  clientDialogSessions.replaceChildren();
  for (const session of sessions) {
    const row = document.createElement("article");
    row.className = "server-client-dialog-session";
    const title = document.createElement("strong");
    title.textContent = session.conversationId || `connection ${session.connectionId}`;
    const meta = document.createElement("span");
    meta.textContent = `最終通信 ${formatTimestamp(session.lastSeenAt || session.connectedAt)} / 合成 ${Number(session.requests || 0)} / 処理中 ${Number(session.pending || 0)}`;
    row.append(title, meta);
    clientDialogSessions.append(row);
  }
  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "server-meta";
    empty.textContent = "このIDの現在接続中の会話はありません。";
    clientDialogSessions.append(empty);
  }
  clientBanButton.hidden = banned;
  clientUnbanButton.hidden = !banned;
}

function renderClientBanList() {
  clientBanList.replaceChildren();
  clientBanEmpty.hidden = currentClientBans.length > 0;
  for (const clientHash of currentClientBans) {
    const row = document.createElement("div");
    row.className = "server-client-ban-row";
    const code = document.createElement("code");
    code.textContent = clientHash;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "解除";
    button.addEventListener("click", () => requestClientBan(clientHash, false));
    row.append(code, button);
    clientBanList.append(row);
  }
}

function requestClientBan(clientHash, banned) {
  const normalized = String(clientHash ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) return;
  const requestId = crypto.randomUUID().replace(/-/g, "");
  clientBanRequests.add(requestId);
  send({ type: "client-ban-set", requestId, clientHash: normalized, banned: Boolean(banned) });
}

function acceptClientBanResponse(message) {
  if (!clientBanRequests.delete(message.requestId)) return;
  if (!message.ok) {
    showError(new Error(message.error || "端末BANを変更できませんでした。"));
    return;
  }
  if (message.banned) {
    if (!currentClientBans.includes(message.clientHash)) currentClientBans = [...currentClientBans, message.clientHash].sort();
  } else {
    currentClientBans = currentClientBans.filter((value) => value !== message.clientHash);
  }
  renderClientBanList();
  if (selectedClientHash === message.clientHash && clientDialog.open) renderClientDialog(selectedClientHash);
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


function acceptModelResponse(message) {
  if (!modelRequests.has(message.requestId)) return;
  modelRequests.delete(message.requestId);
  modelProfileSelect.disabled = false;
  modelForm.querySelector('button[type="submit"]').disabled = false;
  if (message.ok) {
    serverModelProfile = message.modelProfile;
    modelProfileSelect.value = message.modelProfile;
    modelSelectionDirty = false;
  }
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
  const qrPayload = String(pairing.q ?? "");
  if (!/^tvrkey1:[A-Za-z0-9_-]+$/.test(qrPayload)) throw new Error("QR用の暗号化接続情報がありません。");
  const fingerprint = `${pairing.u}\n${pairing.c}`;
  if (pairingFingerprint === fingerprint) return;
  pairingFingerprint = fingerprint;
  qrModulePromise ||= import(QR_MODULE_URL);
  const module = await qrModulePromise;
  const toCanvas = module.toCanvas ?? module.default?.toCanvas;
  if (typeof toCanvas !== "function") throw new Error("QR生成ライブラリを読み込めませんでした。");
  await toCanvas(pairingCanvas, qrPayload, { errorCorrectionLevel: "M", margin: 2, width: 320 });
  pairingPlaceholder.hidden = true;
}

function decodeMessage(data) {
  if (typeof data === "string") return JSON.parse(data);
  if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(data)));
  throw new Error("管理WebSocketから不正な形式を受信しました。");
}

function connect() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/admin/ws`);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    if (location.protocol === "https:") send({ type: "public-origin", origin: location.origin });
    send({ type: "refresh" });
  });
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
      } else if (message.type === "model-response") {
        acceptModelResponse(message);
      } else if (message.type === "client-ban-response") {
        acceptClientBanResponse(message);
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
modelProfileSelect.addEventListener("change", () => {
  modelSelectionDirty = modelProfileSelect.value !== serverModelProfile;
  if (modelSelectionDirty) modelStatus.textContent = `変更候補: ${modelProfileSelect.value}`;
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
clientBanButton.addEventListener("click", () => {
  if (selectedClientHash) requestClientBan(selectedClientHash, true);
});
clientUnbanButton.addEventListener("click", () => {
  if (selectedClientHash) requestClientBan(selectedClientHash, false);
});
clientDialog.addEventListener("close", () => {
  selectedClientHash = null;
});
renderHistory();
connect();
