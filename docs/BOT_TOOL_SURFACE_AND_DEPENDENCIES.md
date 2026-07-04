# Bot Tool Surface And Dependencies

This document is the durable inventory for the active Telegram bot tool surface.
It should be updated whenever `config/imagebot/settings.json`, plugin manifests,
or plugin-to-plugin imports change.

## Snapshot

- Active local plugins: 25.
- Allowed tools: 61 total.
- Built-in allowed tools: 3 (`image`, `image_generate`, `message`).
- Plugin-owned allowed tools: 58.
- Ordinary chat tools: 41.
- Operator-only tools: 20.
- Provider-visible schema mode: OpenClaw `tools.toolSearch` `directory` mode.
  The allowed surface stays the same, but most heavyweight schemas are deferred
  behind `tool_search`, `tool_describe`, and `tool_call` at runtime.
- Model profiles are not additional tools. The `spark` profile is exposed for
  experimental chat-only testing and blocked from OpenClaw tool execution by
  `imagebot-creative-ops` `before_tool_call`.
- Telegram text repeat is a pre-model runtime script configured by
  `imagebot-interaction-core.config.textRepeater`; it is intentionally not
  model-visible and does not add a tool schema.
- Manifest tools intentionally not exposed: `web_text_search`, `bot_board`,
  `image_skill_lookup`, `image_skill_recent`, `knowledge_sources`,
  `knowledge_search`, `knowledge_recent`, `generated_gallery_recent`,
  `generated_gallery_search`, `generated_gallery_stats`,
  `media_artifact_recent`, `media_artifact_lineage`, `artifact_recent`,
  `artifact_search`, `artifact_get`, `zhihu_search`, `zhihu_global_search`,
  `zhihu_hot_list`.
- Plugin directories intentionally not active: `imagebot-chat-toolbox`
  (backlog prototype) and `imagebot-shared` (helper modules).

Operator-only tools are marked with `*` below.

## Tool Groups

### Core Chat And Routing

- `message`: final Telegram reply/send surface.
- `image`: image understanding when the current model needs a separate vision route.
- `image_generate`: primary image generation/editing.
- `interaction_pipeline`: deterministic trigger/window/interaction helpers.
- `mars_forward_lookup`: channel-forward duplicate lookup.
- `group_adventure`: lightweight group adventure state.

### Public Search And Sources

- `zhihu`: Zhihu Open Platform search/content lookup.
- `zhihu_search`, `zhihu_global_search`, `zhihu_hot_list`: manifest-only split
  routes behind `zhihu`.
- `explicit_web_text_search`: bounded explicit general web text fallback.
- `web_image_search`: public image search.
- `danbooru_resource`: Danbooru tag/rating/score/favorite-count image lookup.
- `reverse_image_search`: reverse image lookup.
- `pixiv_resource`: Pixiv/resource lookup through the dedicated connector.
- `public_video`: public video metadata/subtitle/bounded media lookup.

### Media, Files, And Transformation

- `download_image_url`: download one public image into bot media storage.
- `download_image_urls`: download multiple public images.
- `telegram_media_spoiler`: mark outbound Telegram media as spoiler.
- `video_keyframes`: extract video keyframes.
- `media_brief`: summarize local media metadata/frames.
- `audio_transcribe`: transcribe local or allowed inbound audio.
- `media_artifact`: inspect media artifacts and attach tool-result images.
- `media_artifact_recent`, `media_artifact_lineage`: manifest-only split routes
  behind `media_artifact`.
- `web_snapshot`: public or bot-owned account browser page snapshot.
- `web_card`: compact public or bot-owned account browser page card.
- `media_transform`: local bounded image/media transformations.
- `artifact`: local generated artifact lookup/read.
- `artifact_recent`, `artifact_search`, `artifact_get`: manifest-only split
  routes behind `artifact`.
- `qr_tool`: QR encode/decode utilities.
- `pdf_render`: PDF render/extract utility.
- `av_media`: audio/video utility operations.
- `text_toolkit`: deterministic text parsing/formatting helpers.
- `meme_transform`: meme-style media transforms.

### Memory, Knowledge, Persona, And Skills

- `memory_search`: local long-term memory retrieval.
- `knowledge`: search/list knowledge sources.
- `knowledge_sources`, `knowledge_search`, `knowledge_recent`: manifest-only
  split routes behind `knowledge`.
- `knowledge_ingest`*: scoped user-doc draft/commit/list/delete.
- `persona_search`: persona/lore reference lookup.
- `persona_config`*: inspect or change persona profile routing.
- `image_skill`: read image generation skills.
- `image_skill_lookup`, `image_skill_recent`: manifest-only split routes behind
  `image_skill`.
