# GitHub Bot Idea Study

Checked on 2026-06-23. This note records feature and architecture ideas learned
from mature open-source bot projects. It is intentionally about product and
system patterns, not code copying.

For the public-facing attribution matrix, star shortlist, and feature-claim
standard, see `docs/ATTRIBUTION_AND_REFERENCES.md`.

## References

- AstrBot: <https://github.com/AstrBotDevs/AstrBot>
- Koishi: <https://koishi.chat/en-US/manual/introduction>
- Red DiscordBot: <https://github.com/Cog-Creators/Red-DiscordBot>
- grammY: <https://github.com/grammyjs/grammy>
- grammY conversations: <https://grammy.dev/plugins/conversations>
- grammY ratelimiter/flood-control ecosystem:
  <https://grammy.dev/plugins/ratelimiter>
- python-telegram-bot ConversationHandler:
  <https://docs.python-telegram-bot.org/en/v22.6/telegram.ext.conversationhandler.html>
- Telegram bot features: <https://core.telegram.org/bots/features>
- Botium: <https://github.com/codeforequity-at/botium-core>
- TestMyBot: <https://github.com/pdesgarets/testmybot>
- RAGFlow: <https://github.com/infiniflow/ragflow>

## Borrowed Patterns

### 1. Plugin Health And Capability Console

Source signal:

- Koishi emphasizes an out-of-the-box console, plugin marketplace, real-time
  monitoring, and hot reload.
- AstrBot exposes WebUI, plugin extension, knowledge base, persona, sandbox, and
  desktop/launcher deployment as first-class surfaces.
- Red treats features as loadable/unloadable modules with user-facing command
  permissions.

Amadeus fit:

- Keep the current local plugin model.
- Add a machine-readable feature health view over plugin manifests, tests,
  tool manuals, allowlists, and last gateway load status.
- Surface it in the existing desktop control panel before building any plugin
  marketplace.

MVP:

- `feature_health` script or control-panel endpoint.
- Show plugin id, tools, manual file, enabled state, direct test file, and last
  gateway load presence.
- Fail CI-style checks when an exposed tool has no manual or test.

Priority: high.

### 2. Conversation State Machines For Multi-Step Tools

Source signal:

- grammY conversations model multi-step flows by waiting for specific future
  messages.
- python-telegram-bot ConversationHandler makes state, fallback, timeout, and
  per-user/per-chat/per-message scoping explicit.

Amadeus fit:

- Do not turn ordinary LLM chat into rigid forms.
- Use state machines only for deterministic multi-step workflows:
  sticker-pack creation, saving image references, knowledge ingest, and settings.
- Every conversation should define owner, chat/window scope, timeout, fallback,
  and cancellation behavior.

MVP:

- `interaction_sessions` plugin helper backed by local JSON state.
- Scope keys: chat id, thread/window id, creator user id, feature id.
- Expire stale sessions and reject foreign button/message continuations.

Priority: high.

### 3. Button And Callback Ownership Registry

Source signal:

- Telegram inline keyboards are best for settings, toggles, navigation, and
  search-result paging because callbacks avoid extra chat messages.
- Telegram explicitly recommends editing the existing keyboard/message when a
  user toggles or navigates.

Amadeus fit:

- The model-switch buttons already need creator/window checks.
- Future buttons should not invent ownership rules one by one.

MVP:

- Shared callback registry with signed or opaque callback ids.
- Store creator id, chat/window id, action, created time, expiry, and allowed
  role.
- One verifier path for model buttons, settings, gallery paging, and future
  deterministic menus.

Priority: high.

### 4. Per-Chat And Per-Tool Rate Limits

Source signal:

- grammY's rate-limit and flood-control plugins treat abuse and resource
  protection as middleware, not as business logic.

Amadeus fit:

- Private use means limits can be soft and friendly.
- Expensive tools still need guardrails: image generation, video download,
  ASR, large web snapshots, and background jobs.

MVP:

- Local quota ledger per chat/user/tool.
- Return compact cooldown/status text rather than silently failing.
- Keep owner override available.

Priority: high.

### 5. Conversational Regression Tests

Source signal:

- Botium and TestMyBot frame chatbot quality as repeatable conversation tests,
  not only unit tests.

Amadeus fit:

- The repo already has `REPLAY_TELEGRAM_TURNS.mjs`.
- Expand it from routing fixtures into scenario fixtures that assert expected
  tool exposure, no duplicate replies, callback ownership, and media artifacts.

MVP:

- YAML/JSON scenario fixtures under `tests/telegram_scenarios`.
- Test runner emits a short transcript diff.
- Start with model-switch callbacks, media reply with image generation, gallery
  resend, sticker creation, and knowledge search.

Priority: high.

### 6. Source-Traceable Knowledge Replies

Source signal:

