# Amaduse Imagebot

Local-first OpenClaw compatibility and agent-tooling setup for a Telegram
image/chat bot.

For public migration planning, see `docs\PUBLIC_REPO_PLAN.md`. The public repo
should stay as one repository with two explicit layers: OpenClaw compatibility
patches, and agent/tooling integration. References and attribution are tracked
in `docs\ATTRIBUTION_AND_REFERENCES.md`.

This repository keeps the reproducible parts of the bot:

- Telegram/OpenClaw setup scripts.
- Gateway start/stop/status wrappers.
- Local control panel frontend and native wrapper source.
- Local web text/image/reverse-image search plugin.
- Zhihu Open Platform search/hot-list plugin.
- DeepSeek provider setup script and model profile entries for optional
  text-only helper routes.
- Pixiv ranking/detail/download resource plugin backed by `gallery-dl`.
- Local small-video / Telegram animation keyframe extraction plugin.
- Lightweight image-skill cache for reusable character/style references.
- Meme/sticker transform plugin for captioned memes, reaction images, and
  sticker-style WebP outputs.
- Knowledge-library registry over persona notes, prompt library, tool manuals,
  memory, and user-ingested notes.
- Interaction-core plugin for Telegram trigger, stable identity, and window-routing diagnostics.
- Manifest-driven feature core for mixed LLM/script features such as daily check-in and playful waifu/card gacha.
- Bounded desktop media-session control for local playback apps such as NetEase Cloud Music.
- Static Amadeus/Kurisu persona notes, including the active role card in `persona\active_system.md`, plus a hidden `persona_search` tool for role-fidelity correction.
- A draft persona-agent catalog in `config\imagebot\agents.catalog.json`; see
  `docs\AGENT_PERSONA_MODEL_FOUNDATION.md`.
- Runtime patch records for the current supported OpenClaw version, `2026.6.10`.

It intentionally does not store bot tokens, OpenClaw secrets, logs, sessions, generated images, Telegram memories, or built binaries. The launcher source, icon, and build/bind scripts are project content; the local `native\bin\AmaduseImagebot.exe` and Desktop shortcut are machine-local generated outputs.

## Current Shape

- Bot username: `@YOUR_BOT_USERNAME`.
- Main group is configured locally through OpenClaw config scripts.
- Gateway listens on `127.0.0.1:18789`.
- Default chat profile: `balanced`, currently backed by `openai/gpt-5.5`.
  Model profile switches are runtime config, not persona identity.
- Image model: `openai/gpt-image-2`.
- Telegram group handling keeps `requireMention=true`; the runtime patch prevents the `plugin-owned-runtime` path from bypassing trigger filtering for `imagebot`, and drops unaddressed group messages before they enter Telegram reply-chain / conversation-context cache.
- Telegram slash commands are sourced from `scripts\IMAGEBOT_COMMANDS.json`. The OpenClaw config is generated from `config\imagebot\settings.json` plus `config\imagebot\prompt\*.md`; `scripts\APPLY_CHAT_BALANCE_MODE.ps1` is only a thin apply wrapper. OpenClaw receives only `menu=true` catalog commands for local trigger filtering, and `scripts\SYNC_IMAGEBOT_TELEGRAM_COMMANDS.ps1` publishes the same visible command set to Telegram's command menu. The runtime patch also treats those custom commands as control commands so `/amnew` can pass the local group trigger gate.
- Runtime state, memories, media workspaces, and the archived gallery live outside git. See `docs\IMAGEBOT_DATA_STORAGE.md` before backup, restore, or retention changes.
- The `/amhelp` and `/am*` command family use the `command_catalog` tool from `imagebot-creative-ops` as a product command registry. See `IMAGEBOT_COMMANDS.md`.
- Command policy is intentionally narrow: deterministic control/script actions live under `/am*`. Ordinary abilities such as image generation, PDF/video/webpage/QR/text handling, gallery lookup, memory search, and prompt cards are model-selected tools behind delivered trigger messages, bot replies, mentions, or configured prefixes, not separate Telegram commands.
- Interaction policy is centralized through `interaction_pipeline`: group messages are supposed to enter the model only through explicit commands, bot replies, mentions, or configured prefixes, and window routing uses Telegram user ids plus reply-session metadata.
- Mixed features use `feature_catalog` / `feature_action`: deterministic state and safety live in the feature tool, while the model decides when to call it and wraps the structured result. Sample features include daily check-in (`features\checkin.json`) and Safebooru/Danbooru score-band anime card gacha (`features\waifu_gacha.json`).
- Image generation concurrency is window-scoped: one in-flight generation per active Telegram window/session, with up to 6 different windows allowed to run concurrently through the agent global lane.
- Allowed tools are kept narrow: image reading/generation, Zhihu Open Platform search/hot-list, explicit broad-web text fallback, public image/Pixiv resource search, scripted reverse image search, guarded isolated-browser fallback, media transforms, audio/video helpers, bounded desktop media playback control, and lightweight playful features.

