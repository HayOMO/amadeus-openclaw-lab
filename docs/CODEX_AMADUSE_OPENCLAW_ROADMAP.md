# Codex Handoff: Amaduse / OpenClaw Product Direction

This document is written for Codex or any future coding agent that works on
this repository.

The owner is a product/vibe user, not a full-time maintainer. They want Amaduse
to feel alive, stable, useful, and fun inside a private Telegram/OpenClaw setup.
When making changes, optimize for product feel and long-term maintainability,
then explain the result in normal language.

## Project Shape

Treat this repository as a private OpenClaw layer for Amaduse:

- reproducible scripts for the Telegram/OpenClaw imagebot;
- local plugins for search, media, persona, memory, feature actions, command
  routing, diagnostics, and maintenance;
- OpenClaw runtime patches that make the desired Telegram behavior possible;
- persona and prompt materials for Amaduse/Kurisu-like behavior;
- handoff notes for keeping the bot alive across OpenClaw updates.

The point is not to make a generic public framework. The point is to make this
owner's Amaduse setup easy to evolve.

## Owner Intent

The owner wants:

1. Amaduse to stay recognizably Amaduse, not drift into generic assistant tone.
2. Telegram group behavior to feel predictable: triggered messages wake the bot,
   untriggered chatter does not pollute context, and reply windows route
   intentionally.
3. Image generation, image search, media delivery, gacha, memory, and persona
   workflows to feel smooth rather than fragile.
4. OpenClaw updates to become boring instead of archaeological.
5. Codex changes to be useful, reviewable, and explained in plain language.
6. The repo to stay reproducible without turning every idea into a new subsystem.

Guiding principle: **do not add a new entity unless it clearly earns its keep**.
Prefer improving the existing shape over inventing a new layer. Add an
abstraction only when it clearly reduces future mess.

## Files To Read First

Before significant work, read the relevant subset of these files:

- `README.md`
- `docs/REPO_MAP.md`
- `docs/EXTENSION_PLAYBOOK.md`
- `docs/IMAGEBOT_ARCHITECTURE.md`
- `IMAGEBOT_COMMANDS.md`
- `scripts/IMAGEBOT_COMMANDS.json`
- `scripts/APPLY_CHAT_BALANCE_MODE.ps1`
- `persona/active_system.md`
- `plugins/imagebot-interaction-core/index.js`
- `plugins/imagebot-feature-core/index.js`
- `.gitignore`

Do not work from stale memory when the repo can answer the question.

## Direction 1: Patch Health And OpenClaw Upgrades

Runtime patches are part of the product. They encode Telegram behavior that
OpenClaw config cannot currently express.

Useful outcomes:

- know which runtime patches exist;
- know what behavior each patch protects;
- verify whether they still apply after an OpenClaw update;
- keep tests attached to protected behavior.

Current anchors:

- `patches/openclaw-2026.6.10-runtime/manifest.json`
- `scripts/VERIFY_RUNTIME_PATCHES.ps1`
- `docs/PATCH_COMPATIBILITY.md`

## Direction 2: Telegram Turn Replay

Many important bugs are state/routing bugs. The useful unit is a Telegram turn:
message text, sender, reply metadata, media, trigger decision, and selected
window/session.

Suggested shape:

- `tests/telegram-turns/*.json`
- `scripts/REPLAY_TELEGRAM_TURNS.mjs`
- `docs/TELEGRAM_TURN_REPLAY.md`

Success means the owner can ask "will this wake the bot?" and Codex can answer
from a fixture or add one.

## Direction 3: Capability Surface

The product question is simple: which powers does Amaduse have, which are
routine, which are powerful, and which require deliberate confirmation?

Suggested shape:

- `policy/tools.json`
- `policy/media_roots.json`
- `policy/network.json`
- `policy/approval_rules.json`
- `docs/CAPABILITY_SURFACE.md`

Keep this compact. The point is visibility, not bureaucracy.

## Direction 4: Per-Turn Observability

