const $ = id => document.getElementById(id);

const elements = {
  statePill: $("statePill"),
  statusLine: $("statusLine"),
  portValue: $("portValue"),
  pidValue: $("pidValue"),
  providerValue: $("providerValue"),
  modelValue: $("modelValue"),
  pluginsValue: $("pluginsValue"),
  pluginsHint: $("pluginsHint"),
  healthValue: $("healthValue"),
  warningValue: $("warningValue"),
  updatedValue: $("updatedValue"),
  logPath: $("logPath"),
  logBox: $("logBox"),
  lastActionTitle: $("lastActionTitle"),
  lastActionBox: $("lastActionBox"),
  actionChip: $("actionChip"),
  copyState: $("copyState"),
  operatorMode: $("operatorMode"),
  modelConfigState: $("modelConfigState"),
  profileSelect: $("profileSelect"),
  modelInput: $("modelInput"),
  reasoningSelect: $("reasoningSelect"),
  verbositySelect: $("verbositySelect"),
  maxTokensInput: $("maxTokensInput"),
  applyModelBtn: $("applyModelBtn"),
  applyRestartModelBtn: $("applyRestartModelBtn"),
  modelConfigHint: $("modelConfigHint"),
  featureHealthRefreshBtn: $("featureHealthRefreshBtn"),
  featureHealthState: $("featureHealthState"),
  featureHealthPlugins: $("featureHealthPlugins"),
  featureHealthTools: $("featureHealthTools"),
  featureHealthManuals: $("featureHealthManuals"),
  featureHealthWarnings: $("featureHealthWarnings"),
  featureHealthChecked: $("featureHealthChecked"),
  featureHealthBox: $("featureHealthBox"),
  startBtn: $("startBtn"),
  stopBtn: $("stopBtn"),
  restartBtn: $("restartBtn"),
  statusBtn: $("statusBtn"),
  refreshBtn: $("refreshBtn"),
  dashboardBtn: $("dashboardBtn"),
  openLogsBtn: $("openLogsBtn"),
  openConfigBtn: $("openConfigBtn"),
  openRootBtn: $("openRootBtn"),
  exitBtn: $("exitBtn"),
  signalCanvas: $("signalCanvas")
};

const actionButtons = [
  elements.startBtn,
  elements.stopBtn,
  elements.restartBtn,
  elements.statusBtn,
  elements.refreshBtn,
  elements.applyModelBtn,
  elements.applyRestartModelBtn,
  elements.featureHealthRefreshBtn
].filter(Boolean);

let busy = false;
let lastRunning = false;
let activeLogFilter = "all";
let latestStatus = null;
let modelCatalog = null;
let suppressModelEvents = false;
const CONTROL_TOKEN_STORAGE_KEY = "imagebot.controlToken";

function readHashParam(name) {
  const hash = window.location.hash || "";
  if (!hash.includes(`${name}=`)) return "";
  const params = new URLSearchParams(hash.slice(1));
  return params.get(name) || "";
}

const bootstrapToken = readHashParam("bootstrap");
let controlToken = sessionStorage.getItem(CONTROL_TOKEN_STORAGE_KEY) || "";
if (controlToken) {
  sessionStorage.setItem(CONTROL_TOKEN_STORAGE_KEY, controlToken);
}
if (bootstrapToken || window.location.hash.includes("token=")) {
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

async function exchangeBootstrapToken() {
  if (!bootstrapToken) return;
  const response = await fetch("/api/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ bootstrap: bootstrapToken })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.token) {
    throw new Error(result.error || "Control bootstrap failed.");
  }
  controlToken = result.token;
  sessionStorage.setItem(CONTROL_TOKEN_STORAGE_KEY, controlToken);
}

async function apiFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (controlToken) headers.set("X-Imagebot-Control-Token", controlToken);
  const request = { ...options, headers, cache: options.cache || "no-store" };
  if (String(request.method || "GET").toUpperCase() === "POST") {
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (request.body == null) request.body = "{}";
  }
  const response = await fetch(path, request);
  if (response.status === 401) {
    sessionStorage.removeItem(CONTROL_TOKEN_STORAGE_KEY);
    controlToken = "";
  }
  return response;
}

