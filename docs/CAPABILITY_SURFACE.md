# Imagebot Capability Surface

This repo treats prompts as behavior guidance, not as the security boundary.

The practical boundary is:

- Telegram ingress is filtered by group allowlist, Telegram privacy mode, and local trigger/routing logic.
- The LLM receives bounded tools, not arbitrary shell/file/browser authority.
- Risky side effects live in tool code: downloading, media sending, gallery archive, browser snapshots, and local notes.
- Diagnostics are read-only and sanitized.

The machine-readable snapshot lives in `policy/capability_surface.json`.
The action-level architecture contract lives in
`policy/agent_architecture_contract.json`.

## Current Allowed Shape

- Chat, persona profile selection, image understanding, image generation/editing, public web/search/snapshot, public video metadata/subtitles/bounded download, Pixiv ranking/detail/download through a dedicated gallery-dl connector, media transforms, audio transcription, Telegram sticker-set preparation/review/publish plus known-set inspect/download/copy workflows, lightweight document ingestion, local RAG, gacha archive, local group adventure game state, Windows media-session playback control, diagnostics.
- Inbound image routing is model-aware. If the current window/session is pinned
  to a native-vision model such as `openai/gpt-5.5`, images are delivered to
  that model directly and the separate `image` understanding tool is skipped.
  If the current model is text-only, such as DeepSeek V4 Flash/Pro, the runtime
  first uses the configured `agents.defaults.imageModel` route
  (`openai/gpt-5.5`) to convert images into textual context for the chat model.
- OpenAI is the active chat/image provider. DeepSeek provider registration and
  `ds-fast` / `ds-pro` model profiles are supported, but registering the key
  does not switch the default model by itself.
- `spark` is an experimental OpenAI auth-route model profile for short-term
  testing only. It is marked `toolPolicy=chat-only`: the prompt gets a compact
  policy note and `imagebot-creative-ops` blocks OpenClaw tool calls through
  `before_tool_call`, leaving only provider-native chat, vision, or hosted
  search if that route supplies them.
- The Telegram text repeater is a runtime pre-drop/pre-model script, not an LLM
  tool. It is configured through
  `imagebot-interaction-core.config.textRepeater`, watches short non-command
  group texts or Telegram stickers before unaddressed group messages are
  discarded, and repeats after two consecutive identical messages from different
  senders in the same chat/topic within a short gap. Text repeats use
  `sendMessage`; sticker repeats use Telegram
  `sendSticker` with the incoming sticker `file_id`, keyed by
  `file_unique_id` when available. Non-repeatable user messages clear the
  pending repeat state, so an old sticker/text cannot make another user's single
  message repeat later. Bot-message, explicit-mention, length, and cooldown
  guards still apply.
- Telegram native slash and native skill handlers are disabled for imagebot.
  The visible `/am*` entries are custom menu hints handled by pre-model runtime
  scripts, with mutating model/persona controls scoped to the current window
  owner.
- Outbound Telegram delivery only through the Telegram account/group allowlist.
- Browser automation uses bot-owned Playwright contexts, not the owner browser
  profile. Ordinary public page reads and browser-backed image downloads use a
  fresh context per call.
- Account-backed web reading is allowed only through platform-specific
  bot-owned Playwright profiles and the `web_snapshot` / `web_card` risk guard:
  tiered low-volume page reads, cooldown/budget limits, bounded actions,
  backoff after risk events, and stop-on-verification behavior.
- Runtime state lookups for background jobs and practical-tool artifacts default
  to the current chat/session/window scope. No-context local maintenance calls
  remain the path for legacy/global records.
- Long-term `knowledge_ingest` writes use scoped draft/commit approval plans;
  runtime `user_docs` search and recent lookups default to the current
  chat/session/window scope.
- Local file access is limited by individual tools to bot media/cache/doc roots.
- Desktop control is currently limited to `desktop_media_control`, which uses
  Windows media sessions for fixed playback actions. It does not expose shell,
  raw clicks, raw typing, hotkeys, song search, or arbitrary application
  control.

## Sender Tool Layers

`settings.allowedTools` is the total capability set for plugin loading, tests,
and manual operator work. Normal group-chat senders do not receive that whole
surface. The generated OpenClaw config writes the same `toolsBySender` policy at
the global and imagebot-agent levels:

- `*` denies `settings.toolAccess.operatorOnlyTools`.
- configured `operatorSenderIds` get those tools back through explicit
  `id:<senderId>` and `channel:telegram:<senderId>` entries.

The operator-only layer currently includes long-term shared writes, tool-memory
mutation, diagnostics/log inspection, local desktop control,
persona/model/script controls, prompt/image feedback learning, web-watch writes,
and gacha channel archival. Ordinary feature execution, public search/media
read tools, sticker workflows, Mars forward lookup, memory search, and the
`message` send tool stay available for normal chat. Sticker deletion and real
Telegram mutations still use the `sticker_pack` code-level dry-run, owner, scope,
and confirmation gates; user-aligned sticker add paths are allowed to execute
directly so common "steal/add to pack" replies do not require an extra preview
turn.

## Deferred Or Not Yet Granted

- Bulk crawling, account automation loops, CAPTCHA/security-check handling, and
  private account areas such as DMs, notifications, settings, payments, or
  recovery flows.
- Other account-backed media sources.
- Full multi-persona sub-agent delegation. Persona profile selection is
  available through `persona_config`; ordinary Telegram switches open a fresh
  imagebot window and persist the sender's new-window default, but they do not
  create isolated workspaces, memory scopes, or sub-agent sessions. The
  design source exists in
  `config/imagebot/agents.catalog.json`, but production tool policy still denies
  `sessions_spawn`, `sessions_yield`, `sessions_history`, `subagents`, and
  `agents_list` until that allowlist is generated and tested.
- Arbitrary shell, code execution, repo/file editing by the bot runtime.
- General desktop automation. App-specific desktop adapters need named actions,
  schemas, target-window checks, post-checks, and tests before exposure.

## How To Extend

For any new local-production feature:

1. Add a bounded tool or feature plugin.
2. Add explicit read/write roots in tool code.
3. Add a short tool manual.
4. Add tests for permission boundaries and failure behavior.
5. Update `policy/capability_surface.json` and this document.

If a feature needs arbitrary local access, treat it as a separate operator-approved desktop workflow, not a normal group-chat bot capability.