When the bot feels wrong, giant logs are a bad user experience. A sanitized
per-turn record should answer:

- what triggered the bot;
- which window/session was used;
- which tools ran;
- what media was created or sent;
- where delivery failed or retried.

Example record:

```json
{
  "turnId": "turn_...",
  "time": "2026-06-20T00:00:00Z",
  "trigger": "reply_to_bot",
  "windowMode": "reply_window",
  "tools": ["feature_action", "download_image_url", "image", "gacha_archive"],
  "delivery": {
    "kind": "media_group",
    "retryCount": 1,
    "status": "ok"
  }
}
```

Success means diagnosis becomes "this turn chose this window and failed at
media delivery retry 2", not "look somewhere in the gateway log."

## Direction 5: Feature Core As A Small Feature Platform

`imagebot-feature-core` already supports manifest-driven stateful features such
as check-in and gacha. Keep growing this path when the feature is playful,
deterministic, stateful, and model-wrapped.

Useful future work:

- `features/schema.json`
- `scripts/VALIDATE_FEATURES.mjs`
- `scripts/SIMULATE_FEATURE.mjs`
- feature state version notes and migrations when needed

Success means a new fun feature does not become bespoke spaghetti.

## Direction 6: Prompt And Persona Editing

Amaduse's persona is product-critical. Prompt material should be easy to edit
without digging through PowerShell logic.

Keep:

- `persona/active_system.md` as the core role card;
- `config/imagebot/prompt/*.md` as the small global prompt segments;
- `persona_search` as the deeper role-fidelity reference path.

Avoid turning tool behavior or safety policy into long negative prompt text.
Tool contracts belong in manuals. Deterministic behavior belongs in plugins.

## Direction 7: Media And Image Lineage

Visual work needs traceability: references, official images, generated results,
gacha art, resized media, archive resend, and style correction.

Suggested artifact record:

```json
{
  "artifactId": "img_...",
  "kind": "generated|downloaded|telegram_inbound|transformed|gacha_archive",
  "sha256": "...",
  "originTurnId": "turn_...",
  "safeHandle": "MEDIA:...",
  "sourceUrl": "",
  "lineage": ["input", "transform", "sent"],
  "createdAt": "2026-06-20T00:00:00Z"
}
```

Success means redo, trace, resend, and explanation do not depend on memory.

## Direction 8: Staging And Upgrade Rehearsal

The real Telegram group is a product surface, not an ideal test bench. A
staging profile would make larger changes less annoying.

Possible shape:

- `profiles/prod.json`
- `profiles/staging.json`
- `profiles/local-dev.json`
- `scripts/APPLY_IMAGEBOT_PROFILE.ps1`
- `scripts/RUN_STAGING_SMOKE.ps1`

Add this only when the current test group and local tests stop being enough.

## Direction 9: Plugin Clarity

The private plugins do not need to become public packages, but their boundaries
should be easy to understand.

Prefer:

- per-plugin README files when a plugin becomes hard to hold in working memory;
- focused tests per plugin;
- compatibility notes when a plugin depends on a runtime patch or OpenClaw
  behavior;
- moving files only when it clearly reduces maintenance cost.

## Communication Style Back To The Owner

Use this shape when reporting work:

```text
What changed: one sentence.
Why it helps: one sentence.
Does it affect current bot behavior: yes/no.
How it was verified: one command or one visible result.
Suggested next step: one sentence, only when useful.
```

Keep it plain. The owner needs signal, not ceremony.

## Final Direction

The end state should feel like this:

- the owner asks for a vibe or behavior change;
- Codex finds the relevant plugin, policy, prompt, feature, or patch area;
- the change is useful and understandable;
- OpenClaw updates are less scary;
- failures are easier to diagnose;
- images and media are easier to trace;
- Amaduse remains recognizably Amaduse.

Not more commands for the sake of commands. Not abstractions for the sake of
abstractions. A freer, cleaner, more evolvable private Amaduse layer over
OpenClaw.
