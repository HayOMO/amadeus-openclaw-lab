import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectBehaviorReport, extractCurrentTurnText, formatReport, parseArgs } from "./REPORT_IMAGEBOT_RECENT_BEHAVIOR.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-behavior-report-test-"));
const sessionPath = path.join(root, "session-a.jsonl");
const trajectoryPath = path.join(root, "session-a.trajectory.jsonl");

const currentTurn = [
  "[Telegram current turn]",
  "window_id=w1",
  "[/Telegram current turn]",
  "",
  "助手帮我bet一下今日世界杯"
].join("\n");

const records = [
  {
    type: "message",
    id: "u1",
    timestamp: "2026-07-01T16:25:48.050Z",
    message: { role: "user", content: currentTurn }
  },
  {
    type: "message",
    id: "a1",
    timestamp: "2026-07-01T16:25:55.204Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc1",
          name: "explicit_web_text_search",
          arguments: { query: "2026 FIFA World Cup fixtures July 2 2026 matches odds", count: 6 }
        }
      ]
    }
  },
  {
    type: "message",
    id: "tr1",
    timestamp: "2026-07-01T16:25:57.204Z",
    message: {
      role: "toolResult",
      toolName: "explicit_web_text_search",
      details: {
        status: "ok",
        query: "2026 FIFA World Cup fixtures July 2 2026 matches odds",
        results: [
          {
            title: "World Cup 2026 | Match schedule, fixtures, results & stadiums - FIFA",
            url: "https://www.fifa.com/example",
            snippet: "Find out the full match schedule."
          }
        ]
      },
      content: [{ type: "text", text: "ok" }]
    }
  },
  {
    type: "message",
    id: "a2",
    timestamp: "2026-07-01T16:26:12.204Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "发赛程和赔率，我给你做三档。" }]
    }
  }
];

const artifacts = [
  {
    traceSchema: "openclaw-trajectory",
    type: "trace.artifacts",
    ts: "2026-07-01T16:26:32.338Z",
    sessionId: "session-a",
    runId: "run-a",
    provider: "openai",
    modelId: "gpt-5.5",
    modelApi: "openai-chatgpt-responses",
    data: {
      finalPromptText: currentTurn,
      usage: { input: 10, output: 20, cacheRead: 30, reasoningTokens: 4 },
      assistantTexts: ["发赛程和赔率，我给你做三档。"],
      toolMetas: [
        { toolName: "explicit_web_text_search", meta: "2026 FIFA World Cup fixtures July 2 2026 matches odds" }
      ]
    }
  }
];

await fs.writeFile(sessionPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
await fs.writeFile(trajectoryPath, artifacts.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");

assert.equal(extractCurrentTurnText(currentTurn), "助手帮我bet一下今日世界杯");

const parsed = parseArgs(["--sessions-dir", root, "--query", "世界杯", "--count", "2"]);
assert.equal(parsed.sessionsDir, root);
assert.equal(parsed.query, "世界杯");

const report = await collectBehaviorReport({ sessionsDir: root, query: "世界杯", count: 2 });
assert.equal(report.totalMatches, 1);
assert.equal(report.turns.length, 1);
assert.equal(report.turns[0].runId, "run-a");
assert.equal(report.turns[0].toolCalls.length, 1);
assert.equal(report.turns[0].toolCalls[0].name, "explicit_web_text_search");
assert.equal(report.turns[0].toolCalls[0].arguments.query, "2026 FIFA World Cup fixtures July 2 2026 matches odds");
assert.equal(report.turns[0].toolResults[0].resultCount, 1);
assert.match(report.turns[0].finalAnswer, /三档/);

const runFiltered = await collectBehaviorReport({ sessionsDir: root, runId: "run-a" });
assert.equal(runFiltered.totalMatches, 1);

const formatted = formatReport(report);
assert.match(formatted, /IMAGEBOT_BEHAVIOR_REPORT matches=1/);
assert.match(formatted, /explicit_web_text_search/);
assert.match(formatted, /FIFA/);

console.log("imagebot behavior report tests passed");
