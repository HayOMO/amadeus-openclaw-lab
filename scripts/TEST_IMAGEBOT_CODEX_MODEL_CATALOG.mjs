import assert from "node:assert/strict";
import { normalizeCodexModelsCache } from "./IMAGEBOT_CODEX_MODEL_CATALOG.mjs";

const models = normalizeCodexModelsCache({
  models: [
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      visibility: "list",
      supported_in_api: true,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }]
    },
    {
      slug: "gpt-5.6-terra",
      display_name: "GPT-5.6-Terra",
      visibility: "list",
      supported_in_api: true,
      input_modalities: ["text", "image"]
    },
    {
      slug: "gpt-5.6-luna",
      display_name: "GPT-5.6-Luna",
      visibility: "list",
      supported_in_api: true,
      input_modalities: ["text", "image"]
    },
    {
      slug: "future-text-model",
      display_name: "Future Text Model",
      visibility: "list",
      supported_in_api: true,
      input_modalities: ["text"]
    },
    {
      slug: "gpt-5.3-codex-spark",
      visibility: "list",
      supported_in_api: false,
      input_modalities: ["text"]
    },
    {
      slug: "codex-auto-review",
      visibility: "hide",
      supported_in_api: true,
      input_modalities: ["text", "image"]
    }
  ]
});

for (const id of ["openai/gpt-5.6-sol", "openai/gpt-5.6-terra", "openai/gpt-5.6-luna"]) {
  const model = models.find((item) => item.id === id);
  assert.ok(model, `missing visible backend model ${id}`);
  assert.deepEqual(model.nativeCapabilities, ["text", "vision"], `${id} must preserve verified image input`);
}
assert.deepEqual(
  models.find((item) => item.id === "openai/future-text-model")?.nativeCapabilities,
  ["text"],
  "future text-only models must not be guessed to support images"
);
assert.equal(models.some((item) => item.id === "openai/gpt-5.3-codex-spark"), false, "non-API Codex models must stay out of the backend menu");
assert.equal(models.some((item) => item.id === "openai/codex-auto-review"), false, "hidden Codex models must stay hidden");

console.log("imagebot Codex model catalog tests passed");
