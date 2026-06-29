#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const args = new Map();
const flags = new Set();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) flags.add(key);
  else {
    args.set(key, next);
    i++;
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelCatalogPath = path.join(root, "scripts", "IMAGEBOT_MODEL_PROFILES.json");
const openclawCommand = process.env.OPENCLAW_CMD || "openclaw.cmd";
const agentId = args.get("agent") || "imagebot";
const curatorProfile = args.get("curator-profile") || "deep";
const curatorModelOverride = args.get("curator-model") || args.get("model") || "";
const curatorThinkingOverride = args.get("curator-thinking") || args.get("thinking") || "";
const curatorSettings = resolveCuratorSettings({
  profileId: curatorProfile,
  model: curatorModelOverride,
  thinking: curatorThinkingOverride
});
const thinking = curatorSettings.thinking || "medium";
const curatorModel = curatorSettings.model || "";
const timeoutSeconds = Number.parseInt(args.get("timeout") || "420", 10);
const minTurns = Number.parseInt(args.get("min-turns") || "1", 10);
const defaultPromptChars = process.platform === "win32" ? "12000" : "24000";
const defaultTranscriptChars = process.platform === "win32" ? "8000" : "14000";
const defaultExistingChars = process.platform === "win32" ? "3000" : "6000";
const maxTranscriptChars = Number.parseInt(args.get("max-transcript-chars") || defaultTranscriptChars, 10);
const maxExistingChars = Number.parseInt(args.get("max-existing-chars") || defaultExistingChars, 10);
const maxPromptChars = Number.parseInt(args.get("max-prompt-chars") || defaultPromptChars, 10);
const fallbackPromptChars = Number.parseInt(args.get("fallback-prompt-chars") || "7000", 10);
const dryRun = flags.has("dry-run");
const force = flags.has("force");
const closeWindows = flags.has("close-windows");

const openclawHome = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
const sessionsDir = path.join(openclawHome, "agents", agentId, "sessions");
const sessionsIndexPath = path.join(sessionsDir, "sessions.json");
const windowStorePath = path.join(sessionsDir, "sessions.json.telegram-imagebot-windows.json");
const memoryDir = path.join(sessionsDir, "sessions.json.telegram-imagebot-memory");
const usersDir = path.join(memoryDir, "users");
const groupDir = path.join(memoryDir, "group");
const windowsDir = path.join(memoryDir, "windows");
const backupsDir = path.join(memoryDir, "curated-backups");
const statePath = path.join(memoryDir, "curator-state.json");
const reportPath = path.join(memoryDir, "curator-last-run.json");

function resolveCuratorSettings({ profileId, model, thinking }) {
  const result = {
    profileId: String(profileId || "").trim(),
    model: String(model || "").trim(),
    thinking: String(thinking || "").trim()
  };
  if (result.model && result.thinking) return result;
  const catalog = readJson(modelCatalogPath, {});
  const profile = Array.isArray(catalog?.profiles)
    ? catalog.profiles.find((item) => String(item?.id || "") === result.profileId)
    : null;
  if (!result.model && profile?.model) result.model = String(profile.model).trim();
  if (!result.thinking && profile?.reasoningEffort) result.thinking = String(profile.reasoningEffort).trim();
  return result;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf-8");
  fs.renameSync(tempPath, filePath);
}

function sanitizeText(value) {
  return String(value ?? "")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[telegram-token-redacted]")
    .replace(/[A-Za-z]:\\[^\s<>"']+/g, "[local-path-redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip-redacted]")
    .replace(/[A-Za-z0-9_-]{48,}/g, "[long-token-redacted]")
    .replace(/\r\n/g, "\n")
    .trim();
}

function clip(value, max) {
  const text = sanitizeText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 40)).trimEnd()}\n[...clipped...]`;
}

function fileTail(filePath, maxChars) {
  if (!fs.existsSync(filePath)) return "";
  const text = fs.readFileSync(filePath, "utf-8");
  return clip(text.slice(-maxChars), maxChars);
}

function backupFile(filePath, stamp) {
  if (!fs.existsSync(filePath)) return;
  const rel = path.relative(memoryDir, filePath).replace(/[\\/:*?"<>|]/g, "_");
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.copyFileSync(filePath, path.join(backupsDir, `${stamp}-${rel}.bak.md`));
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    else if (item.type === "image") parts.push("[image attached]");
    else if (item.type === "file") parts.push(`[file attached: ${item.name || item.mimeType || "unknown"}]`);
    else if (item.type === "input_audio" || item.type === "audio") parts.push("[audio attached]");
    else if (item.type === "video") parts.push("[video attached]");
  }
  return parts.join("\n");
}

function normalizeTurnText(raw) {
  let text = sanitizeText(raw);
  text = text.replace(/^\[[^\]]+GMT[^\]]*\]\s*/i, "");
  const lines = text.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^\[(?:Imagebot turn boundary|Imagebot operational memory|Telegram media available|WindowRecentMediaPaths|CurrentMediaPaths|ReplyMediaPaths|Fetched PDF URL text|Attached PDF text|Video keyframes|Sticker|Local file path)/i.test(trimmed)) return false;
    if (/^(?:GeneratedMediaPaths|Current media paths|Reply media paths):/i.test(trimmed)) return false;
    return true;
  });
  text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const marker = "User text:";
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) {
    const after = text.slice(markerIndex + marker.length).trim();
    if (after) text = after;
  }
  return clip(text, 2200);
}

function extractTranscript(sessionFile, maxChars) {
  if (!sessionFile || !fs.existsSync(sessionFile)) return "";
  const lines = fs.readFileSync(sessionFile, "utf-8").split(/\r?\n/).filter(Boolean);
  const turns = [];
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "message" || !obj.message) continue;
    const role = obj.message.role === "assistant" ? "assistant" : obj.message.role === "user" ? "user" : "";
    if (!role) continue;
    const text = normalizeTurnText(contentToText(obj.message.content));
    if (!text) continue;
    turns.push(`### ${role} ${obj.timestamp || obj.message.timestamp || ""}\n${text}`);
  }
  return clip(turns.join("\n\n"), maxChars);
}

