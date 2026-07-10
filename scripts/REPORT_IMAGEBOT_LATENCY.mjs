#!/usr/bin/env node
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultLogDir = path.join(repoRoot, "logs");
const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024;

function readArgs(argv = process.argv.slice(2)) {
  const args = { json: false, log: "", tailBytes: DEFAULT_TAIL_BYTES };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") args.json = true;
    else if (arg === "--log") args.log = argv[++i] || "";
    else if (arg.startsWith("--log=")) args.log = arg.slice("--log=".length);
    else if (arg === "--tail-bytes") args.tailBytes = Math.max(1024, Number(argv[++i]) || DEFAULT_TAIL_BYTES);
    else if (arg.startsWith("--tail-bytes=")) args.tailBytes = Math.max(1024, Number(arg.slice("--tail-bytes=".length)) || DEFAULT_TAIL_BYTES);
  }
  return args;
}

async function latestGatewayLog(logDir = defaultLogDir) {
  const entries = await fs.readdir(logDir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^imagebot-gateway-.*\.log$/i.test(entry.name)) continue;
    const filePath = path.join(logDir, entry.name);
    const stat = await fs.stat(filePath).catch(() => null);
    if (stat?.isFile()) files.push({ filePath, mtimeMs: stat.mtimeMs });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!files.length) throw new Error(`no imagebot gateway logs found under ${logDir}`);
  return files[0].filePath;
}

async function readTail(filePath, maxBytes = DEFAULT_TAIL_BYTES) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`not a file: ${filePath}`);
  if (stat.size <= maxBytes) return decodeLogBuffer(await fs.readFile(filePath));
  const handle = await fs.open(filePath, "r");
  try {
    const position = Math.max(0, stat.size - maxBytes);
    const alignedPosition = position % 2 === 0 ? position : position + 1;
    const length = stat.size - alignedPosition;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, alignedPosition);
    return decodeLogBuffer(buffer);
  } finally {
    await handle.close();
  }
}

function looksLikeUtf16Le(buffer) {
  if (!buffer?.length) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let zeroOdd = 0;
  let pairs = 0;
  for (let i = 1; i < sample.length; i += 2) {
    pairs++;
    if (sample[i] === 0) zeroOdd++;
  }
  return pairs > 16 && zeroOdd / pairs > 0.5;
}

function decodeLogBuffer(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString("utf16le");
  if (looksLikeUtf16Le(buffer)) return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeDurations(values) {
  return {
    count: values.length,
    avgMs: Math.round(average(values)),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length ? Math.max(...values) : 0
  };
}

function parseStageList(value = "") {
  const stages = [];
  for (const match of String(value).matchAll(/([^,]+?):(\d+)ms@(\d+)ms/g)) {
    stages.push({
      name: match[1].trim(),
      ms: Number(match[2]),
      atMs: Number(match[3])
    });
  }
  return stages;
}

function aggregateStages(records) {
  const byName = new Map();
  for (const record of records) {
    for (const stage of record.stages || []) {
      const bucket = byName.get(stage.name) || [];
      bucket.push(stage.ms);
      byName.set(stage.name, bucket);
    }
  }
  return [...byName.entries()]
    .map(([name, values]) => ({ name, ...summarizeDurations(values) }))
    .sort((a, b) => b.avgMs - a.avgMs)
    .slice(0, 12);
}

function parseKeyValue(line, key) {
  const match = line.match(new RegExp(`${key}=([^\\s]+)`));
  return match ? match[1] : "";
}

export function analyzeLatencyLog(text, { logPath = "" } = {}) {
  const lines = String(text || "").split(/\r?\n/);
  const startupMs = [];
  const prepRecords = [];
  const corePluginRecords = [];
  const toolCatalogs = [];
  const toolHydrations = [];
  const fetchStarvations = [];
  const contextOverflows = [];
  const modelFallbacks = [];
  const memoryJsonLogs = [];

  for (const line of lines) {
    if (!line) continue;
    const startup = line.match(/\[gateway\] http server listening .*;\s*([\d.]+)s\)/);
    if (startup) startupMs.push(Math.round(Number(startup[1]) * 1000));

    const prep = line.match(/\[trace:embedded-run\] prep stages: .*?phase=([^\s]+)\s+totalMs=(\d+)\s+stages=(.*)$/);
    if (prep) {
      prepRecords.push({
        phase: prep[1],
        totalMs: Number(prep[2]),
        runId: parseKeyValue(line, "runId"),
        sessionId: parseKeyValue(line, "sessionId"),
        stages: parseStageList(prep[3])
      });
    }

    const core = line.match(/\[trace:embedded-run\] core-plugin-tool stages: .*?phase=([^\s]+)\s+totalMs=(\d+)\s+stages=(.*)$/);
    if (core) {
      corePluginRecords.push({
        phase: core[1],
        totalMs: Number(core[2]),
        runId: parseKeyValue(line, "runId"),
        stages: parseStageList(core[3])
      });
    }

    const catalog = line.match(/tool-search: cataloged\s+(\d+)\s+(?:client\s+)?tools?/i);
    if (catalog) toolCatalogs.push({ tools: Number(catalog[1]), line: line.slice(0, 240) });

    const hydration = line.match(/tool-search: hydrated deferred directory tool\s+([^\s]+)/i);
    if (hydration) toolHydrations.push(hydration[1]);

    const starvation = line.match(/fetch timeout after\s+(\d+)ms\s+\(elapsed\s+(\d+)ms\)\s+timer delayed\s+(\d+)ms.*?operation=([^\s]+)\s+url=([^\s]+)/i);
    if (starvation) {
      fetchStarvations.push({
        timeoutMs: Number(starvation[1]),
        elapsedMs: Number(starvation[2]),
        delayedMs: Number(starvation[3]),
        operation: starvation[4],
        url: starvation[5]
      });
    }

    const overflow = line.match(/\[context-overflow-diag\].*?messages=(\d+).*?diagId=([^\s]+).*?compactionAttempts=(\d+).*?compactionTokens=([^\s]+)/);
    if (overflow) {
      contextOverflows.push({
        messages: Number(overflow[1]),
        diagId: overflow[2],
        compactionAttempts: Number(overflow[3]),
        compactionTokens: Number(overflow[4]) || 0
      });
    }

    const fallback = line.match(/model fallback decision: decision=([^\s]+).*?requested=([^\s]+).*?candidate=([^\s]+).*?reason=([^\s]+).*?next=([^\s]+)/);
    if (fallback) {
      modelFallbacks.push({
        decision: fallback[1],
        requested: fallback[2],
        candidate: fallback[3],
        reason: fallback[4],
        next: fallback[5]
      });
    }

    if (line.includes('"memoryMarkdown"') && (line.includes('"groupMemoryMarkdown"') || line.includes('"windowNoteMarkdown"'))) {
      memoryJsonLogs.push({
        chars: line.length,
        preview: line.slice(0, 160)
      });
    }
  }

  const prepTotals = prepRecords.map((record) => record.totalMs);
  const coreTotals = corePluginRecords.map((record) => record.totalMs);
  return {
    generatedAt: new Date().toISOString(),
    logPath,
    lines: lines.length,
    startup: summarizeDurations(startupMs),
    prep: {
      ...summarizeDurations(prepTotals),
      topStages: aggregateStages(prepRecords)
    },
    corePluginTools: {
      ...summarizeDurations(coreTotals),
      topStages: aggregateStages(corePluginRecords)
    },
    toolSearch: {
      catalogEvents: toolCatalogs.length,
      avgCatalogTools: Math.round(average(toolCatalogs.map((item) => item.tools))),
      maxCatalogTools: toolCatalogs.length ? Math.max(...toolCatalogs.map((item) => item.tools)) : 0,
      hydrationEvents: toolHydrations.length,
      hydratedTools: [...new Set(toolHydrations)].slice(0, 20)
    },
    contextOverflow: {
      events: contextOverflows.length,
      maxCompactionTokens: contextOverflows.length ? Math.max(...contextOverflows.map((item) => item.compactionTokens)) : 0,
      samples: contextOverflows.slice(-5)
    },
    eventLoopStarvation: {
      events: fetchStarvations.length,
      maxDelayedMs: fetchStarvations.length ? Math.max(...fetchStarvations.map((item) => item.delayedMs)) : 0,
      samples: fetchStarvations.slice(-5)
    },
    modelFallback: {
      events: modelFallbacks.length,
      reasons: [...modelFallbacks.reduce((map, item) => map.set(item.reason, (map.get(item.reason) || 0) + 1), new Map()).entries()]
        .map(([reason, count]) => ({ reason, count })),
      samples: modelFallbacks.slice(-5)
    },
    memoryLogBloat: {
      events: memoryJsonLogs.length,
      maxLineChars: memoryJsonLogs.length ? Math.max(...memoryJsonLogs.map((item) => item.chars)) : 0,
      samples: memoryJsonLogs.slice(-3)
    }
  };
}

