import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveOpenClawDistDir } from "./OPENCLAW_RUNTIME_PATHS.mjs";

const distDir = resolveOpenClawDistDir();

const truncationModule = await import(pathToFileURL(path.join(distDir, "tool-result-truncation-CFLypc-Q.js")).href);
const truncateOversizedToolResultsInMessages = truncationModule.s;
const truncateToolResultMessage = truncationModule.u;

assert.equal(typeof truncateOversizedToolResultsInMessages, "function");
assert.equal(typeof truncateToolResultMessage, "function");

const oldImageData = "a".repeat(160_000);
const recentImageData = "b".repeat(90_000);
const oldToolResult = {
  role: "toolResult",
  content: [
    { type: "text", text: "WEB_SNAPSHOT ok\nMEDIA: `C:\\Users\\Bot\\.openclaw\\media\\web\\old.png`" },
    { type: "image", data: oldImageData, mimeType: "image/png", fileName: "old.png" }
  ]
};
const recentToolResult = {
  role: "toolResult",
  content: [
    { type: "text", text: "WEB_SNAPSHOT ok\nMEDIA: `C:\\Users\\Bot\\.openclaw\\media\\web\\recent.jpg`" },
    { type: "image", data: recentImageData, mimeType: "image/jpeg", fileName: "recent.jpg" }
  ]
};
const nestedImageData = "c".repeat(150_000);
const truncatedNestedImageData = "iVBORw0KGgo" + "d".repeat(12_000);
const nestedToolResult = {
  role: "toolResult",
  content: [{
    type: "text",
    text: JSON.stringify({
      tool: { name: "web_card" },
      result: {
        content: [
          { type: "text", text: "WEB_CARD ok\nMEDIA: `C:\\Users\\Bot\\.openclaw\\media\\web\\card.png`" },
          { type: "image", data: nestedImageData, mimeType: "image/png", fileName: "card.png" }
        ]
      }
    }, null, 2)
  }]
};
const truncatedNestedToolResult = {
  role: "toolResult",
  content: [{
    type: "text",
    text: `{"tool":{"name":"web_card"},"result":{"content":[{"type":"text","text":"WEB_CARD ok"},{"type":"image","data":"${truncatedNestedImageData}[... 36073 more characters truncated; rerun with narrower args if needed]`
  }]
};

const compactedDirect = truncateToolResultMessage(oldToolResult, 64_000);
assert.equal(compactedDirect.content.some((block) => block?.type === "image" && block.data === oldImageData), false);
assert.match(JSON.stringify(compactedDirect), /saved image preview pruned from tool result history/);
assert.match(JSON.stringify(compactedDirect), /base64Chars=160000/);

const compactedNested = truncateToolResultMessage(nestedToolResult, 64_000);
const compactedNestedJson = JSON.stringify(compactedNested);
assert.equal(compactedNestedJson.includes(nestedImageData), false);
assert.match(compactedNestedJson, /embedded image data pruned from tool result history/);
assert.match(compactedNestedJson, /base64Chars=150000/);
assert.ok(compactedNestedJson.length < 20_000);

const compactedTruncatedNested = truncateToolResultMessage(truncatedNestedToolResult, 64_000);
const compactedTruncatedNestedJson = JSON.stringify(compactedTruncatedNested);
assert.equal(compactedTruncatedNestedJson.includes(truncatedNestedImageData.slice(0, 200)), false);
assert.match(compactedTruncatedNestedJson, /embedded image data pruned from tool result history/);
assert.match(compactedTruncatedNestedJson, /base64Chars=12011/);
assert.match(compactedTruncatedNestedJson, /\[embedded image data pruned from tool result history base64Chars=12011\]\[\.\.\. 36073 more characters truncated/);
assert.ok(compactedTruncatedNestedJson.length < 4_000);

const underCapHistory = truncateOversizedToolResultsInMessages(
  [{ role: "user", content: "preview" }, truncatedNestedToolResult],
  200_000,
  64_000,
  128_000
);
assert.equal(underCapHistory.truncatedCount, 1);
assert.equal(JSON.stringify(underCapHistory.messages).includes(truncatedNestedImageData.slice(0, 200)), false);

const promptHistory = [
  { role: "user", content: "look this up" },
  oldToolResult,
  { role: "assistant", content: [{ type: "text", text: "I saw the older snapshot." }] },
  nestedToolResult,
  { role: "assistant", content: [{ type: "text", text: "I saw the nested snapshot." }] },
  recentToolResult
];
const truncatedHistory = truncateOversizedToolResultsInMessages(promptHistory, 200_000, 64_000, 128_000);
assert.ok(truncatedHistory.truncatedCount >= 1);

const oldAfter = truncatedHistory.messages[1];
const nestedAfter = truncatedHistory.messages[3];
const recentAfter = truncatedHistory.messages[5];
assert.equal(oldAfter.content.some((block) => block?.type === "image" && block.data === oldImageData), false);
assert.match(JSON.stringify(oldAfter), /saved image preview pruned from tool result history/);
assert.equal(JSON.stringify(nestedAfter).includes(nestedImageData), false);
assert.match(JSON.stringify(nestedAfter), /embedded image data pruned from tool result history/);
assert.equal(recentAfter.content.some((block) => block?.type === "image" && block.data === recentImageData), true);

const selectionSource = await fs.readFile(path.join(distDir, "selection-BfRwHcjH.js"), "utf8");
assert.match(selectionSource, /function estimateImageBlockChars/);
assert.match(selectionSource, /Math\.max\(IMAGE_CHAR_ESTIMATE, data\.length\)/);

console.log("tool result image history runtime patch tests passed");
