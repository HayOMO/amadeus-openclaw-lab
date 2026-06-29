# Repository Map

This repository is the reproducible layer for the Amaduse Telegram imagebot.
Runtime state, secrets, logs, generated media, and Telegram memory are kept
outside git.

## Repository Layers

Keep this as one repository, but maintain two explicit layers:

- OpenClaw compatibility layer: `patches/openclaw-2026.6.10-runtime/`,
  `policy/runtime_patch_contract.json`, patch apply/export/verify scripts, and
  patch tests. This layer exists only for OpenClaw behavior that cannot be
  expressed through public config, plugin, manual, hook, or script surfaces.
- Agent tooling layer: `plugins/`, `tool_manuals/`, `features/`,
  `config/imagebot/`, `policy/agent_architecture_contract.json`, control-panel
  code, local memory/search policies, and replay tests. Product behavior belongs
  here by default.

If a change touches both layers, write down the owner boundary before editing
code. The durable public migration checklist lives in `docs/PUBLIC_REPO_PLAN.md`,
and external references live in `docs/ATTRIBUTION_AND_REFERENCES.md`.

## Daily Entry Points

- `README.md`: operator guide and common commands.
- `IMAGEBOT_COMMANDS.md`: Telegram slash-command policy.
- `docs/IMAGEBOT_ARCHITECTURE.md`: generated-config and source-layer layout.
- `docs/EXTENSION_PLAYBOOK.md`: how to add the next feature without creating a
  new pile of special cases.
- `docs/PATCH_COMPATIBILITY.md`: OpenClaw runtime patch maintenance.
- `docs/IMAGEBOT_DATA_STORAGE.md`: runtime data roots, backup-worthy state,
  archive locations, and cache boundaries.
- `docs/CODEX_AMADUSE_OPENCLAW_ROADMAP.md`: long-term product direction.
- `docs/GITHUB_BOT_IDEA_STUDY.md`: borrowed design patterns from mature
  GitHub bot projects.
- `docs/ATTRIBUTION_AND_REFERENCES.md`: upstream, borrowed-pattern, and feature
  claim matrix for public attribution.
- `docs/PUBLIC_REPO_PLAN.md`: one-repo public migration plan and GitHub posture.
- `docs/DECISION_LOG.md`: persistent architecture decisions that must survive
  context compression, especially search routing and performance defaults.

## Source Layout

- `config/imagebot/settings.json`: model defaults, Telegram groups, plugin
  allowlist, browser pool, concurrency, and tool configuration.
- `config/imagebot/model-state.json`: tracked model default seed for fresh
  checkouts. Runtime model choices live in `~/.openclaw/imagebot/model-state.json`.
- `config/imagebot/agents.catalog.json`: planned persona-agent catalog for
  shared libraries, shared imagebot memory, delegation allowlists, and model
  profile defaults.
- `config/imagebot/prompt/*.md`: global prompt segments assembled into the
  Telegram system prompt.
- `persona/active_system.md`: base Amaduse persona card. It is the default
  profile for new imagebot windows unless a sender default overrides it.
- `persona/*.md`: legacy Amadeus/Kurisu reference notes outside the active card.
- `persona/persona_overlays.json` and `persona/profiles/*/active_system.md`:
  lightweight persona profile cards used by `persona_config`.
- `persona/persona_overlays.json`: persona profile catalog for
  `persona_config`.
- `persona/profiles/*`: inactive or experimental persona cards. These may copy
  the main persona defaults, but must not create persona-specific memory.
- `tool_manuals/*.md`: on-demand tool manuals exposed through
  `tool_manual_search`.
- `features/*.json`: manifest-style feature definitions for script/LLM hybrid
  features.
- `plugins/*`: local OpenClaw plugins and shared helpers.
- `scripts/*`: config builders, tests, operational scripts, backups, patch
  tools, and Telegram command sync.
- `.github/workflows/ci.yml`: Windows test and secret-scan workflow for clean
  checkout verification.
- `tests/telegram-turns/*.json`: single-turn trigger/window-routing replay
  fixtures.
- `tests/telegram-scenarios/*.json`: multi-step Telegram interaction scenario
  replay fixtures.
- `patches/openclaw-2026.6.10-runtime/*`: current runtime patches plus manifest.
- `app/*` and `native/*`: local launcher/control-panel UI.

## Generated Or Local-Only State

These should remain ignored:

- `.openclaw/`, `.runtime/`, `logs/`
- `~/.openclaw/imagebot/model-state.json`
- `generated/`, `media/`, `downloads/`, `tmp/`
- `backups/imagebot-memory/`, `backups/imagebot-memory-desktop/`
- `scripts/generated/`
- token, secret, session, and local OpenClaw state files

If a future feature needs durable state, prefer OpenClaw-local state under
`~/.openclaw` or a clearly ignored local directory. Commit only the schema,
scripts, docs, and tests required to recreate the behavior.

## Current Extension Surfaces

- Script/control actions: `scripts/IMAGEBOT_COMMANDS.json` plus
  `plugins/imagebot-creative-ops`.
- Stateful playful features: `features/*.json` plus
  `plugins/imagebot-feature-core`.
- Bounded local desktop adapters: `plugins/imagebot-desktop-control` plus
  helper scripts under `scripts/`.
- Model-selected tools: a plugin under `plugins/`, a manual under
  `tool_manuals/`, a config entry in `config/imagebot/settings.json`, and tests.
- Prompt/persona changes: `persona/active_system.md`,
  `persona/persona_overlays.json`, `persona/profiles/*`, or
  `config/imagebot/prompt/*.md`.
- OpenClaw behavior gaps: runtime patches only when public config/plugin
  surfaces cannot express the needed Telegram behavior.

## Verification Shortlist

```powershell
npm ci
npm run build:config
npm run lint:config
npm run health:features
npm run test:core
npm run test:all
npm run test:patches
git status --short
```

For small documentation-only changes, `npm run lint:config` is usually enough.
For plugin, routing, media, browser, or patch work, run the full shortlist.
