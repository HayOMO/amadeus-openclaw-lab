# Agent Architecture Audit

Last updated: 2026-06-25.

This audit checks the concrete questions that define the bot's agent boundary.
The machine-checkable version is `policy/agent_architecture_contract.json`; the
test is `scripts/TEST_AGENT_ARCHITECTURE_CONTRACT.mjs`.

## Summary

| Question | Status | Evidence |
| --- | --- | --- |
| Capability surface is honest | Pass | `policy/capability_surface.json`, `docs/CAPABILITY_SURFACE.md`, `npm run health:features`, contract test |
| Tool schema is short and manuals are detailed on demand | Pass | 68 registered tools checked for short descriptions/parameter text; frontmatter manual coverage checked |
| Tool action names match real side effects | Pass for contracted high-risk tools | `policy/agent_architecture_contract.json` names side effects for sticker, script, model, browser, watch, background, and trace tools |
| Mutations have dry-run, approval, owner check, or code gate | Improved, pass for contracted high-risk tools | Sticker Telegram mutations default to `dryRun:true` except user-aligned add paths; non-delete `dryRun:false` paths require trusted user/owner alignment; `delete_sticker` requires a delete approval code or trusted runtime mutation approval; managed sticker defaults are local registry writes; script/model mutations require ctx-bound approval plans |
| Long tasks have draft/checkpoint/resume | Pass for current long-task surfaces | `sticker_pack` drafts use `draftId`; `background_job` uses `job_id`; long media/watch/script routes support background queue and status |
| Memory is separated into semantic/episodic/procedural/operational layers | Pass at architecture level | `docs/MEMORY_ARCHITECTURE.md`, `tool_manuals/memory_and_persona.md`, `memory_search` hybrid/semantic/keyword modes |
| Browser/account tools have untrusted-data boundary | Pass | `config/imagebot/prompt/90-privacy.md`, `tool_manuals/browser_sandbox.md`, `tool_manuals/account_browser_risk.md`, practical-tools SSRF/risk checks |
| Trace/eval can replay real bot behavior | Pass for current scope, needs more scenario breadth | `turn_observer_recent`, `failure_memory`, `background_job`, `tests/telegram-turns`, `tests/telegram-scenarios`, replay scripts |

## Changes From This Audit

- Added `policy/agent_architecture_contract.json` as the action-level contract.
- Added `scripts/TEST_AGENT_ARCHITECTURE_CONTRACT.mjs`.
- Added dry-run defaults and one-shot approval plans for `sticker_pack`
  deletion; legacy model-supplied `direct*Approved` flags no longer authorize
  real Telegram writes.
- Added fail-closed owner-context checks for non-dry-run sticker
  publish/copy/upload/create and add paths.
- Added managed sticker-set registry actions and `add_from_sticker` for adding
  a received/replied sticker to a named or default managed set.
- Added ctx-bound approval plans for `model_config set` and
  `model_config restart`; plain reads still work directly. `/ammodel` runtime
  buttons remain separate.
- Added default scope isolation for `background_job` list/get/cancel and scoped
  dedupe keys for open background jobs.
- Added default scope isolation for `artifact_recent`, `artifact_search`, and
  `artifact_get`; new artifact records carry normalized runtime context,
  `scopeKey`, and `actorKey`.
- Split `web_snapshot` / `web_card` browser state at runtime: public pages use
  fresh Playwright contexts, account-backed platforms use platform-specific
  persistent bot profiles, and page requests are guarded against private/local
  network targets.
- Added scoped draft/commit governance for `knowledge_ingest`; runtime
  `user_docs` search/recent now filters by current scope, and ingest list/delete
  management is scoped.
- Moved Mars channel-forward media evidence from the pre-mention hot path into a
  bounded background index queue; exact source/url/file fingerprints remain
  immediate, and same-message visual reindexing no longer short-circuits
  similar-image duplicate detection.
- Moved Mars forward detector state to SQLite with legacy JSON import/fallback,
  and updated `mars_forward_lookup` to read the same SQLite records the runtime
  writes.
- Added CI/reproducibility scaffolding: tracked root/plugin lockfiles,
  `npm ci`-based plugin setup, a CI runtime-preparation script, Windows tests,
  runtime patch verification, and Gitleaks/TruffleHog secret scanning.
- Updated `sticker_pack`, `browser_sandbox`, `agent_ops`, and `creative_ops`
  manuals to match the real tool behavior.

## Remaining Gaps

- The contract intentionally focuses on high-risk tools first. Lower-risk local
  state tools such as image feedback and prompt library are covered by schema and
  manual checks, but not yet by action-level side-effect classification.
- `generated_gallery_*` still reads archive manifest entries that may not carry
  trustworthy chat/session provenance. It needs a migration/backfill design
  before default runtime filtering can be enforced without losing old resend
  workflows.
- Several state families still use read-modify-write JSON. Mars is no longer in
  that bucket, but approvals, cooldown-style feature state, sticker registries,
  and some watch/runtime state still need transactional storage or locks.
- Replay fixtures exist for trigger/window/media behavior, but sticker and
  account-browser workflows still need multi-turn scenario fixtures.
- Memory has the right taxonomy and recall gate, but conflict/freshness handling
  is still mostly curator prompt and convention rather than a strong data model.
- General desktop automation remains deliberately out of scope. New desktop
  adapters must get named actions, target checks, post-checks, and tests before
  exposure.

## Maintenance Rule

When adding or changing a model-visible capability, update the contract before
or alongside the implementation. If a mutation cannot be made dry-run,
approval-gated, owner-checked, or otherwise bounded in code, do not expose it as
a normal group-chat tool.
