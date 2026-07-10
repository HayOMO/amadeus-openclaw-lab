import assert from "node:assert/strict";
import { analyzeLatencyLog } from "./REPORT_IMAGEBOT_LATENCY.mjs";

const sample = [
  "2026-07-03T20:59:35.814+08:00 [gateway] http server listening (29 plugins: browser, telegram; 7.8s)",
  "2026-07-03T21:47:43.441+08:00 [agent/embedded] [trace:embedded-run] core-plugin-tool stages: runId=run-1 phase=core-plugin-tools totalMs=969 stages=tool-policy:69ms@69ms,openclaw-tools:plugin-tools:801ms@918ms,schema-normalization:4ms@968ms",
  "2026-07-03T21:47:44.031+08:00 [agent/embedded] [trace:embedded-run] prep stages: runId=run-1 sessionId=session-1 accountId=imagebot phase=stream-ready totalMs=1575 stages=workspace-sandbox:9ms@9ms,core-plugin-tools:969ms@979ms,tool-search:383ms@1386ms,system-prompt:18ms@1413ms",
  "2026-07-03T21:47:43.845+08:00 [agent/embedded] tool-search: cataloged 61 tools behind compact directory surface",
  "2026-07-03T22:32:41.926+08:00 [agent/embedded] tool-search: hydrated deferred directory tool feature_catalog",
  "2026-07-04T01:07:14.768+08:00 [agent/embedded] [context-overflow-diag] sessionKey=agent:imagebot:telegram:group:-100 provider=openai/gpt-5.5 source=assistantError messages=35 sessionFile=C:\\redacted diagId=ovf-test compactionAttempts=0 observedTokens=unknown compactionTokens=272001 error=Context overflow",
  "2026-07-04T01:45:10.268+08:00 [fetch-timeout] fetch timeout after 2500ms (elapsed 5572ms) timer delayed 3072ms, likely event-loop starvation operation=fetchWithTimeout url=https://registry.npmjs.org/openclaw/latest",
  "2026-07-03T22:32:36.223+08:00 [model-fallback/decision] model fallback decision: decision=candidate_failed requested=openai/gpt-5.5 candidate=openai/gpt-5.5 reason=rate_limit next=deepseek/deepseek-v4-flash detail=429",
  '{"users":[{"userKey":"tg:1","memoryMarkdown":"x"}],"groupMemoryMarkdown":"y","windowNoteMarkdown":"z"}'
].join("\n");

const report = analyzeLatencyLog(sample, { logPath: "sample.log" });
assert.equal(report.logPath, "sample.log");
assert.equal(report.startup.count, 1);
assert.equal(report.startup.maxMs, 7800);
assert.equal(report.prep.count, 1);
assert.equal(report.prep.maxMs, 1575);
assert.equal(report.prep.topStages[0].name, "core-plugin-tools");
assert.equal(report.corePluginTools.count, 1);
assert.equal(report.corePluginTools.topStages[0].name, "openclaw-tools:plugin-tools");
assert.equal(report.toolSearch.catalogEvents, 1);
assert.equal(report.toolSearch.avgCatalogTools, 61);
assert.deepEqual(report.toolSearch.hydratedTools, ["feature_catalog"]);
assert.equal(report.contextOverflow.events, 1);
assert.equal(report.contextOverflow.maxCompactionTokens, 272001);
assert.equal(report.eventLoopStarvation.events, 1);
assert.equal(report.eventLoopStarvation.maxDelayedMs, 3072);
assert.equal(report.modelFallback.events, 1);
assert.deepEqual(report.modelFallback.reasons, [{ reason: "rate_limit", count: 1 }]);
assert.equal(report.memoryLogBloat.events, 1);
assert.ok(report.memoryLogBloat.maxLineChars > 80);

console.log("imagebot latency report tests passed");