- RAGFlow makes citation-backed answers and traceable references a central
  product quality feature.

Amadeus fit:

- `knowledge_search`, `memory_search`, and `persona_search` already return
  source-bearing snippets internally.
- The user-facing bot should not expose hidden persona internals, but debugging
  and knowledge answers should stay traceable.

MVP:

- Add a compact `sources` block to tool results where safe.
- For ordinary Telegram replies, let the model cite only user-provided docs,
  public web, or explicit knowledge-library sources.
- Keep persona/memory sources hidden unless the owner asks for diagnostics.

Priority: medium-high.

### 7. Settings As A First-Class Feature

Source signal:

- Telegram recommends global `/help` and `/settings` style surfaces.
- Red and Koishi both treat runtime configuration as user-visible and editable,
  not only repository config.

Amadeus fit:

- Small trusted deployment still benefits from per-chat settings.
- Do not over-button playful LLM scripts; use buttons for deterministic toggles.

MVP:

- `/settings` or natural-language-triggered settings menu for the owner.
- Manage group allowlist display, default model profile, media spoiler default,
  gallery privacy, and expensive-tool cooldown policy.

Priority: medium.

### 8. Inline Search And Deep Links

Source signal:

- Telegram supports inline mode and deep links for smooth content reuse.

Amadeus fit:

- Generated gallery and sticker/media artifacts are already reusable.
- Inline mode can be deferred, but deep links are small and useful for private
  flows.

MVP:

- Deep-link payloads for starting a gallery resend, image-skill save flow, or
  knowledge ingest flow.
- Inline gallery search only after callback registry and rate limits exist.

Priority: medium.

### 9. Local Plugin Development Experience

Source signal:

- Koishi highlights hot reload and unit testing as developer ergonomics.
- Red's community cogs work because plugin boundaries and loader behavior are
  normal user operations.

Amadeus fit:

- OpenClaw plugin reload still goes through gateway restart, but the repo can
  make local plugin work less brittle.

MVP:

- `npm run plugin:check <plugin-id>` wrapper.
- Validate manifest, manual, allowlist, direct test, and importability.
- Optional control-panel button for "run plugin check" later.

Priority: medium.

### 10. Lightweight Social/Play Patterns

Source signal:

- Red's default module set includes trivia, credits/bank, stream alerts, custom
  commands, and search utilities.
- Telegram bot features include stickers, games, dice, and Mini Apps, but the
  current project should stay lightweight.

Amadeus fit:

- Avoid spending too much time on a single game.
- Prefer reusable micro-patterns:
  daily prompt, daily lab omen, group poll/arena, gallery duel, trivia from a
  local note file, and small reputation/counter state.

MVP:

- Extend `imagebot-feature-core` with reusable scoring/counter/session helpers.
- Implement one generic `arena` primitive later, not one-off games.

Priority: medium-low.

## Things Not To Copy Yet

- Account/userbot automation that depends on unofficial personal-account
  sessions. It has high ban/security risk and does not fit the current trusted
  Telegram bot surface.
- A full public plugin marketplace. A local plugin health catalog is enough.
- Multi-platform adapters. Telegram is the current product surface.
- Payment, subscription, and monetization flows.
- Heavy Telegram Mini App work. The existing desktop control panel is the
  better control surface for now.

## Suggested Order

1. Shared callback/session ownership registry.
2. Plugin health/capability console.
3. Conversational regression fixture runner.
4. Per-chat/per-tool quota ledger.
5. Source-traceable knowledge replies.
6. Owner settings surface.
7. Deep links and optional inline gallery search.
8. Generic lightweight social feature primitives.

## Implementation Notes

Started in the foundation-hardening branch:

- `plugins/imagebot-shared/interaction-session-registry.js` provides a pure
  callback/session ownership helper for future deterministic menus and
  multi-step flows. It is not wired into the `/ammodel` runtime patch yet because
  that hot path is already covered by the OpenClaw patch and regression tests.
- `scripts/CHECK_IMAGEBOT_FEATURE_HEALTH.mjs` and `npm run health:features`
  validate local plugin manifests, exposed tool manuals, and test/replay
  references.
- The local control panel exposes the same feature-health result through
  `/api/feature-health` and a Feature Health panel.
- `tests/telegram-scenarios/*.json` plus
  `scripts/REPLAY_TELEGRAM_SCENARIOS.mjs` add multi-step Telegram scenario
  replay fixtures alongside the existing single-turn replay fixtures.
- `knowledge_search` now returns a compact safe `details.sources` block in
  addition to detailed result snippets.

Still pending:

- wiring the shared callback/session registry into future settings, gallery,
  sticker-pack, and ingest menus;
- real per-chat/per-tool quota enforcement for expensive tools;
- owner settings surface and deep-link/inline flows.