function formatTime(value) {
  if (!value) return "--:--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

function titleCase(value) {
  if (!value) return "";
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function setBusy(value) {
  busy = value;
  actionButtons.forEach(button => {
    button.disabled = busy;
  });
}

function severityOf(line) {
  if (/\b(error|failed|exception|fatal|conflict|blocked)\b/i.test(line)) return "error";
  if (/\b(warn|warning|degraded|retry|timeout)\b/i.test(line)) return "warn";
  return "info";
}

function visibleLogLines(lines) {
  if (!Array.isArray(lines)) return [];
  if (activeLogFilter === "all") return lines;
  return lines.filter(line => severityOf(line) === activeLogFilter);
}

function renderLog(status) {
  const lines = visibleLogLines(status.logTail || []);
  if (status.logsRedacted) {
    elements.logBox.textContent = "Gateway log tail is hidden from the panel API. Use Open Logs for local diagnosis.";
  } else {
    elements.logBox.textContent = lines.length ? lines.join("\n") : "No matching gateway log lines.";
  }
  elements.logBox.scrollTop = elements.logBox.scrollHeight;
}

function renderLastAction(action) {
  if (!action) {
    elements.lastActionTitle.textContent = "No action yet";
    elements.lastActionBox.textContent = "Start, stop, restart, or status output will appear here.";
    elements.actionChip.textContent = "Idle";
    elements.actionChip.className = "lock-chip warn";
    return;
  }

  const outcome = action.ok ? "OK" : "Failed";
  const duration = action.durationMs ? ` in ${formatDuration(action.durationMs)}` : "";
  elements.lastActionTitle.textContent = `${outcome}: ${titleCase(action.name)}${duration}`;
  elements.lastActionBox.textContent = action.output || "No script output.";
  elements.actionChip.textContent = `${outcome}: ${action.name}`;
  elements.actionChip.className = `lock-chip ${action.ok ? "good" : "warn"}`;
}

function renderStatus(status) {
  latestStatus = status;
  const running = status.ready || status.state === "running";
  const working = status.actionInFlight || busy;
  const prewarm = status.prewarm || {};
  const memoryPrewarm = status.memoryPrewarm || {};
  const browserPrewarm = status.browserPrewarm || {};
  lastRunning = running;

  elements.statePill.className = `state-pill ${working ? "busy" : running ? "running" : "stopped"}`;
  elements.statePill.querySelector("strong").textContent = working
    ? titleCase(status.actionName || "Working")
    : running
      ? "Running"
      : "Stopped";

  elements.statusLine.textContent = working
    ? `${titleCase(status.actionName || "Action")} is running`
    : running
      ? prewarm.state === "warming"
        ? "Gateway online. Warming Codex runtime."
        : browserPrewarm.state === "warming"
          ? "Gateway online. Warming isolated browser."
          : memoryPrewarm.state === "warming"
            ? "Gateway online. Warming memory index."
        : prewarm.state === "warm"
          ? browserPrewarm.state === "warm"
            ? "Gateway online. Codex and browser warm."
            : "Gateway online. Codex runtime warm."
          : "Gateway online. Telegram provider monitored."
      : "Gateway offline. Panel is standing by.";

  elements.operatorMode.textContent = working ? "WORKING" : running ? "ONLINE" : "OFFLINE";
  elements.portValue.textContent = status.port || "127.0.0.1:18789";
  elements.pidValue.textContent = status.pid || "none";
  elements.providerValue.textContent = status.telegramHandle || (status.providerSeen ? "@YOUR_BOT_USERNAME" : "unknown");
  elements.modelValue.textContent = status.model || "unknown";

  const plugins = Array.isArray(status.plugins) ? status.plugins : [];
  elements.pluginsValue.textContent = status.pluginCount ? `${status.pluginCount} active` : "unknown";
  elements.pluginsHint.textContent = plugins.length ? plugins.join(", ") : "No plugin line yet";

  const warningCount = status.warningCount || 0;
  const errorCount = status.errorCount || 0;
  elements.healthValue.textContent = running
    ? errorCount > 0
      ? "Attention"
      : warningCount > 0
        ? "Watch"
        : "Nominal"
    : "Offline";
  elements.warningValue.textContent = `${warningCount} warn / ${errorCount} err`;
  elements.updatedValue.textContent = formatTime(status.updatedAt);
  elements.logPath.textContent = status.logsRedacted ? "Hidden by local control auth" : status.logPath || "No log yet";

  renderLastAction(status.lastAction);
  if (working) {
    elements.actionChip.textContent = `Running: ${status.actionName || "action"}`;
    elements.actionChip.className = "lock-chip warn";
  }
  renderLog(status);
}

function option(label, value) {
  const item = document.createElement("option");
  item.textContent = label;
  item.value = value;
  return item;
}

function setSelectOptions(select, values, selected) {
  select.textContent = "";
  values.forEach(value => {
    const label = typeof value === "string" ? value : value.label || value.id;
    const id = typeof value === "string" ? value : value.id;
    select.appendChild(option(label, id));
  });
  select.value = selected;
}

function selectedProfile() {
  if (!modelCatalog) return null;
  return (modelCatalog.profiles || []).find(profile => profile.id === elements.profileSelect.value) || null;
}

function fillModelFormFromProfile(profile) {
  if (!profile) return;
  suppressModelEvents = true;
  elements.modelInput.value = profile.model || "";
  elements.reasoningSelect.value = profile.reasoningEffort || "medium";
  elements.verbositySelect.value = profile.textVerbosity || "low";
  elements.maxTokensInput.value = profile.maxTokens || 1024;
  suppressModelEvents = false;
}

function markCustomIfEdited() {
  if (suppressModelEvents || !modelCatalog) return;
  const profile = selectedProfile();
  if (!profile) return;
  const changed =
    elements.modelInput.value.trim() !== String(profile.model || "") ||
    elements.reasoningSelect.value !== String(profile.reasoningEffort || "") ||
    elements.verbositySelect.value !== String(profile.textVerbosity || "") ||
    Number(elements.maxTokensInput.value) !== Number(profile.maxTokens || 0);
  if (changed) {
    elements.profileSelect.value = "custom";
  }
}

function renderModelConfig(config) {
  if (!config || !config.ok) return;
  modelCatalog = config;
  const current = config.current || {};
  const profiles = [{ id: "custom", label: "Custom" }, ...(config.profiles || [])];
  const knownModels = (config.models || []).map(model => model.id);

  suppressModelEvents = true;
  setSelectOptions(elements.profileSelect, profiles, current.profileId || "custom");
  setSelectOptions(elements.reasoningSelect, config.reasoningEfforts || ["low", "medium", "high"], current.reasoningEffort || "medium");
  setSelectOptions(elements.verbositySelect, config.textVerbosity || ["low", "medium", "high"], current.textVerbosity || "low");
  elements.modelInput.value = current.model || knownModels[0] || "openai/gpt-5.5";
  elements.maxTokensInput.value = current.maxTokens || 1024;
  elements.modelConfigState.textContent = current.profileId === "custom" ? "Custom" : titleCase(current.profileId || "Current");
  elements.modelConfigHint.textContent = `Active config: ${current.model || "unknown"} / ${current.reasoningEffort || "?"} / ${current.textVerbosity || "?"}. Restart gateway after applying.`;
  suppressModelEvents = false;
}

function renderFeatureHealth(health) {
  if (!health) return;
  const warnings = Array.isArray(health.warnings) ? health.warnings : [];
  const issues = Array.isArray(health.issues) ? health.issues : [];
  const ok = health.ok || health.status === "ok";
  elements.featureHealthState.textContent = ok ? "OK" : "Failed";
  elements.featureHealthPlugins.textContent = Number.isFinite(health.plugins) ? String(health.plugins) : "--";
  elements.featureHealthTools.textContent = Number.isFinite(health.tools) ? String(health.tools) : "--";
  elements.featureHealthManuals.textContent = Number.isFinite(health.manuals) ? String(health.manuals) : "--";
  elements.featureHealthWarnings.textContent = String(warnings.length);
  elements.featureHealthChecked.textContent = formatTime(health.checkedAt);

  const lines = [];
  if (issues.length) {
    lines.push("Issues");
    for (const item of issues) lines.push(`- ${item.message}`);
  }
  if (warnings.length) {
    if (lines.length) lines.push("");
    lines.push("Warnings");
    for (const item of warnings) lines.push(`- ${item.message}`);
  }
  if (!lines.length) lines.push("No feature health issues.");
  elements.featureHealthBox.textContent = lines.join("\n");
}

async function loadFeatureHealth() {
  elements.featureHealthState.textContent = "Checking";
  try {
    const response = await apiFetch("/api/feature-health", { cache: "no-store" });
    const health = await response.json();
    renderFeatureHealth(health);
  } catch (error) {
    elements.featureHealthState.textContent = "Error";
    elements.featureHealthBox.textContent = error.message;
  }
}

async function loadModelConfig() {
  try {
    const response = await apiFetch("/api/model-config", { cache: "no-store" });
    const config = await response.json();
    renderModelConfig(config);
  } catch (error) {
    elements.modelConfigState.textContent = "Error";
    elements.modelConfigHint.textContent = error.message;
  }
}

async function refreshStatus() {
  try {
    const response = await apiFetch("/api/status", { cache: "no-store" });
    const status = await response.json();
    renderStatus(status);
  } catch (error) {
    elements.statePill.className = "state-pill stopped";
    elements.statePill.querySelector("strong").textContent = "Panel Error";
    elements.statusLine.textContent = error.message;
    elements.operatorMode.textContent = "ERROR";
  }
}

async function applyModelConfig(restart) {
  if (busy) return;
  setBusy(true);
  elements.modelConfigState.textContent = restart ? "Applying + restart" : "Applying";
  try {
    const response = await apiFetch("/api/model-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileId: elements.profileSelect.value || "custom",
        model: elements.modelInput.value.trim(),
        reasoningEffort: elements.reasoningSelect.value,
        textVerbosity: elements.verbositySelect.value,
        maxTokens: Number(elements.maxTokensInput.value),
        restart
      })
    });
    const result = await response.json();
    if (result.modelConfig) {
      renderModelConfig(result.modelConfig);
    }
    if (result.status) {
      renderStatus(result.status);
    }
    elements.modelConfigState.textContent = response.ok ? "Applied" : "Failed";
    elements.modelConfigHint.textContent = response.ok
      ? restart
        ? "Model config applied and gateway restart requested."
        : "Model config applied. Restart gateway to use it."
      : result.error || "Model config failed.";
  } catch (error) {
    elements.modelConfigState.textContent = "Failed";
    elements.modelConfigHint.textContent = error.message;
  } finally {
    setBusy(false);
    await loadModelConfig();
    await refreshStatus();
  }
}

