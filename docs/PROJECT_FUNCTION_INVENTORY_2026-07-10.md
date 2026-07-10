# Project Function Inventory - 2026-07-10

This is the execution baseline for the Amadesu plan. It inventories the
reproducible repository surfaces before architecture changes are made.

## Inventory Summary

- [x] 25 configured local plugins.
- [x] 77 plugin-manifest tools.
- [x] 63 allowed runtime tools, including OpenClaw-owned tools such as
  `browser`, `image`, `image_generate`, and `message`.
- [x] 16 `/am*` commands: 13 runtime commands and 3 registered script routes.
- [x] 3 enabled manifest-driven playful features with 13 actions.
- [x] 57 OpenClaw 2026.6.10 compatibility patches.
- [x] Native launcher, control server, browser prewarm, backup, repair,
  diagnostics, replay, and CI/test surfaces.

`config/imagebot/settings.json`, plugin manifests, feature manifests,
`scripts/IMAGEBOT_COMMANDS.json`, and the runtime patch manifest remain the
machine-readable sources of truth. This file is the human review checklist.

## Runtime And Interaction

- [x] Telegram allowlisted group routing, mention/reply admission, per-sender
  windows, clean-window creation, idle timeout, and reply-window continuity.
- [x] Model profile selection, thinking-level selection, fallback notices, and
  runtime/default synchronization.
- [x] Persona profile selection with per-sender defaults and shared imagebot
  memory rather than persona-specific memory silos.
- [x] Queue collection/debounce, loop detection, background jobs, turn traces,
  failure/slow-call memory, and scenario replay.
- [x] Text/sticker repeaters requiring different senders.
- [x] Telegram delivery for generated/downloaded media, albums, spoilers,
  reply targets, outbound mirror records, and duplicate suppression.

## Plugin And Tool Checklist

Active means the tool is present in `allowedTools`. Operator means it is added
back only for configured operator senders. Compatibility means the manifest
keeps a legacy split tool registered while the active surface uses an aggregate.

- [x] `web-image-search`: active `explicit_web_text_search`,
  `web_image_search`, `danbooru_resource`, `download_image_url`,
  `download_image_urls`, `telegram_media_spoiler`, `reverse_image_search`;
  compatibility `web_text_search`.
- [x] `imagebot-browser-guard`: OpenClaw browser profile selection and bounded
  bot-local upload paths; no standalone model tool.
- [x] `imagebot-video-utils`: `video_keyframes`, `media_brief`.
- [x] `imagebot-audio-transcribe`: `audio_transcribe`.
- [x] `imagebot-public-video`: `public_video`.
- [x] `imagebot-image-skills`: active aggregate `image_skill`; operator
  `image_skill_save_reference`, `image_skill_note_preference`; compatibility
  `image_skill_lookup`, `image_skill_recent`.
- [x] `imagebot-meme-tools`: `meme_transform`.
- [x] `imagebot-memory-search`: scoped `memory_search` over sanitized user,
  group, and window memories.
- [x] `imagebot-knowledge-library`: active aggregate `knowledge`; operator
  `knowledge_ingest`; compatibility `knowledge_sources`, `knowledge_search`,
  `knowledge_recent`.
- [x] `imagebot-persona-search`: `persona_search` for explicit legacy-card
  lookup.
- [x] `imagebot-tool-manual-search`: `tool_manual_search` progressive
  disclosure over local manuals.
- [x] `imagebot-background-jobs`: `background_job` status/list/cancel.
- [x] `imagebot-turn-observer`: operator `turn_observer_recent`.
- [x] `imagebot-generated-gallery`: active aggregate `generated_gallery`;
  operator `generated_gallery_resend`; compatibility
  `generated_gallery_recent`, `generated_gallery_search`,
  `generated_gallery_stats`.
- [x] `imagebot-group-adventure`: `group_adventure`.
- [x] `imagebot-media-artifacts`: active aggregate `media_artifact`;
  compatibility `media_artifact_recent`, `media_artifact_lineage`.
- [x] `imagebot-practical-tools`: active `web_snapshot`, `web_card`,
  `media_transform`, aggregate `artifact`, `qr_tool`, `pdf_render`, `av_media`,
  `text_toolkit`, `web_watch_list`; operator `web_watch_add`,
  `web_watch_check`, `web_watch_delete`; compatibility `artifact_recent`,
  `artifact_search`, `artifact_get`.
