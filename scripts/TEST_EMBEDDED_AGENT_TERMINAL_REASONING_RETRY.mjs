import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const distDir = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Microsoft",
  "WinGet",
  "Packages",
  "OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe",
  "node-v24.15.0-win-x64",
  "node_modules",
  "openclaw",
  "dist",
);

async function readDistFile(prefix, marker) {
  const names = await fs.readdir(distDir);
  for (const name of names.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".js")).sort()) {
    const filePath = path.join(distDir, name);
    const source = await fs.readFile(filePath, "utf8");
    if (!marker || source.includes(marker)) return { name, source, filePath };
  }
  throw new Error(`No dist file found for ${prefix} with marker ${marker || "(none)"}`);
}

const selectionFile = await readDistFile("selection-", "REASONING_ONLY_RETRY_INSTRUCTION");
const { source } = selectionFile;

assert.match(source, /function hasTerminalAssistantVisibleText\(attempt\)/);
assert.match(source, /resolveFinalAssistantVisibleText\(assistant\)\?\.trim\(\)/);
assert.match(
  source,
  /joinAssistantTexts\(params\.attempt\.assistantTexts\)\.length > 0 && hasTerminalAssistantVisibleText\(params\.attempt\)/,
);
assert.match(source, /REASONING_ONLY_RETRY_INSTRUCTION/);

const selection = await import(pathToFileURL(selectionFile.filePath).href);
const resolveReasoningOnlyRetryInstruction = selection.F ?? selection.R;

function baseAttempt(lastAssistant) {
  return {
    assistantTexts: ["搜到不少了，我再确认几个细节。"],
    lastAssistant,
    currentAttemptAssistant: lastAssistant,
    toolMetas: [{ toolName: "explicit_web_text_search" }],
    acceptedSessionSpawns: [],
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    didSendDeterministicApprovalPrompt: false,
    lastToolError: null,
    yieldDetected: false,
  };
}

const reasoningOnlyRetry = resolveReasoningOnlyRetryInstruction({
  provider: "deepseek",
  modelId: "deepseek-v4-pro",
  modelApi: "openai-completions",
  executionContract: "standard",
  aborted: false,
  timedOut: false,
  attempt: baseAttempt({
    role: "assistant",
    stopReason: "length",
    usage: { output: 1024 },
    content: [{ type: "thinking", thinking: "internal reasoning only", thinkingSignature: "reasoning_content" }],
  }),
});
assert.match(reasoningOnlyRetry, /produce the visible answer now/);

const visibleTerminalRetry = resolveReasoningOnlyRetryInstruction({
  provider: "deepseek",
  modelId: "deepseek-v4-pro",
  modelApi: "openai-completions",
  executionContract: "standard",
  aborted: false,
  timedOut: false,
  attempt: baseAttempt({
    role: "assistant",
    stopReason: "stop",
    usage: { output: 80 },
    content: [{ type: "text", text: "最终答案。"}],
  }),
});
assert.equal(visibleTerminalRetry, null);

console.log("embedded agent terminal reasoning retry patch ok");