## Layer Boundary

This repository should stay one repo, but the ownership boundary must stay
visible:

- OpenClaw compatibility layer: `patches\openclaw-2026.6.10-runtime`,
  `policy\runtime_patch_contract.json`, patch scripts, and patch tests. This
  layer bridges OpenClaw runtime gaps and should shrink as upstream surfaces
  improve.
- Agent tooling layer: `plugins`, `tool_manuals`, `features`,
  `config\imagebot`, control-panel code, memory/search policies, and replay
  tests. Product behavior belongs here unless OpenClaw cannot expose the needed
  behavior through a public surface.

Before adding a feature, decide which layer owns it. If it crosses both layers,
document why in the patch contract or extension playbook instead of spreading
the behavior through prompt text, plugins, and runtime patches at once.

See `docs\IMAGEBOT_ARCHITECTURE.md` for the generated-config layout and
`docs\REPO_MAP.md` for the current repository map.

For future feature work, start with:

- `docs\REPO_MAP.md`: where things live and what must stay out of git.
- `docs\AGENT_ARCHITECTURE_ALIGNMENT.md`: mature-agent design anchor for
  prompt/tool/manual/memory/workflow changes.
- `docs\AGENT_ARCHITECTURE_AUDIT.md`: current audit matrix for capability
  honesty, mutation gates, memory/browser boundaries, and trace/eval coverage.
- `policy\agent_architecture_contract.json`: machine-checkable contract for
  capability honesty, side-effect gates, memory/browser boundaries, and
  trace/eval coverage.
- `docs\EXTENSION_PLAYBOOK.md`: how to choose between prompt, manual, command,
  feature, plugin, background job, or runtime patch work.
- `docs\FEATURE_EXPANSION_PLAN.md`: current next-feature backlog and suggested
  implementation order.
- `docs\GITHUB_BOT_IDEA_STUDY.md`: external bot-project patterns worth
  borrowing before adding the next larger feature.
- `docs\STICKER_PRODUCTION_WORKFLOW.md`: sticker workbench boundary, action
  groups, and two-layer tool-description notes.
- `docs\MEMORY_ARCHITECTURE.md`: local memory stack, recall gate, and curator
  design notes.

## Common Commands

Install local plugin dependencies after cloning or moving the project:

```powershell
npm run setup:plugins
```

Build and lint the generated OpenClaw config:

```powershell
npm run build:config
npm run lint:config
npm run health:features
```

`health:features` checks local plugin manifests, exposed tool manuals, and
test/replay references. It currently allows two expected warnings: hidden
`web_text_search` remains behind `explicit_web_text_search`, and
`plugins\imagebot-shared` is a helper directory rather than a runtime plugin.

Apply the current chat balance / memory / web reference config:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\APPLY_CHAT_BALANCE_MODE.ps1
```

The apply wrapper now:

- generates config batches from `config\imagebot\settings.json` and `config\imagebot\prompt\*.md`,
- lints the active prompt source against known stale spoiler/refusal wording before writing generated batches,
- loads the active Amadeus role card from `persona\active_system.md` into the Telegram system prompt, and enables hidden `persona_search` over the local `persona\` notes so the bot can re-anchor Amadeus/Kurisu tone when identity, role fidelity, or "out of character" corrections come up,
- enables `zhihu_search`, `zhihu_global_search`, and `zhihu_hot_list` as the default text-search layer, with broad web search hidden behind `explicit_web_text_search`,
- search policy: daily chat does not browse; public/current/source-dependent work should browse; explicit "do not search/browse" requests override browsing for that turn; browsing defaults to Zhihu OpenAPI, with `explicit_web_text_search` only for explicit broad-web requests, official/original source needs, insufficient Chinese/Zhihu coverage, or one fallback after Zhihu is empty/unavailable,
- hard-caps ordinary public search/reference turns to a single search round in the prompt,
- enables per-agent tool loop detection for repeated no-progress tool usage,
- explicitly sets `agents.defaults.maxConcurrent=6`, while each `:window:<id>` session lane remains serial,
- disables Telegram preview tool-progress chatter so failed search attempts do not spam the group.

The Telegram-visible tool status is handled by the imagebot runtime patch as a single editable status message per request. Do not re-enable generic Telegram `toolProgress` unless that patch is removed or redesigned.
- No tool status appears for pure model replies. The active prompt now explicitly forbids saying it searched/checked/read an original source unless a real search or reference tool is called in that same turn.
- adds a scripted `reverse_image_search` path for SauceNAO/IQDB lookups on Telegram-delivered images,
- adds a scripted `video_keyframes` path for Telegram-delivered small videos, video notes, and animation/GIF messages,
- uses a Telegram status message for slow media tools such as image generation; if the turn actually stalls, that status message is edited to a retry notice instead of adding another misleading reply,
- enables the browser tool only through the isolated managed `openclaw` profile,
- blocks browser attempts that request `user` / `existing-session` profiles or local-path / `file://` targets outside Telegram media roots.

