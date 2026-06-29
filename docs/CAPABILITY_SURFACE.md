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
