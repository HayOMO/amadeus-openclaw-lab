import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_AGENT = "imagebot";
const DEFAULT_COUNT = 6;
const MAX_TEXT = 1200;

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir() || process.cwd();
}

function clip(value, max = MAX_TEXT) {
  const text = String(value ?? "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 16)).trimEnd()}...`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultSessionsDir(agent = DEFAULT_AGENT) {
  return path.join(homeDir(), ".openclaw", "agents", agent, "sessions");
}

function readArgValue(args, index) {
  const current = args[index];
  const eq = current.indexOf("=");
  if (eq >= 0) return { value: current.slice(eq + 1), next: index };
  return { value: args[index + 1] || "", next: index + 1 };
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    agent: DEFAULT_AGENT,
    sessionsDir: "",
    query: "",
    runId: "",
    count: DEFAULT_COUNT,
    includeInternal: false,
    json: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--include-internal") {
      options.includeInternal = true;
    } else if (arg === "--agent" || arg.startsWith("--agent=")) {
      const read = readArgValue(argv, i);
      options.agent = read.value || DEFAULT_AGENT;
      i = read.next;
    } else if (arg === "--sessions-dir" || arg.startsWith("--sessions-dir=")) {
      const read = readArgValue(argv, i);
      options.sessionsDir = read.value;
      i = read.next;
    } else if (arg === "--query" || arg.startsWith("--query=")) {
      const read = readArgValue(argv, i);
      options.query = read.value;
      i = read.next;
    } else if (arg === "--run-id" || arg.startsWith("--run-id=")) {
      const read = readArgValue(argv, i);
      options.runId = read.value;
      i = read.next;
    } else if (arg === "--count" || arg.startsWith("--count=")) {
      const read = readArgValue(argv, i);
      const count = Number(read.value);
      if (Number.isFinite(count)) options.count = Math.max(1, Math.min(50, Math.trunc(count)));
      i = read.next;
    } else if (!options.query) {
      options.query = arg;
    }
  }
  options.sessionsDir = path.resolve(options.sessionsDir || defaultSessionsDir(options.agent));
  return options;
}

function isInternalSessionFile(filePath) {
  const name = path.basename(filePath);
  return /(?:memory-curator|v2-tools|no-toolsearch|spark-who|explicit)/i.test(name);
}

async function readJsonLines(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  const records = [];
  let lineNo = 0;
  for (const line of text.split(/\r?\n/)) {
    lineNo += 1;
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (isRecord(record)) records.push({ lineNo, record });
    } catch {
      records.push({ lineNo, record: null });
    }
  }
  return records;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!isRecord(item)) return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.content === "string") return item.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function extractCurrentTurnText(text) {
  const raw = String(text || "").replace(/\r\n/g, "\n");
  const marker = "[/Telegram current turn]";
  const index = raw.indexOf(marker);
  return clip(index >= 0 ? raw.slice(index + marker.length) : raw, 800);
}

function assistantItems(message) {
  return Array.isArray(message?.content) ? message.content.filter(isRecord) : [];
}

function summarizeToolCall(item) {
  return {
    name: String(item.name || ""),
    arguments: isRecord(item.arguments) ? item.arguments : {},
    rawArguments: typeof item.arguments === "string" ? item.arguments : "",
    id: String(item.id || "")
  };
}

function summarizeToolResult(message) {
  const details = isRecord(message.details) ? message.details : {};
  const results = Array.isArray(details.results) ? details.results : [];
  return {
    name: String(message.toolName || ""),
    status: String(details.status || (message.isError ? "error" : "")),
    resultCount: results.length,
    query: String(details.query || ""),
    firstResult: results[0]
      ? {
          title: String(results[0].title || ""),
          url: String(results[0].url || ""),
          snippet: clip(results[0].snippet || "", 300)
        }
      : null
  };
}

function summarizeAssistantText(message) {
  return clip(contentText(message.content), 700);
}

async function loadTrajectoryArtifacts(sessionPath) {
  const parsed = path.parse(sessionPath);
  const trajectoryPath = path.join(parsed.dir, `${parsed.name}.trajectory.jsonl`);
  let lines;
  try {
    lines = await readJsonLines(trajectoryPath);
  } catch {
    return [];
  }
  return lines
    .map(({ record }) => record)
    .filter((record) => record?.type === "trace.artifacts" && isRecord(record.data))
    .map((record) => ({
      runId: String(record.runId || ""),
      ts: String(record.ts || ""),
      provider: String(record.provider || ""),
      modelId: String(record.modelId || ""),
      modelApi: String(record.modelApi || ""),
      usage: record.data.usage || null,
      finalPromptText: String(record.data.finalPromptText || ""),
      assistantTexts: Array.isArray(record.data.assistantTexts) ? record.data.assistantTexts.map((text) => clip(text, 700)) : [],
      toolMetas: Array.isArray(record.data.toolMetas) ? record.data.toolMetas : []
    }));
}

function matchArtifact(artifacts, turn) {
  if (!artifacts.length) return null;
  const actual = extractCurrentTurnText(turn.userText);
  const exact = artifacts.find((artifact) => artifact.finalPromptText.includes(actual));
  if (exact) return exact;
  if (turn.firstToolCall?.name) {
    const toolMatch = artifacts.find((artifact) =>
      artifact.toolMetas.some((tool) => String(tool.toolName || "") === turn.firstToolCall.name)
    );
    if (toolMatch) return toolMatch;
  }
  return null;
}

