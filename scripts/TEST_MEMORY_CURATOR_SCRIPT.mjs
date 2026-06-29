import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();

const script = await fs.readFile(path.join(repoRoot, "scripts", "CONSOLIDATE_IMAGEBOT_MEMORY.mjs"), "utf8");
const wrapper = await fs.readFile(path.join(repoRoot, "scripts", "CONSOLIDATE_IMAGEBOT_MEMORY.ps1"), "utf8");
const modelCatalog = JSON.parse(await fs.readFile(path.join(repoRoot, "scripts", "IMAGEBOT_MODEL_PROFILES.json"), "utf8"));
const deepProfile = modelCatalog.profiles.find((profile) => profile.id === "deep");

assert.ok(script.includes('const curatorProfile = args.get("curator-profile") || "deep"'), "curator must default to GPT high profile");
assert.equal(deepProfile?.model, "openai/gpt-5.5", "deep profile must use GPT-5.5");
assert.equal(deepProfile?.reasoningEffort, "high", "deep profile must use high reasoning");
assert.ok(script.includes('commandArgs.push("--model", curatorModel)'), "curator must pass a single-run model override when configured");
assert.ok(script.includes("neutral memory curator"), "curator prompt must be neutral");
assert.ok(script.includes("Memory is shared across speaking personas"), "curator prompt must use shared persona memory");
assert.ok(script.includes("Memory rules:"), "curator prompt should use neutral memory-rule wording");
assert.ok(!script.includes("private memory curator"), "curator prompt must not describe itself as private/persona-bound");
assert.ok(!script.includes("Privacy and safety:"), "curator prompt should not foreground safety framing");

assert.ok(wrapper.includes('[string]$CuratorProfile = "deep"'), "PowerShell wrapper must default to GPT high profile");
assert.ok(wrapper.includes('"--curator-profile", $CuratorProfile'), "PowerShell wrapper must pass curator profile");
assert.ok(wrapper.includes('"--curator-model", $CuratorModel'), "PowerShell wrapper must expose curator model override");
assert.ok(wrapper.includes('"--curator-thinking", $CuratorThinking'), "PowerShell wrapper must expose curator thinking override");

console.log("memory curator script tests passed");