function countTranscriptTurns(transcript) {
  return (transcript.match(/^### /gm) || []).length;
}

function sha(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function userMemoryFilePath(userKey) {
  return path.join(usersDir, `${sha(userKey)}.md`);
}

function resolveOpenClawInvocation() {
  const command = String(openclawCommand || "openclaw.cmd");
  if (process.platform !== "win32") return { command, argsPrefix: [], label: command };

  const lower = command.toLowerCase();
  const isOpenClawShim = /(?:^|[\\/])openclaw\.(?:cmd|ps1)$/.test(lower);
  if (!isOpenClawShim) return { command, argsPrefix: [], label: command };

  const binDir = path.dirname(command);
  const nodeExe = path.join(binDir, "node.exe");
  const cliScript = path.join(binDir, "node_modules", "openclaw", "openclaw.mjs");
  if (fs.existsSync(nodeExe) && fs.existsSync(cliScript)) {
    return {
      command: nodeExe,
      argsPrefix: [cliScript],
      label: `${nodeExe} ${cliScript}`
    };
  }

  return { command, argsPrefix: [], label: command };
}

function buildPrompt({ windowEntry, sessionFile, transcript, existingMemory }) {
  const participants = Object.entries(windowEntry.participants || {}).map(([userKey, data]) => ({
    userKey,
    id: sanitizeText(data?.id || (userKey === windowEntry.ownerUserKey ? windowEntry.ownerSenderId : "") || ""),
    name: sanitizeText(data?.name || "unknown")
  }));
  if (!participants.some((p) => p.userKey === windowEntry.ownerUserKey)) {
    participants.unshift({
      userKey: windowEntry.ownerUserKey,
      id: sanitizeText(windowEntry.ownerSenderId || ""),
      name: sanitizeText(windowEntry.ownerName || "owner")
    });
  }
  const participantLines = participants.map((p) => `- userKey=${p.userKey}, telegramId=${p.id || "unknown"}, displayName=${p.name}`).join("\n");
  const existingLines = participants.map((p) => {
    const current = existingMemory.users[p.userKey] || "(empty)";
    return `### userKey=${p.userKey} telegramId=${p.id || "unknown"} displayName=${p.name}\n${current}`;
  }).join("\n\n");
  const groupMemory = existingMemory.group || "(empty)";
  const prompt = `
You are a neutral memory curator for a Telegram image/chat bot named Amadeus.
This is a curation job, not a persona roleplay. Do not imitate Amadeus or any
active speaking persona.

Task:
Merge the existing shared social memory with the bot-visible transcript of one
active conversation window. Memory is shared across speaking personas.
Output valid JSON only. Do not include markdown fences or commentary outside JSON.

Memory rules:
- Only record things that are useful for future conversation: stable preferences, recurring jokes, creative tastes, ongoing projects, durable relationships between ideas, and unresolved follow-ups.
- Do not store Telegram tokens, local paths, hostnames, IP addresses, account details, private files, one-off probes, or anything that feels like machine/owner secrets.
- Stable Telegram ids shown in the participant list are allowed only as attribution anchors. Keep them in identity headers when useful, but do not treat them as real-world private identity facts.
- Do not invent facts. If a point is uncertain, mark it as uncertain or omit it.
- Keep memory human-readable and lightly warm, but concise. It should feel like someone attentive took notes, not a database dump.
- Personal notes must stay attached to the correct telegramId/userKey. Shared group memory should only contain public group lore or context visible in this bot window.

Participants:
${participantLines}

Existing user memory:
${existingLines}

Existing shared group memory:
${groupMemory}

Window metadata:
- windowId: ${windowEntry.windowId}
- ownerUserKey: ${windowEntry.ownerUserKey}
- openedAt: ${windowEntry.openedAt || ""}
- sessionFile: ${sanitizeText(sessionFile || "")}

Bot-visible transcript:
${transcript}

Return exactly this JSON shape:
{
  "users": [
    {
      "userKey": "one of the participant userKeys",
      "memoryMarkdown": "complete revised memory for that user, 3-10 compact bullets or short paragraphs"
    }
  ],
  "groupMemoryMarkdown": "complete revised shared group memory, or empty string if nothing durable is shared",
  "windowNoteMarkdown": "short audit note of what changed and what was intentionally not remembered"
}
`.trim();
  return clip(prompt, maxPromptChars);
}

function runOpenClaw(prompt, windowId) {
  const sessionId = `imagebot-memory-curator-${new Date().toISOString().slice(0, 10)}-${windowId}`;
  const invocation = resolveOpenClawInvocation();
  const attempts = [{ prompt, clipped: false }];
  if (prompt.length > fallbackPromptChars) {
    attempts.push({
      prompt: `${clip(prompt, fallbackPromptChars)}\n\n[Curator note: prompt was clipped further after a Windows command-line invocation failure.]`,
      clipped: true
    });
  }

  let lastError;
  for (const attempt of attempts) {
    const commandArgs = [
      ...invocation.argsPrefix,
      "agent",
      "--agent", agentId,
      "--session-id", sessionId,
      "--message", attempt.prompt,
      "--thinking", thinking,
      "--timeout", String(timeoutSeconds),
      "--json"
    ];
    if (curatorModel) commandArgs.push("--model", curatorModel);
    const result = spawnSync(invocation.command, commandArgs, {
      cwd: root,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    });
    if (result.error) {
      lastError = result.error;
      const code = String(result.error.code || "");
      if (!attempt.clipped && (code === "EINVAL" || code === "E2BIG")) continue;
      throw new Error(`failed to start openclaw agent (${code || "unknown"}), promptChars=${attempt.prompt.length}, invocation=${sanitizeText(invocation.label)}: ${sanitizeText(result.error.message || result.error)}`);
    }
    if (result.status !== 0) {
      throw new Error(`openclaw agent exited ${result.status}, promptChars=${attempt.prompt.length}: ${result.stderr || result.stdout}`);
    }
    const payload = JSON.parse(result.stdout);
    const text = payload?.result?.payloads?.[0]?.text || payload?.result?.meta?.finalAssistantVisibleText || "";
    if (!text.trim()) throw new Error("openclaw agent returned empty memory output");
    return text;
  }

  throw lastError || new Error("openclaw agent did not run");
}

function parseCuratorJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("memory curator output did not contain JSON");
  return JSON.parse(text.slice(start, end + 1));
}

function memoryValueToMarkdown(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (typeof value.memoryMarkdown === "string") return value.memoryMarkdown;
  if (Array.isArray(value.notes)) return value.notes.map((note) => `- ${sanitizeText(note)}`).join("\n");
  if (typeof value.summary === "string") return value.summary;
  if (typeof value.markdown === "string") return value.markdown;

  const lines = [];
  for (const [key, item] of Object.entries(value)) {
    if (key === "telegramId" || key === "displayName" || key === "userKey") continue;
    if (Array.isArray(item)) {
      for (const entry of item) lines.push(`- ${sanitizeText(entry)}`);
    } else if (typeof item === "string") {
      lines.push(`- ${sanitizeText(item)}`);
    }
  }
  return lines.join("\n");
}

function normalizeCuratedMemory(curated, participantKeys) {
  const users = [];
  if (Array.isArray(curated.users)) {
    for (const item of curated.users) {
      const userKey = String(item?.userKey || "");
      if (!participantKeys.has(userKey)) continue;
      const memoryMarkdown = clip(memoryValueToMarkdown(item), 5000);
      if (memoryMarkdown) users.push({ userKey, memoryMarkdown });
    }
  } else if (curated.users && typeof curated.users === "object") {
    for (const [userKey, value] of Object.entries(curated.users)) {
      if (!participantKeys.has(userKey)) continue;
      const memoryMarkdown = clip(memoryValueToMarkdown(value), 5000);
      if (memoryMarkdown) users.push({ userKey, memoryMarkdown });
    }
  }
  const groupMemory = curated.groupMemoryMarkdown ?? curated.groupMemory ?? curated.group ?? "";
  const windowNote = curated.windowNoteMarkdown ?? curated.windowNote ?? curated.auditNote ?? curated.summary ?? "";
  return {
    users,
    groupMemoryMarkdown: clip(memoryValueToMarkdown(groupMemory), 5000),
    windowNoteMarkdown: clip(memoryValueToMarkdown(windowNote), 3000)
  };
}

function writeCuratedFiles({ windowEntry, transcript, curated, sessionFile, stamp }) {
  fs.mkdirSync(usersDir, { recursive: true });
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(windowsDir, { recursive: true });
  const header = `Last curated: ${new Date().toISOString()}\nSource window: ${windowEntry.windowId}\n\n`;
  const participantIndex = new Map(Object.entries(windowEntry.participants || {}).map(([userKey, data]) => [userKey, {
    userKey,
    id: sanitizeText(data?.id || (userKey === windowEntry.ownerUserKey ? windowEntry.ownerSenderId : "") || ""),
    name: sanitizeText(data?.name || "unknown")
  }]));
  if (windowEntry.ownerUserKey && !participantIndex.has(windowEntry.ownerUserKey)) {
    participantIndex.set(windowEntry.ownerUserKey, {
      userKey: windowEntry.ownerUserKey,
      id: sanitizeText(windowEntry.ownerSenderId || ""),
      name: sanitizeText(windowEntry.ownerName || "owner")
    });
  }
  for (const user of curated.users) {
    const userPath = userMemoryFilePath(user.userKey);
    const participant = participantIndex.get(user.userKey) || { id: "", name: "unknown" };
    const identityHeader = `User key: ${user.userKey}\nTelegram id: ${participant.id || "unknown"}\nDisplay name: ${participant.name || "unknown"}\n\n`;
    backupFile(userPath, stamp);
    fs.writeFileSync(userPath, `# Telegram Imagebot User Memory\n\n${header}${identityHeader}${user.memoryMarkdown.trim()}\n`, "utf-8");
  }
  if (curated.groupMemoryMarkdown.trim()) {
    const groupPath = path.join(groupDir, "shared.md");
    backupFile(groupPath, stamp);
    fs.writeFileSync(groupPath, `# Telegram Imagebot Shared Group Memory\n\n${header}${curated.groupMemoryMarkdown.trim()}\n`, "utf-8");
  }
  const participantNames = Array.from(participantIndex.values()).map((p) => `${p.name || "unknown"} [tg:${p.id || "unknown"}]`).join(", ") || "unknown";
  const windowDoc = [
    "# Telegram Imagebot Curated Window",
    "",
    `Window: ${windowEntry.windowId}`,
    `Owner: ${windowEntry.ownerName || "unknown"}`,
    `Opened: ${windowEntry.openedAt || ""}`,
    `Curated: ${new Date().toISOString()}`,
    `Participants: ${sanitizeText(participantNames)}`,
    `Session file: ${sanitizeText(sessionFile || "")}`,
    "",
    "## Curator Note",
    "",
    curated.windowNoteMarkdown || "(no note)",
    "",
    "## Transcript",
    "",
    transcript || "(empty)"
  ].join("\n");
  fs.writeFileSync(path.join(windowsDir, `${windowEntry.windowId}.md`), `${windowDoc.trim()}\n`, "utf-8");
}

function closeConsolidatedWindows(windowStore, successfulWindowIds) {
  const closedOwners = [];
  const closedAt = new Date().toISOString();
  for (const [ownerKey, windowEntry] of Object.entries(windowStore.activeByUser || {})) {
    if (!successfulWindowIds.has(windowEntry?.windowId)) continue;
    if (windowStore.windows?.[windowEntry.windowId]) {
      windowStore.windows[windowEntry.windowId].closedAt ??= closedAt;
      windowStore.windows[windowEntry.windowId].closedReason ??= "memory-consolidated";
    }
    delete windowStore.activeByUser[ownerKey];
    closedOwners.push(ownerKey);
  }
  for (const [messageKey, ref] of Object.entries(windowStore.byBotMessage || {})) {
    if (successfulWindowIds.has(ref?.windowId)) delete windowStore.byBotMessage[messageKey];
  }
  return closedOwners;
}

function collectConsolidationWindows(windowStore) {
  const candidates = [];
  const seenWindowIds = new Set();
  for (const [ownerKey, windowEntry] of Object.entries(windowStore.activeByUser || {})) {
    if (!windowEntry?.windowId) continue;
    candidates.push({ ownerKey, windowEntry, source: "active" });
    seenWindowIds.add(windowEntry.windowId);
  }
  for (const [windowId, storedWindow] of Object.entries(windowStore.windows || {})) {
    if (!storedWindow || typeof storedWindow !== "object" || seenWindowIds.has(windowId)) continue;
    if (!storedWindow.closedAt) continue;
    const windowEntry = {
      ...storedWindow,
      windowId: storedWindow.windowId || windowId
    };
    candidates.push({
      ownerKey: windowEntry.ownerUserKey || `window:${windowId}`,
      windowEntry,
      source: "closed"
    });
    seenWindowIds.add(windowId);
  }
  return candidates;
}

function main() {
  fs.mkdirSync(memoryDir, { recursive: true });
  const state = readJson(statePath, { version: 1, windows: {} });
  const sessionsIndex = readJson(sessionsIndexPath, {});
  const windowStore = readJson(windowStorePath, { version: 2, activeByUser: {}, byBotMessage: {} });
  const candidates = collectConsolidationWindows(windowStore);
  const activeCount = Object.keys(windowStore.activeByUser || {}).length;
  const closedCandidateCount = candidates.filter((entry) => entry.source === "closed").length;
  const today = new Date().toISOString().slice(0, 10);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const report = {
    generatedAt: new Date().toISOString(),
    dryRun,
    closeWindows,
    curatorProfile,
    curatorModel,
    curatorThinking: thinking,
    activeWindows: activeCount,
    closedWindowCandidates: closedCandidateCount,
    candidateWindows: candidates.length,
    processedWindows: 0,
    skippedWindows: 0,
    failedWindows: 0,
    closedWindows: 0,
    results: []
  };
  const successfulWindowIds = new Set();
  for (const { ownerKey, windowEntry, source } of candidates) {
    const sessionMeta = sessionsIndex[windowEntry.sessionKey] || {};
    const sessionFile = sessionMeta.sessionFile;
    const transcript = extractTranscript(sessionFile, maxTranscriptChars);
    const turns = countTranscriptTurns(transcript);
    const existingRecord = state.windows?.[windowEntry.windowId];
    const transcriptHash = sha(transcript);
    if (!force && source === "closed" && existingRecord?.transcriptHash === transcriptHash) {
      report.skippedWindows++;
      report.results.push({ windowId: windowEntry.windowId, source, status: "skipped", reason: "closed-window-already-consolidated" });
      continue;
    }
    if (!force && existingRecord?.date === today && existingRecord?.transcriptHash === transcriptHash) {
      report.skippedWindows++;
      report.results.push({ windowId: windowEntry.windowId, source, status: "skipped", reason: "already-consolidated-today" });
      continue;
    }
    if (turns < minTurns) {
      report.skippedWindows++;
      report.results.push({ windowId: windowEntry.windowId, source, status: "skipped", reason: `turns-${turns}-below-min-${minTurns}` });
      continue;
    }
    const participantKeys = new Set([ownerKey, windowEntry.ownerUserKey, ...Object.keys(windowEntry.participants || {})].filter(Boolean));
    const existingMemory = { users: {}, group: fileTail(path.join(groupDir, "shared.md"), maxExistingChars) };
    for (const userKey of participantKeys) existingMemory.users[userKey] = fileTail(userMemoryFilePath(userKey), maxExistingChars);
    if (dryRun) {
      report.processedWindows++;
      report.results.push({ windowId: windowEntry.windowId, source, status: "dry-run", turns, promptChars: buildPrompt({ windowEntry, sessionFile, transcript, existingMemory }).length });
      continue;
    }
    try {
      const prompt = buildPrompt({ windowEntry, sessionFile, transcript, existingMemory });
      const raw = runOpenClaw(prompt, windowEntry.windowId);
      const curated = normalizeCuratedMemory(parseCuratorJson(raw), participantKeys);
      if (curated.users.length === 0 && !curated.groupMemoryMarkdown.trim()) throw new Error("curator returned no usable user or group memory");
      writeCuratedFiles({ windowEntry, transcript, curated, sessionFile, stamp });
      state.windows ??= {};
      state.windows[windowEntry.windowId] = {
        date: today,
        consolidatedAt: new Date().toISOString(),
        sessionKey: windowEntry.sessionKey,
        transcriptHash,
        participants: Array.from(participantKeys),
        participantIds: Object.fromEntries(Array.from(participantKeys).map((userKey) => [userKey, windowEntry.participants?.[userKey]?.id || (userKey === windowEntry.ownerUserKey ? windowEntry.ownerSenderId : "") || ""])),
        usersWritten: curated.users.map((u) => u.userKey)
      };
      successfulWindowIds.add(windowEntry.windowId);
      report.processedWindows++;
      report.results.push({ windowId: windowEntry.windowId, source, status: "ok", turns, usersWritten: curated.users.length, groupWritten: Boolean(curated.groupMemoryMarkdown.trim()) });
    } catch (error) {
      report.failedWindows++;
      report.results.push({ windowId: windowEntry.windowId, source, status: "failed", error: sanitizeText(error?.message || error) });
    }
  }
  if (!dryRun) writeJsonAtomic(statePath, state);
  if (!dryRun && closeWindows && successfulWindowIds.size > 0) {
    const closedOwners = closeConsolidatedWindows(windowStore, successfulWindowIds);
    report.closedWindows = closedOwners.length;
    writeJsonAtomic(windowStorePath, windowStore);
  }
  writeJsonAtomic(reportPath, report);
  console.log(JSON.stringify(report, null, 2));
  if (report.failedWindows > 0) process.exitCode = 1;
}

main();