export async function collectBehaviorReport(options = {}) {
  const sessionsDir = path.resolve(options.sessionsDir || defaultSessionsDir(options.agent || DEFAULT_AGENT));
  const query = String(options.query || "").trim().toLowerCase();
  const runId = String(options.runId || "").trim();
  const count = Number.isFinite(Number(options.count)) ? Math.max(1, Math.min(50, Math.trunc(Number(options.count)))) : DEFAULT_COUNT;
  const includeInternal = options.includeInternal === true;
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  const sessionFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.endsWith(".trajectory.jsonl"))
    .map((entry) => path.join(sessionsDir, entry.name));
  const turns = [];

  for (const filePath of sessionFiles) {
    if (!includeInternal && isInternalSessionFile(filePath)) continue;
    const lines = await readJsonLines(filePath);
    const artifacts = await loadTrajectoryArtifacts(filePath);
    for (let index = 0; index < lines.length; index++) {
      const current = lines[index].record;
      const message = current?.message;
      if (current?.type !== "message" || message?.role !== "user") continue;
      const userText = contentText(message.content);
      const actualUserText = extractCurrentTurnText(userText);
      if (query && !actualUserText.toLowerCase().includes(query)) continue;
      const turn = {
        sessionFile: filePath,
        lineNo: lines[index].lineNo,
        timestamp: String(current.timestamp || ""),
        userText,
        actualUserText,
        toolCalls: [],
        toolResults: [],
        assistantTexts: [],
        firstToolCall: null,
        artifact: null
      };
      for (let j = index + 1; j < lines.length; j++) {
        const next = lines[j].record;
        const nextMessage = next?.message;
        if (next?.type === "message" && nextMessage?.role === "user") break;
        if (next?.type !== "message" || !nextMessage) continue;
        if (nextMessage.role === "assistant") {
          for (const item of assistantItems(nextMessage)) {
            if (item.type === "toolCall") {
              const call = summarizeToolCall(item);
              turn.toolCalls.push(call);
              if (!turn.firstToolCall) turn.firstToolCall = call;
            }
          }
          const text = summarizeAssistantText(nextMessage);
          if (text) turn.assistantTexts.push(text);
        } else if (nextMessage.role === "toolResult") {
          turn.toolResults.push(summarizeToolResult(nextMessage));
        }
      }
      turn.artifact = matchArtifact(artifacts, turn);
      if (runId && turn.artifact?.runId !== runId) continue;
      turns.push(turn);
    }
  }

  turns.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return {
    sessionsDir,
    query,
    runId,
    includeInternal,
    totalMatches: turns.length,
    turns: turns.slice(0, count).map((turn) => ({
      sessionFile: turn.sessionFile,
      lineNo: turn.lineNo,
      timestamp: turn.timestamp,
      runId: turn.artifact?.runId || "",
      provider: turn.artifact?.provider || "",
      modelId: turn.artifact?.modelId || "",
      modelApi: turn.artifact?.modelApi || "",
      usage: turn.artifact?.usage || null,
      userText: turn.actualUserText,
      toolCalls: turn.toolCalls,
      toolResults: turn.toolResults,
      trajectoryToolMetas: turn.artifact?.toolMetas || [],
      finalAnswer: turn.artifact?.assistantTexts?.at(-1) || turn.assistantTexts.at(-1) || ""
    }))
  };
}

function formatToolArgs(call) {
  const args = isRecord(call.arguments) ? call.arguments : {};
  const query = typeof args.query === "string" ? args.query : "";
  const count = args.count == null ? "" : ` count=${args.count}`;
  return query ? `${call.name}: ${query}${count}` : `${call.name}: ${JSON.stringify(args)}`;
}

export function formatReport(report) {
  const lines = [
    `IMAGEBOT_BEHAVIOR_REPORT matches=${report.totalMatches}`,
    `sessionsDir=${report.sessionsDir}`,
    report.query ? `query=${report.query}` : "",
    report.runId ? `runId=${report.runId}` : "",
    report.includeInternal ? "includeInternal=true" : "includeInternal=false"
  ].filter(Boolean);
  for (const [index, turn] of report.turns.entries()) {
    lines.push("");
    lines.push(`${index + 1}. ${turn.timestamp} run=${turn.runId || "-"} model=${turn.provider || "-"}/${turn.modelId || "-"}`);
    lines.push(`session=${turn.sessionFile}:${turn.lineNo}`);
    lines.push(`user=${clip(turn.userText, 300)}`);
    lines.push(`tools=${turn.toolCalls.length}`);
    for (const call of turn.toolCalls) lines.push(`  call ${formatToolArgs(call)}`);
    for (const result of turn.toolResults) {
      const first = result.firstResult ? ` first=${clip(result.firstResult.title || result.firstResult.url, 160)}` : "";
      lines.push(`  result ${result.name}: status=${result.status || "-"} count=${result.resultCount}${first}`);
    }
    if (turn.usage) {
      lines.push(`usage=input:${turn.usage.input ?? "-"} output:${turn.usage.output ?? "-"} cache:${turn.usage.cacheRead ?? "-"} reasoning:${turn.usage.reasoningTokens ?? "-"}`);
    }
    lines.push(`final=${clip(turn.finalAnswer, 500)}`);
  }
  return lines.join("\n");
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const options = parseArgs();
  const report = await collectBehaviorReport(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
}
