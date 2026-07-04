# GitHub Bot Feature Candidates - 2026-06-29

Status meanings:

- `implemented`: already present locally, or implemented in this pass.
- `implemented_partial`: safe subset implemented; broader version needs a
  separate boundary decision.
- `candidate_next`: fits the project boundary but still needs feature/tool work.
- `conflict`: do not implement without a separate explicit product decision.

## Sources

- GitHub bot topic, sorted by stars: https://github.com/topics/bot?o=desc&s=stars
- GitHub telegram-bot topic, sorted by stars: https://github.com/topics/telegram-bot?o=desc&s=stars
- GitHub discord-bot topic, sorted by stars: https://github.com/topics/discord-bot?o=desc&s=stars
- Kirara AI README: https://github.com/lss233/kirara-ai
- Hubot README: https://github.com/hubotio/hubot
- Rasa README: https://github.com/RasaHQ/rasa
- Leon README: https://github.com/leon-ai/leon

## Candidate Table

| # | Source rank/context | Feature | Status | Local implementation / conflict record |
| ---: | --- | --- | --- | --- |
| 1 | ccxt, top `bot` topic | Read-only exchange market data abstraction | conflict | Financial data can be high-stakes and temporally unstable; keep any future version read-only, citation-backed, and separate from trading automation. |
| 2 | ccxt / hummingbot | Trading strategy execution / market making | conflict | Automated trading is outside this bot boundary. Do not implement order placement, portfolio control, or strategy execution. |
| 3 | Jobs_Applier_AI_Agent_AIHawk | Automated job application | conflict | Account automation and real-world submissions need user-controlled browser/session workflow, not group-chat bot autonomy. |
| 4 | python-telegram-bot / telegraf / aiogram / Telegram.Bot | Telegram framework wrapper patterns | implemented | Local equivalent is the OpenClaw gateway/channel layer plus `interaction_pipeline`; no need to import a second Telegram framework. |
| 5 | discord.js / discord.py / Discord4J | Discord channel adapter | implemented_partial | Runtime connector is not implemented, but `docs/CHANNEL_ADAPTER_CONTRACT.md` now defines the identity, trigger, media, delivery, and test boundary required before adding Discord. |
| 6 | wechaty / nonebot2 / Botkit / Kirara | Multi-platform adapter abstraction | implemented_partial | `docs/CHANNEL_ADAPTER_CONTRACT.md` provides the channel-neutral envelope and adapter test contract for future WeChat/QQ/Discord/Slack/IRC work. |
| 7 | whatsapp-web.js | WhatsApp Web connector | conflict | Browser-account automation and ToS/account-risk issues; do not add without explicit user-owned browser risk policy. |
| 8 | Rasa | NLU / dialogue management layer | implemented_partial | `bot_board flow_match` stores intent labels and sample utterances for dry-run routing. It does not replace model reasoning with a full NLU stack. |
| 9 | Rasa | Business flow definitions | implemented | `bot_board flow_create/flow_get/flow_list` stores scoped business/dialogue flows with required slots and compact steps. |
| 10 | Rasa | Built-in copilot for generating/debugging flows | implemented_partial | `bot_board flow_validate` reports missing title/steps and routing warnings for draft or stored flows. It is a dry-run validator, not an autonomous flow generator. |
| 11 | Rasa | Export agent to production platform | conflict | Enterprise deployment/export is outside local-first bot scope. Keep public export script instead. |
| 12 | Kirara AI | Multi-LLM provider/model management | implemented | `model_config`, `/ammodel`, and model profile files already cover this at runtime. |
| 13 | Kirara AI | WebUI model management | implemented_partial | `docs/OPERATIONS_CONTROL_SURFACE_PROFILE.md` defines the authenticated local control-surface boundary for viewing model profiles and requesting model-switch plans. |
| 14 | Kirara AI | Plugin marketplace / registry | implemented_partial | `docs/PLUGIN_TRUST_POLICY.md` defines registry metadata, source pinning, risk labels, and explicit operator approval before marketplace-style plugin enablement. |
| 15 | Kirara AI | Image sending | implemented | `message send`, media delivery, gallery resend, and generated media paths cover this. |
| 16 | Kirara AI | Keyword-triggered replies | implemented | `bot_board rule_add/rule_match` stores scoped keyword rules and returns suggested replies only. It does not auto-send or bypass the normal trigger gate. |
| 17 | Kirara AI | Multi-account support | implemented_partial | `docs/ACCOUNT_ROUTING_PROFILE.md` defines dry-run account/channel routing diagnostics, explicit account bindings, and token-redacted health checks. Runtime account switching is not enabled. |
| 18 | Kirara AI | Persona presets | implemented | `persona_config`, persona overlays, and shared memory boundary already cover this. |
| 19 | Kirara AI | HTTP chat API endpoint | implemented_partial | `docs/OPERATIONS_CONTROL_SURFACE_PROFILE.md` defines the local/authenticated, transcript-safe HTTP chat endpoint boundary and replay requirements. No public endpoint is enabled. |
| 20 | Kirara AI | Conditional trigger rules | implemented_partial | `bot_board rule_add/rule_match` supports dry-run conditions for group/user/media/local-hour windows. It still returns suggestions only. |
| 21 | Kirara AI | Administrator commands | conflict | Telegram admin-like actions need group consent, admin detection, audit logs, and owner separation. |
| 22 | Kirara AI | Drawing model support | implemented | `image_generate`, prompt library, image skills, and image feedback cover this. |
| 23 | Kirara AI / Leon | Voice replies / TTS | implemented_partial | `docs/AUDIO_AND_STREAMING_OUTPUT_PROFILE.md` defines explicit opt-in TTS, voice allowlists, caching, duration caps, and fallback text delivery. Runtime TTS is not enabled. |
| 24 | Kirara AI | Multi-turn conversation | implemented | `interaction_pipeline`, OpenClaw sessions/windows, and `memory_search` support multi-turn context. |
| 25 | Kirara AI | Cross-platform message sending | implemented_partial | `docs/CHANNEL_ADAPTER_CONTRACT.md` now requires explicit delivery targets, audit records, consent boundaries, and tests before any cross-platform forwarding. |
| 26 | Kirara AI | Custom workflow system | implemented | `learned_skill save`, `script_action`, `feature_core`, and manuals cover bounded workflow notes and scripts. |
| 27 | Kirara AI | Web admin dashboard | implemented_partial | `docs/OPERATIONS_CONTROL_SURFACE_PROFILE.md` defines local/authenticated dashboard health, status, redaction, and mutation-plan boundaries. |
| 28 | Kirara AI | Built-in FRPC / NAT traversal | conflict | Exposing local services through tunnels is security-sensitive; keep deployment docs separate. |
| 29 | Kirara AI | Loadable chat presets from a library | implemented_partial | `bot_board preset_save/preset_match/preset_get` stores scoped chat presets with trigger/source metadata. Import/export can come later. |
| 30 | Leon | Offline personal assistant mode | implemented_partial | `docs/OFFLINE_MODE_PROFILE.md` defines no-network tool blocking, local tool allowlists, stale-source labeling, and model availability reporting. |
| 31 | Leon | Search/productivity/system utility skill packs | implemented | Search, practical tools, desktop control, and learned skills partly cover this; missing part is a curated pack index. |
| 32 | Leon | Coding assistant skill pack | implemented_partial | `docs/SAFE_REPO_ASSISTANT_PROFILE.md` defines the Telegram-safe repo helper subset: repo orientation, ticket creation, public GitHub metadata, and no shell/file mutation. |
| 33 | Leon | Memory-backed interactions | implemented | `memory_search`, curator, image feedback, image skills, and learned skills cover this. |
| 34 | Hubot | Adapter templates for Slack/Discord/MS Teams/IRC | implemented_partial | The channel adapter contract is now documented and verified by `scripts/TEST_CHANNEL_ADAPTER_CONTRACT.mjs`; actual adapters remain separate projects. |
| 35 | Hubot | Deterministic command bus with typed args | implemented_partial | `bot_board` adds typed action enums for rules/tickets/schedule drafts; broader user-defined command registration remains out of scope until a trust policy exists. |
| 36 | Hubot | Side-effect confirmation for commands | implemented | Mutation plans and approval codes exist for scripts/model/sticker paths; expand only per tool. |
| 37 | Hubot | User script folder for extensions | conflict | Arbitrary chat-triggered script execution is unsafe; keep registered script registry only. |
| 38 | YYeTsBot | Resource/movie index and netdisk sharing | conflict | Copyright/piracy and external share-link risk; do not implement. |
| 39 | tdl / mirror-leech / telegram_media_downloader | Large Telegram/cloud media download and re-upload | conflict | Copyright, storage, bandwidth, and private-channel risk. Keep bounded public media download tools only. |
| 40 | ChatGPT-Telegram-Workers | Serverless deployment profile | implemented_partial | `docs/SERVERLESS_DEPLOYMENT_PROFILE.md` documents the local-first decision, secret placeholders, webhook boundaries, and manual release checklist. No deploy workflow is enabled. |
| 41 | MuseBot-style AI bot | Streaming output | implemented_partial | `docs/AUDIO_AND_STREAMING_OUTPUT_PROFILE.md` defines bounded chunking/edit-rate/fallback requirements and blocks partial factual claims before tool completion. |
| 42 | MuseBot-style AI bot | MCP-to-function-call bridge | implemented | Local tool/plugin architecture already exposes tools. More MCP connectors need explicit install/trust. |
| 43 | MuseBot-style AI bot | RAG context injection | implemented | `knowledge_search`, `memory_search`, manuals, and prompt library provide scoped retrieval. |
| 44 | Modmail | Shared staff-member inbox / modmail | implemented_partial | `bot_board ticket_*` supports shared ticket records with status, priority, owner, and notes. Private staff-thread routing is not implemented. |
| 45 | Hubot example | Ticket creation with priority and side effects | implemented | `bot_board ticket_create/ticket_update/ticket_list/ticket_get` provides priority/status/owner notes. Side effects are intentionally omitted. |
| 46 | Red-DiscordBot | Trivia / quiz game | implemented_partial | `docs/TRIVIA_FEATURE_PROFILE.md` defines the future `feature_core` manifest shape, deterministic scoring, cooldown, leaderboard, and anti-copyright-dump boundaries. Runtime game handler is not enabled. |
| 47 | Red-DiscordBot | Moderation / automod | conflict | Same admin-action boundary as #21; observation-only anti-spam metrics could be separate. |
| 48 | MusicBot / Discord-MusicBot / evobot | Music playback, queue, playlists, volume, dashboard | conflict | Requires voice-session infra and copyright-aware playback; outside Telegram imagebot. |
| 49 | discord-mass-DM-GO | Mass DM / campaign automation | conflict | Directly conflicts with anti-spam and account-safety boundaries. Do not implement. |
| 50 | EverydayWechat | Scheduled custom messages | implemented_partial | `bot_board schedule_create/schedule_due` records inspect-only scheduled-message drafts. It never registers timers or sends Telegram messages. |

