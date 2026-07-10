# Amadesu Plan Execution - 2026-07-10

Source: user-supplied Amadesu plan document from 2026-07-10.

## Objective

Prefer OpenClaw-native capabilities when they satisfy the product contract;
keep custom extensions only for Amaduse-specific Telegram, media, persona, or
scope behavior. Reduce prompt scripting, preserve model agency, make failures
recoverable, expose real progress, and keep runtime configuration reproducible.

## Evidence Baseline

- OpenClaw runtime: `2026.6.10`.
- Node.js: `24.15.0`; npm: `11.12.1`.
- Initial FFmpeg package binary: 2018 development snapshot
  `N-92722-gf22fcd4483`.
- Initial FFprobe package binary: 2023 snapshot
  `2023-02-13-git-2296078397`.
- `npm run lint:config`: passed.
- `npm run health:features`: passed with expected compatibility/prototype
  warnings.
- `npm run test:core`: passed.
- Machine storage: one NTFS `C:` volume; Dev Drive support is enabled, but no
  Dev Drive currently exists.

## Upstream Alignment Decisions

1. Keep OpenClaw `tools.toolSearch` in `directory` mode. It preserves the
   authorized tool catalog while avoiding eager transmission of every schema.
2. Use OpenClaw Telegram progress drafts for stage updates. Do not add prompt
   text that asks the model to reveal or interrupt private reasoning.
3. Keep retries per request and idempotency-aware. Transport retry belongs to
   OpenClaw; product tools may retry only bounded read/idempotent operations.
4. Keep the custom scoped Telegram memory until a replacement proves equivalent
   user/group/window isolation. OpenClaw builtin memory and Honcho remain
   evaluated options, not automatic migrations.
5. Treat Honcho's asynchronous derivation and peer/session model as a useful
   reference. Do not add its service, background LLM cost, or automatic user
   modeling without a privacy, latency, and recall-quality evaluation.
6. Treat Windows Dev Drive as a performance-optimized ReFS volume, not a RAM
   disk. Do not create or format a volume automatically. Support the official
   `OPENCLAW_STATE_DIR` path so an existing Dev Drive or other chosen storage
   can be used explicitly. Codex desktop storage remains outside this project.
7. Replace the obsolete FFmpeg runtime path with a current, version-checked
   runtime while preserving a reproducible install record and media tests.

## Execution Checklist

- [x] Read and render-independent parse of the supplied plan.
- [x] Inventory repository files, plugins, tools, commands, features, tests,
  patches, prompts, memory, UI, and operational scripts.
- [x] Record the complete human-readable inventory in
  `docs/PROJECT_FUNCTION_INVENTORY_2026-07-10.md`.
- [x] Check OpenClaw official tool-search, plugin, memory, retry, progress-draft,
  and state-directory documentation.
- [x] Check Honcho's official architecture and OpenClaw integration.
- [x] Establish pre-change configuration and core-test baselines.
- [x] Finalize prompt/index/manual boundary changes and add contract checks.
- [x] Enable native Telegram progress drafts with bounded public status text.
- [x] Add retry/failure policy tests that distinguish idempotent reads from
  mutations.
- [x] Record memory backend comparison and acceptance criteria.
- [x] Upgrade and verify FFmpeg/FFprobe 8.1.2 through a pinned,
  SHA-256-checked managed runtime.
- [x] Honor `OPENCLAW_STATE_DIR` in generated config, control surfaces, shared
  media paths, active plugin fallbacks, and stateful maintenance scripts;
  record a non-destructive migration procedure without creating or formatting
  a volume.
- [x] Make Telegram `/ammodel` read the signed-in account's live Codex
  backend model cache for `openai/*`, while keeping DeepSeek as exact curated
  fallbacks, so unrelated API-provider models are never exposed automatically.
- [x] Rebuild and apply generated configuration, validate it, restart the
  watchdog-managed gateway, and run the full test/patch suite.

## Configuration Record

Every implementation change below must be represented in tracked source and a
focused test. Runtime-only actions must print their resolved path/version and
leave a local manifest outside git when appropriate.

| Area | Source of truth | Verification |
| --- | --- | --- |
| Tool discovery | `config/imagebot/settings.json` and config builder | config source test |
| Prompt boundary | `config/imagebot/prompt/*.md` | config source test |
| Progress/retry | config builder and settings | config source plus runtime schema check |
| Memory | memory architecture docs, plugin config, scoped paths | memory plugin tests |
| FFmpeg | media runtime installer/resolver and plugin package config | audio/video/practical media tests |
| State root | `OPENCLAW_STATE_DIR`, config builder, control server | config source and control tests |

## Final Verification

- Applied 121 configuration paths and 4 prompt paths with
  `scripts/APPLY_CHAT_BALANCE_MODE.ps1`.
- `openclaw config validate`: passed.
- Watchdog-managed gateway restarted and connectivity probe passed on
  `127.0.0.1:18789`.
- `/ammodel` runtime tests confirm that newly discovered OpenAI and DeepSeek
  models appear as buttons, remain selectable, and inherit provider-appropriate
  reasoning menus without replacing curated metadata.
- `npm run lint:config`: passed (`promptChars=2164`).
- `npm run health:features`: passed with the 21 catalog/compatibility warnings
  already recorded by the feature-health contract.
- `npm run verify:media`: FFmpeg and FFprobe `8.1.2` passed.
- `npm run test:all`: all 77 test programs passed.
- `npm run test:patches`: all 57 runtime patches passed with no warnings or
  failures.

## Acceptance Gate

The plan is complete for this iteration only when the generated configuration
matches the tracked sources, the focused tests pass, the complete test suite
passes, runtime patches verify against OpenClaw 2026.6.10, and the execution
checklist contains no unrecorded configuration or training command.
