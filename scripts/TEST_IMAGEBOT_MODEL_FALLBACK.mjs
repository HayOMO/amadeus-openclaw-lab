import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveOpenClawDistDir } from "./OPENCLAW_RUNTIME_PATHS.mjs";

const distDir = resolveOpenClawDistDir();

async function findDistFile(prefix, marker) {
  const names = await fsp.readdir(distDir);
  for (const name of names.filter((entry) => entry.startsWith(prefix) && entry.endsWith(".js")).sort()) {
    const filePath = path.join(distDir, name);
    const source = await fsp.readFile(filePath, "utf8");
    if (source.includes(marker)) return { filePath, name, source };
  }
  throw new Error(`No dist file found for ${prefix} with marker ${marker}`);
}

const fallbackModels = ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"];
const cfg = {
  agents: {
    defaults: {
      model: {
        primary: "openai/gpt-5.5",
        fallbacks: fallbackModels,
      },
    },
    list: [
      {
        id: "imagebot",
        model: {
          primary: "openai/gpt-5.5",
          fallbacks: fallbackModels,
        },
      },
    ],
  },
};

const agentScope = await findDistFile("agent-scope-", "if (!params.hasSessionModelOverride)");
const agentScopeModule = await import(pathToFileURL(agentScope.filePath).href);
const resolveEffectiveModelFallbacks = agentScopeModule.resolveEffectiveModelFallbacks ?? agentScopeModule.h;
const agentRunner = await findDistFile("agent-runner.runtime-", "function buildFallbackNotice");

assert.equal(typeof resolveEffectiveModelFallbacks, "function", "resolveEffectiveModelFallbacks export is missing");
assert.match(
  agentScope.source,
  /params\.modelOverrideSource === "default"/,
  "default /ammodel session selections must keep configured model fallbacks enabled",
);

assert.deepEqual(
  resolveEffectiveModelFallbacks({
    cfg,
    agentId: "imagebot",
    sessionKey: "telegram:imagebot:test",
    hasSessionModelOverride: false,
  }),
  fallbackModels,
  "agent defaults should expose configured fallback models",
);
assert.deepEqual(
  resolveEffectiveModelFallbacks({
    cfg,
    agentId: "imagebot",
    sessionKey: "telegram:imagebot:test",
    hasSessionModelOverride: true,
    modelOverrideSource: "default",
  }),
  fallbackModels,
  "/ammodel default session selections should still be able to fallback",
);
assert.deepEqual(
  resolveEffectiveModelFallbacks({
    cfg,
    agentId: "imagebot",
    sessionKey: "telegram:imagebot:test",
    hasSessionModelOverride: true,
    modelOverrideSource: "auto",
  }),
  fallbackModels,
  "auto fallback sessions should keep probing the configured chain",
);
assert.deepEqual(
  resolveEffectiveModelFallbacks({
    cfg,
    agentId: "imagebot",
    sessionKey: "telegram:imagebot:test",
    hasSessionModelOverride: true,
    modelOverrideSource: "user",
  }),
  [],
  "explicit non-default user overrides should still be isolated from configured fallbacks",
);

assert.match(
  agentRunner.source,
  /模型已临时切到 \$\{params\.activeModel\}/,
  "fallback transition notice should be a visible Chinese user-facing message",
);
assert.match(
  agentRunner.source,
  /原\$\{params\.selectedModel\}/,
  "fallback transition notice should name the selected model without provider prefix",
);
assert.match(
  agentRunner.source,
  /已恢复到\$\{params\.selectedModel\}/,
  "fallback cleared notice should be localized",
);
assert.doesNotMatch(agentRunner.source, /当前窗口后续先用这个 fallback/);
assert.doesNotMatch(agentRunner.source, /formatProviderModelRef\(params\.selectedProvider, params\.selectedModel\);\n\tconst previous/);
assert.doesNotMatch(agentRunner.source, /Model Fallback:/, "fallback notice should not use the default English copy");

console.log("imagebot model fallback tests passed", { agentScope: agentScope.name, agentRunner: agentRunner.name });