async function runAction(action) {
  if (busy) return;
  setBusy(true);
  elements.statusLine.textContent = `${titleCase(action)} requested`;
  try {
    const response = await apiFetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action })
    });
    const result = await response.json();
    if (result.status) {
      renderStatus(result.status);
    } else {
      await refreshStatus();
    }
    if (!response.ok) {
      elements.statusLine.textContent = result.error || `${action} failed`;
    }
  } catch (error) {
    elements.statusLine.textContent = error.message;
  } finally {
    setBusy(false);
    await refreshStatus();
  }
}

async function postOnly(path) {
  try {
    await apiFetch(path, { method: "POST" });
  } catch (error) {
    elements.statusLine.textContent = error.message;
  }
}

async function copyCommand(value) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    elements.copyState.textContent = "Copied";
    window.setTimeout(() => {
      elements.copyState.textContent = "Ready";
    }, 1200);
  } catch (error) {
    elements.copyState.textContent = "Copy failed";
  }
}

function drawSignal() {
  const canvas = elements.signalCanvas;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const time = performance.now() / 1000;
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = "#090b0b";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(243,234,216,0.06)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += 32) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += 32) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const baseColor = lastRunning ? "88, 214, 141" : "255, 95, 102";
  const accentColor = latestStatus && latestStatus.warningCount ? "238, 183, 90" : "70, 199, 189";

  for (let lane = 0; lane < 4; lane += 1) {
    const color = lane === 3 ? accentColor : baseColor;
    ctx.strokeStyle = `rgba(${color}, ${0.9 - lane * 0.16})`;
    ctx.lineWidth = Math.max(1, 2.4 - lane * 0.35);
    ctx.beginPath();
    for (let x = 0; x < width; x += 3) {
      const t = x / width;
      const y =
        height * (0.35 + lane * 0.13) +
        Math.sin(t * Math.PI * (5 + lane) + time * (1.2 + lane * 0.22)) * (22 - lane * 3) +
        Math.sin(t * Math.PI * 19 - time * 0.7) * 4;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  requestAnimationFrame(drawSignal);
}

elements.startBtn.addEventListener("click", () => runAction("start"));
elements.stopBtn.addEventListener("click", () => runAction("stop"));
elements.restartBtn.addEventListener("click", () => runAction("restart"));
elements.statusBtn.addEventListener("click", () => runAction("status"));
elements.refreshBtn.addEventListener("click", refreshStatus);
elements.featureHealthRefreshBtn.addEventListener("click", loadFeatureHealth);
elements.profileSelect.addEventListener("change", () => {
  const profile = selectedProfile();
  if (profile) fillModelFormFromProfile(profile);
});
[
  elements.modelInput,
  elements.reasoningSelect,
  elements.verbositySelect,
  elements.maxTokensInput
].forEach(input => input.addEventListener("input", markCustomIfEdited));
elements.applyModelBtn.addEventListener("click", () => applyModelConfig(false));
elements.applyRestartModelBtn.addEventListener("click", () => applyModelConfig(true));
elements.dashboardBtn.addEventListener("click", () => postOnly("/api/open-dashboard"));
elements.openLogsBtn.addEventListener("click", () => postOnly("/api/open-log-folder"));
elements.openConfigBtn.addEventListener("click", () => postOnly("/api/open-config"));
elements.openRootBtn.addEventListener("click", () => postOnly("/api/open-root"));
elements.exitBtn.addEventListener("click", async () => {
  try {
    await apiFetch("/api/exit", { method: "POST" });
  } finally {
    window.close();
  }
});

document.querySelectorAll(".copy-button").forEach(button => {
  button.addEventListener("click", () => copyCommand(button.dataset.copy || ""));
});

document.querySelectorAll(".filter-button").forEach(button => {
  button.addEventListener("click", () => {
    activeLogFilter = button.dataset.filter || "all";
    document.querySelectorAll(".filter-button").forEach(item => item.classList.toggle("active", item === button));
    if (latestStatus) renderLog(latestStatus);
  });
});

async function bootPanel() {
  try {
    await exchangeBootstrapToken();
  } catch (error) {
    elements.statusLine.textContent = error.message;
  }
  refreshStatus();
  loadModelConfig();
  loadFeatureHealth();
}

bootPanel();
setInterval(() => {
  if (!busy) refreshStatus();
}, 3000);
drawSignal();