- `image_skill_save_reference`*: save image reference notes.
- `image_skill_note_preference`*: save image preference notes.
- `learned_skill`*: save/read lightweight procedural skill notes.
- `failure_memory`*: save/read tool failure lessons.
- `tool_manual_search`: on-demand tool manual lookup.

### Operations, Observability, And State

- `background_job`: observe/cancel background jobs.
- `turn_observer_recent`*: sanitized recent turn/tool trace.
- `generated_gallery`: scoped generated/downloaded image gallery search/stats.
- `generated_gallery_recent`, `generated_gallery_search`,
  `generated_gallery_stats`: manifest-only split routes behind
  `generated_gallery`.
- `generated_gallery_resend`*: resend one gallery item.
- `desktop_media_control`*: named Windows media-session actions only.
- `sticker_pack`: Telegram sticker workbench.
- `agent_mode`*: task mode/profile controls.
- `evidence_pack`*: local evidence notebook packs.
- `github_lookup`: public GitHub repository lookup.
- `data_tool`: small safe data utilities.
- `script_action`*: registered local script actions, no arbitrary shell.
- `prompt_library`*: prompt card search/compose/update.
- `image_feedback`*: image generation feedback notes.
- `model_config`*: model/session config controls.
- `command_catalog`*: deterministic command/status catalog.
- `feature_catalog`: list feature manifests.
- `feature_action`: run manifest-backed feature actions.
- `gacha_archive`*: gacha channel archive action.
- `web_watch_add`*: add public URL watch.
- `web_watch_list`: list public URL watches.
- `web_watch_check`*: check/update public URL watch.
- `web_watch_delete`*: delete public URL watch.

## Plugin Inventory

| Plugin | Exposed tools | Role | Direct dependencies |
| --- | --- | --- | --- |
| `web-image-search` | `explicit_web_text_search`, `web_image_search`, `danbooru_resource`, `download_image_url`, `download_image_urls`, `telegram_media_spoiler`, `reverse_image_search` | Public web/image collection and download. | `imagebot-background-jobs`, `imagebot-shared/browser-context-pool`, `imagebot-shared/public-network-guard` |
| `imagebot-browser-guard` | none | Browser lifecycle/risk guard. | `imagebot-shared/openclaw-lifecycle-hooks`, `imagebot-shared/public-network-guard` |
| `imagebot-video-utils` | `video_keyframes`, `media_brief` | Video/keyframe utilities. | `imagebot-background-jobs` |
| `imagebot-audio-transcribe` | `audio_transcribe` | Audio transcription. | `imagebot-background-jobs` |
| `imagebot-public-video` | `public_video` | Public video metadata/subtitle/media lookup. | `imagebot-background-jobs`, `imagebot-shared/public-network-guard` |
| `imagebot-image-skills` | `image_skill`, `image_skill_lookup`, `image_skill_recent`, `image_skill_save_reference`*, `image_skill_note_preference`* | Image skill and preference notes. | none |
| `imagebot-meme-tools` | `meme_transform` | Meme media transforms. | `imagebot-background-jobs` |
| `imagebot-memory-search` | `memory_search` | Long-term memory retrieval and prompt hook. | `imagebot-shared/openclaw-lifecycle-hooks` |
| `imagebot-knowledge-library` | `knowledge`, `knowledge_sources`, `knowledge_search`, `knowledge_recent`, `knowledge_ingest`* | Repo/user-doc knowledge library. | `imagebot-shared/mutation-authorization`, `imagebot-shared/state-file` |
| `imagebot-persona-search` | `persona_search` | Persona/lore search. | none |
| `imagebot-tool-manual-search` | `tool_manual_search` | Progressive-disclosure manual lookup. | none |
| `imagebot-background-jobs` | `background_job` | Shared background-job infrastructure. | `imagebot-shared/mutation-authorization`, `imagebot-shared/openclaw-lifecycle-hooks` |
| `imagebot-turn-observer` | `turn_observer_recent`* | Sanitized turn/tool observability. | `imagebot-shared/openclaw-lifecycle-hooks` |
| `imagebot-generated-gallery` | `generated_gallery`, `generated_gallery_recent`, `generated_gallery_search`, `generated_gallery_stats`, `generated_gallery_resend`* | Scoped generated/downloaded image gallery. | `imagebot-shared/mutation-authorization`, `imagebot-shared/state-file` |
| `imagebot-group-adventure` | `group_adventure` | Lightweight group game state. | none |
| `imagebot-media-artifacts` | `media_artifact`, `media_artifact_recent`, `media_artifact_lineage` | Media lineage and tool-result image context. | `imagebot-shared/media-uri`, `imagebot-shared/openclaw-lifecycle-hooks`, `imagebot-shared/vision-context-gate` |
| `imagebot-practical-tools` | `web_snapshot`, `web_card`, `media_transform`, `artifact`, `artifact_recent`, `artifact_search`, `artifact_get`, `qr_tool`, `pdf_render`, `av_media`, `text_toolkit`, `web_watch_add`*, `web_watch_list`, `web_watch_check`*, `web_watch_delete`* | Practical browser/media/document utilities. | `imagebot-background-jobs`, `imagebot-shared/browser-context-pool`, `imagebot-shared/mutation-authorization`, `imagebot-shared/public-network-guard`, `imagebot-shared/state-file` |
| `imagebot-desktop-control` | `desktop_media_control`* | Named desktop media-session controls. | none |
| `imagebot-sticker-pack` | `sticker_pack` | Sticker preparation, review, publish, registry, and safe mutation. | `imagebot-shared/media-uri`, `imagebot-shared/mutation-authorization`, `imagebot-shared/openclaw-lifecycle-hooks`, `imagebot-shared/state-file` |
| `imagebot-interaction-core` | `interaction_pipeline`, `mars_forward_lookup` | Trigger/window/Mars-forward interaction support. | `imagebot-shared/interaction-session-registry`, `imagebot-shared/openclaw-lifecycle-hooks` |
| `imagebot-agent-ops` | `agent_mode`*, `persona_config`*, `learned_skill`*, `failure_memory`*, `evidence_pack`*, `github_lookup`, `data_tool` | Agent modes, persona config, local notes, evidence, public GitHub/data helpers. | `imagebot-shared/openclaw-lifecycle-hooks` |
| `imagebot-creative-ops` | `script_action`*, `prompt_library`*, `image_feedback`*, `model_config`*, `command_catalog`* | Registered scripts, prompt cards, feedback, model/session controls. | `imagebot-background-jobs`, `imagebot-shared/mutation-authorization`, `imagebot-shared/openclaw-lifecycle-hooks`, `imagebot-shared/state-file` |
| `imagebot-pixiv-resource` | `pixiv_resource` | Pixiv/resource connector. | none |
| `imagebot-feature-core` | `feature_catalog`, `feature_action`, `gacha_archive`* | Manifest feature runner and gacha archive. | `imagebot-background-jobs`, `imagebot-shared/state-file` |
| `zhihu-openapi` | `zhihu`, `zhihu_search`, `zhihu_global_search`, `zhihu_hot_list` | Zhihu Open Platform lookup. | none |