Current routing note:

- OpenClaw browser itself is not pinned to a dedicated per-app proxy in this repo right now.
- Telegram still explicitly uses `http://127.0.0.1:7897`.
- Public browser/web traffic is currently expected to follow Clash/Verge rule routing on the host.

Start the gateway:

```powershell
.\START_IMAGEBOT_GATEWAY.cmd
```

Stop the gateway:

```powershell
.\STOP_IMAGEBOT_GATEWAY.cmd
```

Telegram display-name status (`Amadeus [ONLINE]` / `Amadeus [OFFLINE]`) uses Telegram Bot API `setMyName`, which is heavily rate-limited. Automatic display-name updates are currently disabled in start/stop scripts. Use `SET_IMAGEBOT_STATUS_NAME.ps1` manually only after the Telegram cooldown has had time to clear.

Model profiles:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\SET_IMAGEBOT_MODEL_MODE.ps1 -Mode balanced
powershell -ExecutionPolicy Bypass -File .\scripts\SET_IMAGEBOT_MODEL_MODE.ps1 -Mode custom -Model openai/gpt-5.5 -ReasoningEffort high -TextVerbosity low -MaxTokens 1536
```

Profiles live in `scripts\IMAGEBOT_MODEL_PROFILES.json`. The script writes
validated OpenClaw config for the launcher/control panel, including model,
reasoning effort, verbosity, and max-token defaults. Telegram `/ammodel` is a
pre-model runtime command: it directly pins the current window/session with
OpenClaw's session-level model override, so the next clean turn in that window
should use the selected model without restarting the gateway or starting a
model run just to switch.

`config\imagebot\model-state.json` is the repository default seed. Mutable
chat-side model state lives outside git at
`~\.openclaw\imagebot\model-state.json` (override with
`OPENCLAW_IMAGEBOT_MODEL_STATE_FILE` only for tests/repairs). `/ammodel` and
`SET_IMAGEBOT_MODEL_MODE.ps1` write the local state file so ordinary model
experiments do not dirty the checkout.

Telegram chat-side control uses `/ammodel`. The button flow is model first,
then that model's raw thinking levels, with a Back button:

```text
/ammodel
/ammodel models
/ammodel model openai/gpt-5.5
/ammodel model openai/gpt-5.5 think xhigh
/ammodel model deepseek/deepseek-v4-flash
/ammodel model deepseek/deepseek-v4-flash think max
/ammodel think high
```

The chat command does not rewrite global OpenClaw config. Session-level chat
switching is intentionally limited to model plus thinking level; use the
launcher or `scripts\SET_IMAGEBOT_MODEL_MODE.ps1` for global defaults such as
verbosity and max tokens.

Store a DeepSeek API key and register the DeepSeek provider:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\SET_DEEPSEEK_API_KEY.ps1
```

The key is written to `~\.openclaw\secrets\deepseek-api-key.token`, OpenClaw
receives a file-backed secret reference, and the default model is not switched.
After setup, use `/ammodel` and select DeepSeek V4 Flash/Pro, then choose
`off`, `high`, or `max`.

Check status:

```powershell
.\STATUS_IMAGEBOT_GATEWAY.cmd
```

Open the app-style control panel:

```powershell
.\IMAGEBOT_APP.cmd
```