function formatSummary(report) {
  const lines = [
    `Imagebot latency report: ${report.logPath || "(input)"}`,
    `lines=${report.lines}`,
    `startup count=${report.startup.count} avg=${report.startup.avgMs}ms p95=${report.startup.p95Ms}ms max=${report.startup.maxMs}ms`,
    `prep count=${report.prep.count} avg=${report.prep.avgMs}ms p95=${report.prep.p95Ms}ms max=${report.prep.maxMs}ms`,
    `core-plugin-tools count=${report.corePluginTools.count} avg=${report.corePluginTools.avgMs}ms p95=${report.corePluginTools.p95Ms}ms max=${report.corePluginTools.maxMs}ms`,
    `tool-search catalog_events=${report.toolSearch.catalogEvents} avg_tools=${report.toolSearch.avgCatalogTools} max_tools=${report.toolSearch.maxCatalogTools} hydrations=${report.toolSearch.hydrationEvents}`,
    `context-overflow events=${report.contextOverflow.events} max_compaction_tokens=${report.contextOverflow.maxCompactionTokens}`,
    `event-loop-starvation events=${report.eventLoopStarvation.events} max_delayed_ms=${report.eventLoopStarvation.maxDelayedMs}`,
    `model-fallback events=${report.modelFallback.events}`,
    `memory-log-bloat events=${report.memoryLogBloat.events} max_line_chars=${report.memoryLogBloat.maxLineChars}`
  ];
  if (report.prep.topStages.length) {
    lines.push("", "Top prep stages:");
    for (const stage of report.prep.topStages.slice(0, 6)) {
      lines.push(`- ${stage.name}: avg=${stage.avgMs}ms p95=${stage.p95Ms}ms max=${stage.maxMs}ms count=${stage.count}`);
    }
  }
  if (report.corePluginTools.topStages.length) {
    lines.push("", "Top core-plugin stages:");
    for (const stage of report.corePluginTools.topStages.slice(0, 6)) {
      lines.push(`- ${stage.name}: avg=${stage.avgMs}ms p95=${stage.p95Ms}ms max=${stage.maxMs}ms count=${stage.count}`);
    }
  }
  return lines.join("\n");
}

async function main() {
  const args = readArgs();
  const logPath = path.resolve(args.log || await latestGatewayLog());
  if (!fsSync.existsSync(logPath)) throw new Error(`log file not found: ${logPath}`);
  const text = await readTail(logPath, args.tailBytes);
  const report = analyzeLatencyLog(text, { logPath });
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatSummary(report)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