## Dependency Rules

1. Business plugins must not import each other directly.
2. Shared helper imports are allowed only through `imagebot-shared/*`.
3. Long-running work may depend on `imagebot-background-jobs`; that plugin is
   infrastructure, not product behavior.
4. Optional Node module resolution through `dependencyDirs` is allowed only for
   runtime packages such as `sharp`, `playwright-core`, and ffmpeg helpers. It
   must not call another plugin's tool implementation directly.
5. Tool composition should happen through model-visible tools, background-job
   records, manifests, or shared helper APIs, not by reaching into another
   plugin's private functions.
6. If a helper becomes useful to more than one plugin, move the helper into
   `imagebot-shared` and test it there.
7. If two tools always need to be called together, either document the workflow
   in a manual or create a small orchestration feature. Do not make one tool
   secretly depend on the other's private state.

## Current Warnings

- `web_text_search` exists in the `web-image-search` manifest but is not exposed;
  `explicit_web_text_search` is the deliberate bounded fallback.
- `bot_board` exists in `imagebot-agent-ops` but is not exposed while the board
  workflow remains a backlog/prototype surface.
- `imagebot-chat-toolbox` remains a backlog prototype and is intentionally not
  listed in `settings.localPluginDirs`.
- `imagebot-shared` is intentionally not a local plugin; it is the shared helper
  library.

## Maintenance Checklist

When adding or changing a tool:

1. Choose one owner plugin.
2. Add or update the plugin manifest.
3. Add or update the tool manual frontmatter.
4. Classify the tool as ordinary chat or operator-only in
   `config/imagebot/settings.json`.
5. Keep direct imports limited to `imagebot-shared` and, for long jobs,
   `imagebot-background-jobs`.
6. Add focused tests for permission, scope, and failure behavior.
7. Run `npm run health:features` and `node scripts/TEST_PLUGIN_DEPENDENCY_BOUNDARIES.mjs`.