The control panel shows gateway status, model configuration, redacted log
summary, and Feature Health contract checks from `npm run health:features`.
The launcher starts the local server with a high-entropy control token stored
under `.runtime`; browser API calls must send that token in
`X-Imagebot-Control-Token`, and POST requests are restricted to the local
origin with JSON bodies. Raw logs stay local and are opened through the log
folder action rather than returned by `/api/status`.

Build the project-local native launcher and bind the current user's Desktop shortcut to this checkout:

```powershell
npm run build:launcher
npm run bind:launcher
```

Keep launcher maintenance in this repository. The Desktop should only contain the shortcut, not a copied project directory or standalone launcher source. The native launcher owns the gateway lifecycle in normal GUI mode: opening it starts or synchronizes the local OpenClaw gateway, and closing it stops the gateway before the launcher exits. Use the start/stop scripts directly only when you intentionally want headless background operation.

Store the Zhihu Open Platform Access Secret:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\SET_ZHIHU_ACCESS_SECRET.ps1
```

The secret is written to `~\.openclaw\secrets\zhihu-access-secret.token` and is ignored by git. If the secret is missing, expired, out of quota, or the free trial is no longer available, the bot is prompted to fall back to `explicit_web_text_search` once instead of looping on Zhihu.

Install and configure Pixiv resources:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\INSTALL_PIXIV_RESOURCE_DEPS.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\SET_PIXIV_REFRESH_TOKEN.ps1
```

If a refresh token is needed, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\GET_PIXIV_REFRESH_TOKEN.ps1
```

The refresh token is written to `~\.openclaw\secrets\pixiv-refresh.token` and is ignored by git. The bot stores bounded Pixiv metadata under `~\.openclaw\resources\pixiv` and downloaded media under `~\.openclaw\media\pixiv-resource`.

Sync Telegram's visible command menu after changing `customCommands`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\SYNC_IMAGEBOT_TELEGRAM_COMMANDS.ps1
```

The sync script clears stale commands from common Telegram command scopes
before publishing the current visible menu, so deleted commands should stop
appearing when typing `/` after Telegram's client-side cache refreshes.

## Runtime Patches

OpenClaw updates can overwrite local runtime edits under `node_modules\openclaw\dist`.

Patch files live in:

```text
patches\openclaw-2026.6.10-runtime
```

Re-apply them after reinstalling/updating the same OpenClaw version:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\APPLY_RUNTIME_PATCHES.ps1
```

Check whether the installed runtime already contains the repo patch set:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\VERIFY_RUNTIME_PATCHES.ps1
```

Re-export patches from the current installed OpenClaw runtime:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\EXPORT_RUNTIME_PATCHES.ps1
```

The patch manifest is `patches\openclaw-2026.6.10-runtime\manifest.json`; see `docs\PATCH_COMPATIBILITY.md`.

## Git Safety

Before pushing, run:

```powershell
git status --short
git diff --cached --name-only
npm run test:all
npm run test:patches
```

Create a local backup commit for the reproducible repo state without pushing:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\BACKUP_IMAGEBOT_TO_GITHUB.ps1 -NoPush
```

The backup script skips push by default. Use `-Push` only after checking the
remote and staged diff; private source-tree push URLs should stay disabled
unless you intentionally re-enable them for a manual publish.

Memory contents are intentionally not synced to GitHub. The local memory export path is ignored by Git, so opening the repository later cannot accidentally publish group memory.

Export a local text memory backup to the Desktop:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\EXPORT_IMAGEBOT_MEMORY_DESKTOP_BACKUP.ps1
```

This writes `path\to\amadeus-openclaw-lab-Memory-Backup\latest` and a timestamped snapshot under `path\to\amadeus-openclaw-lab-Memory-Backup\snapshots`. It includes user, group, and window memory Markdown. It excludes raw sessions, logs, media, tokens, OpenClaw runtime state, and the regenerable semantic index.

There is also a one-click wrapper:

```text
BACKUP_IMAGEBOT_MEMORY_TO_DESKTOP.cmd
```

Restore that memory snapshot after stopping the gateway:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\RESTORE_IMAGEBOT_MEMORY_BACKUP.ps1 -Force
```

Install the daily GitHub backup task:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\INSTALL_GITHUB_BACKUP_TASK.ps1
```

Do not add files from `~\.openclaw`, logs, media, sessions, token files, generated Telegram memory, imagebot ops-memory logs, or `backups\imagebot-memory`.
