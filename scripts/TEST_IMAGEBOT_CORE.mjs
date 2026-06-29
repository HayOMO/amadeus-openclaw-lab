import { spawnSync } from "node:child_process";

const tests = [
  ["node", ["scripts/TEST_IMAGEBOT_CONFIG_SOURCE.mjs"]],
  ["node", ["scripts/TEST_REPO_HYGIENE.mjs"]],
  ["node", ["scripts/TEST_AGENT_PERSONA_CATALOG.mjs"]],
  ["node", ["scripts/TEST_CAPABILITY_SURFACE.mjs"]],
  ["node", ["scripts/TEST_FEATURE_HEALTH.mjs"]],
  ["node", ["scripts/TEST_BROWSER_GUARD_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_RUNTIME_PATCH_MANIFEST.mjs"]],
  ["node", ["scripts/TEST_RUNTIME_PATCH_GOVERNANCE.mjs"]],
  ["node", ["scripts/TEST_TELEGRAM_MEDIA_DELIVERY_PATCH.mjs"]],
  ["node", ["scripts/TEST_IMAGEBOT_MULTIMODAL_ROUTE.mjs"]],
  ["node", ["scripts/TEST_IMAGEBOT_WINDOW_ROUTING.mjs"]],
  ["node", ["scripts/TEST_INTERACTION_CORE_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_INTERACTION_SESSION_REGISTRY.mjs"]],
  ["node", ["scripts/REPLAY_TELEGRAM_TURNS.mjs"]],
  ["node", ["scripts/REPLAY_TELEGRAM_SCENARIOS.mjs"]],
  ["node", ["scripts/TEST_WEB_IMAGE_SEARCH_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_MEMORY_CURATOR_SCRIPT.mjs"]],
  ["node", ["scripts/TEST_MEMORY_SEARCH_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_PERSONA_SEARCH_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_ZHIHU_OPENAPI_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_AUDIO_TRANSCRIBE_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_PUBLIC_VIDEO_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_PIXIV_RESOURCE_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_IMAGE_SKILLS_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_MEME_TOOLS_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_KNOWLEDGE_LIBRARY_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_BACKGROUND_JOBS_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_TURN_OBSERVER_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_CREATIVE_OPS_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_GENERATED_GALLERY_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_GROUP_ADVENTURE_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_FEATURE_CORE_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_PRACTICAL_TOOLS_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_DESKTOP_CONTROL_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_STICKER_PACK_PLUGIN.mjs"]],
  ["node", ["scripts/TEST_SESSION_IMAGE_PRUNE.mjs"]],
  ["node", ["scripts/TEST_SESSION_REPAIR.mjs"]],
  ["node", ["scripts/TEST_WINDOW_STORE_REPAIR.mjs"]],
  ["node", ["scripts/TEST_VIDEO_UTILS_PLUGIN.mjs"]]
];

for (const [cmd, args] of tests) {
  const label = `${cmd} ${args.join(" ")}`;
  console.log(`\n> ${label}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("\nimagebot core tests passed");