## First Implementation Record

- Implemented `learned_skill action=save` as a low-authority text-file skill
  writer. It creates immediately active local `SKILL.md` notes under
  `~/.openclaw/agent-ops/skill-files/<id>/`, optionally copying bot-local image
  media. This supports future feature scouting notes without letting the bot
  edit the repository or read arbitrary local files.
- Implemented `scripts/SCOUT_GITHUB_BOT_FEATURES.mjs` with fixture tests and a
  GitHub API/curl path for repeatable collection when local TLS permits.
- Registered `scout_github_bot_features` in `script_action` for future
  operator-triggered scouting runs.
- Implemented `bot_board` as a low-authority board for keyword reply rules,
  small tickets, and scheduled-message drafts. This covers #16, #45, and the
  safe inspect-only part of #50, while keeping #35 limited to typed built-in
  actions instead of arbitrary user script registration.
- Extended `bot_board` with conditional rule dry-runs, dialogue/business flow
  definitions, flow validation, flow matching, and chat preset lookup. This
  covers safe subsets of #8, #10, #20, and #29, and completes the local
  implementation record for #9.
- Added `docs/CHANNEL_ADAPTER_CONTRACT.md` plus
  `scripts/TEST_CHANNEL_ADAPTER_CONTRACT.mjs` to lock the future multi-platform
  adapter boundary before any Discord/WeChat/QQ/Slack runtime connector is
  added. This covers the safe contract layer for #5, #6, and #34.
- Added `docs/SERVERLESS_DEPLOYMENT_PROFILE.md` plus
  `scripts/TEST_SERVERLESS_DEPLOYMENT_PROFILE.mjs` to document the safe,
  manual-first serverless deployment profile for #40 without enabling Actions,
  webhook exposure, or secret-bearing deploy files.
- Added profile/verifier coverage for the remaining safe-but-not-yet-runtime
  candidates: operations control surface (#13, #19, #27), plugin trust policy
  (#14), account routing (#17), audio/streaming output (#23, #41), offline mode
  (#30), safe repo assistant (#32), and trivia feature shape (#46). The verifier
  is `scripts/TEST_BOT_FEATURE_PROFILES.mjs`.