- [x] `imagebot-desktop-control`: operator `desktop_media_control` with named
  media-session actions rather than arbitrary UI or shell control.
- [x] `imagebot-sticker-pack`: `sticker_pack` source inspection, local drafts,
  managed pack registry, add/copy/import/publish, owner checks, and delete
  approval.
- [x] `imagebot-interaction-core`: `interaction_pipeline`,
  `mars_forward_lookup`.
- [x] `imagebot-agent-ops`: operator `agent_mode`, `persona_config`,
  `learned_skill`, `failure_memory`, `evidence_pack`; active `github_lookup`,
  `data_tool`; compatibility `bot_board`.
- [x] `imagebot-creative-ops`: operator `script_action`, `prompt_library`,
  `image_feedback`, `model_config`, `command_catalog`.
- [x] `imagebot-pixiv-resource`: `pixiv_resource`.
- [x] `imagebot-feature-core`: `feature_catalog`, `feature_action`; operator
  `gacha_archive` repair/backfill.
- [x] `zhihu-openapi`: active aggregate `zhihu`; compatibility
  `zhihu_search`, `zhihu_global_search`, `zhihu_hot_list`.

## OpenClaw-Owned Active Tools

- [x] `image`: visual inspection and comparison.
- [x] `image_generate`: image generation and reference editing.
- [x] `browser`: full interactive browser surface.
- [x] `message`: bounded outbound send action.

## Telegram Commands

- [x] Session/control: `/amnew`, `/amhelp`, `/amstatus`, `/ammodel`,
  `/ampersona`, `/amtools`.
- [x] Model-free micro tools: `/amroll`, `/amcoin`, `/amchoose`, `/amshuffle`,
  `/amsplit`, `/amstats`, `/amlinks`.
- [x] Registered script routes: `/amdeepstatus`, `/ambackup`, `/amarchive`.

## Manifest Features

- [x] `checkin`: check in, status, and group leaderboard.
- [x] `daily_fortune`: deterministic daily draw, status, and leaderboard.
- [x] `waifu_gacha`: draw, ten-pull, daily draw, collection, profile, stats,
  and leaderboard, with Danbooru-backed media, rarity bands, pity state,
  archive delivery, and duplicate suppression.

## Storage And Memory

- [x] Scoped Telegram user/group/window Markdown memory.
- [x] Hybrid semantic/keyword retrieval in the local memory plugin.
- [x] Knowledge library for persona, prompt, manual, memory, artifact, and
  user-ingested sources.
- [x] Operational logs for failures, turns, background jobs, media artifacts,
  generated gallery records, feature state, and model/persona state.
- [x] Backup, restore, consolidation, archive, session repair, window-store
  repair, and session-image pruning scripts.

## Compatibility Patch Groups

The exact 57-entry list lives in
`patches/openclaw-2026.6.10-runtime/manifest.json`.

- [x] Telegram admission, commands, window routing, model controls, repeaters,
  and Chinese localization.
- [x] Generated/tool media recognition, spoiler propagation, album delivery,
  outbound mirroring, and reply deduplication.
- [x] Mars forwarded-media indexing, SQLite migration, lookup, and scripted
  first-reply behavior.
- [x] Tool-result image history pruning, malformed data-URL pruning, browser
  snapshot compaction, upload fallback, and browser media observations.
- [x] Provider OAuth proxy trust, model fallback propagation, durable failure
  reasons, and detached transcript ownership/retry.

## Operator And Development Surfaces

- [x] Browser-based control panel plus native Windows launcher.
- [x] Start, stop, restart, status, token repair, Telegram command sync, browser
  login verification, and memory/browser/Codex prewarm scripts.
- [x] Public export and secret-scan posture.
- [x] Focused plugin tests, contract tests, Telegram turn/scenario replays,
  runtime patch verification, and Windows CI.

## Known Boundaries

- [x] Arbitrary shell, filesystem editing, raw desktop automation, gateway
  mutation, and agent spawning are denied to the Telegram model.
- [x] `imagebot-chat-toolbox` remains a tested prototype and is not configured
  as an active runtime plugin.
- [x] Compatibility split tools remain registered for tests/migration but are
  intentionally absent from the active allowed surface.
- [ ] Multi-turn replay coverage is still thin for sticker, memory,
  browser-profile, and resumable background-job behavior.
- [ ] Some local state families still need transactional storage or locks.
- [ ] Generated-gallery legacy records need provenance backfill before strict
  scope filtering can be enabled without breaking resend workflows.
