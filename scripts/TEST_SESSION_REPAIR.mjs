import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { repairSessionFile } from "./REPAIR_IMAGEBOT_SESSIONS.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "imagebot-session-repair-test-"));

try {
  const sessionPath = path.join(root, "session-a.jsonl");
  const results = Array.from({ length: 8 }, (_unused, index) => ({
    title: `candidate ${index + 1}`,
    imageUrl: `https://img.example.test/${index + 1}.jpg`,
    thumbnailUrl: `https://thumb.example.test/${index + 1}.jpg`,
    sourceUrl: `https://source.example.test/${index + 1}`,
    source: "fixture",
    width: 512,
    height: 512,
    format: "jpeg"
  }));
  const noisyText = [
    'WEB_IMAGE_SEARCH results for "fixture query":',
    ...results.flatMap((item, index) => [
      `${index + 1}. ${item.title}`,
      `   imageUrl: ${item.imageUrl}`,
      `   thumbnailUrl: ${item.thumbnailUrl}`,
      `   sourceUrl: ${item.sourceUrl}`,
      "   source: fixture",
      "   size: 512x512",
      "   format: jpeg"
    ])
  ].join("\n");
  const lines = [
    JSON.stringify({ type: "session", id: "session-a" }),
    JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "web_image_search",
        content: [{ type: "text", text: noisyText }],
        details: { status: "ok", query: "fixture query", results }
      }
    }),
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorCode: "server_is_overloaded",
        errorMessage: "Our servers are currently overloaded. Please try again later.",
        responseId: "resp_fixture"
      }
    }),
    JSON.stringify({ type: "message", message: { role: "user", content: "[object Object]" } })
  ];
  await fs.writeFile(sessionPath, `${lines.join("\n")}\n`, "utf8");

  const repaired = await repairSessionFile(sessionPath, { ignoreLocks: true });
  assert.equal(repaired.changed, true);
  assert.equal(repaired.compactedToolResults, 1);
  assert.equal(repaired.normalizedErrors, 1);
  assert.equal(repaired.removedMessages, 1);
  assert.ok(repaired.backupPath);

  const text = await fs.readFile(sessionPath, "utf8");
  const records = text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const visibleText = records[1].message.content[0].text;
  assert.match(visibleText, /candidate 6/);
  assert.doesNotMatch(visibleText, /candidate 7/);
  assert.equal(records[1].message.details.originalResultCount, 8);
  assert.doesNotMatch(text, /thumbnailUrl/);
  assert.doesNotMatch(text, /server_is_overloaded/);
  assert.doesNotMatch(text, /\[object Object\]/);
  assert.match(text, /provider overload/);

  const secondRun = await repairSessionFile(sessionPath, { ignoreLocks: true });
  assert.equal(secondRun.changed, false);
  assert.equal(secondRun.compactedToolResults, 0);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}

console.log("session repair tests passed");
