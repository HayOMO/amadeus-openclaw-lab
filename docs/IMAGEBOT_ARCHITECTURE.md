# Imagebot Architecture

This bot is maintained as generated configuration plus narrow runtime patches.
Do not hand-edit `~/.openclaw/openclaw.json` except for emergency diagnosis.

## Two-Layer Boundary

The repository is intentionally one project with two maintained layers:

- OpenClaw compatibility: runtime patches, manifests, patch contracts, patch
  scripts, and patch tests. Use this layer only when OpenClaw lacks a stable
  public surface for the required Telegram or host behavior.
- Agent tooling: plugins, tool manuals, feature manifests, generated config,
  memory/search policies, replay tests, and local control surfaces. New product
  behavior belongs here by default.

Do not let a feature sprawl through both layers casually. If a runtime patch is
needed, keep the product decision in the agent-tooling layer and keep the patch
focused on the missing host bridge.

## Source Layers

- `config/imagebot/settings.json`: group ids, tool allowlist, plugin list, model
  defaults, prompt lint rules.
- `config/imagebot/agents.catalog.json`: source-of-truth draft for persona
  agents, shared libraries, shared memory scope, model profile defaults, and
  future sub-agent allowlists.
- `config/imagebot/prompt/*.md`: global Telegram prompt segments.
- `persona/active_system.md`: base Amaduse persona card selected by default.
- `persona/persona_overlays.json`: runtime persona profile catalog available
  through `persona_config`; Telegram button switches open a fresh imagebot
  window with the selected profile and update the sender's default for later
  new windows, but do not create isolated agents or memories.
- `tool_manuals/*.md`: tool-specific manuals retrieved on demand by
  `tool_manual_search`.
- `features/*.json`: manifest-driven mixed LLM/script features.
- `patches/openclaw-2026.6.10-runtime/manifest.json`: runtime patch inventory.
- `docs/ATTRIBUTION_AND_REFERENCES.md`: reference and feature-claim matrix for
  borrowed mature patterns and public-facing highlights.

## Generated Outputs

Run:

```powershell
npm run build:config
```

This writes:

- `scripts/generated/imagebot-config.batch.json`
- `scripts/generated/imagebot-prompts.batch.json`
- `scripts/APPLY_CHAT_BALANCE_MODE.batch.generated.json` for backward
  compatibility with older notes.

Apply to OpenClaw:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\APPLY_CHAT_BALANCE_MODE.ps1
```

## Maintenance Rules

- Prompt files describe identity, group context, and high-level tool availability.
  They must not contain content-policy or refusal heuristics.
- Tool manuals describe tool contracts. They do not decide whether a request is
  allowed.
- Plugins own deterministic behavior and local state.
- Runtime patches only bridge OpenClaw/Telegram behavior that the public config
  surface cannot express.
- Runtime storage locations and backup boundaries are tracked in
  `docs/IMAGEBOT_DATA_STORAGE.md`. Persistent state may be large; cache and
  temporary workspace cleanup stays separate from archive retention.
- The Mars-forward detector is a runtime bridge: it records Telegram channel
  forward fingerprints before the unaddressed group-message drop gate. Its first
  layer records exact source, canonical URL, Telegram `file_unique_id`, and
  local visual-hash fingerprints, then only wakes the model for duplicate
  channel-forward candidates with first-seen same-group evidence. For media
  forwards it caches a bounded local copy of the forwarded media, precomputes
  conservative aHash/dHash/pHash visual evidence when possible, and treats
  near visual-hash hits as LLM review candidates rather than script-final
  duplicates. If a cached body is missing later, the index can still degrade to
  a suspected match. Non-channel forwards are not trigger candidates; the
  original channel is used as a fingerprint, not as the user-facing lookup target. Its source config is
  `plugins.entries.imagebot-interaction-core.config.marsForwardDetector`; its
  default state file is `~/.openclaw/imagebot/mars-forward-detector.json`.
- The vision-context gate is the single local admission layer for images before
  they enter model visual context. Telegram inbound media and tool-result image
  previews both route through `plugins/imagebot-shared/vision-context-gate.mjs`.
  Its current safety gate uses local metadata/text plus a WD tagger ONNX model
  and withholds images that match loli text/tag signals. The bot still receives
  a safety-review text note; ordinary adult NSFW without a loli signal is not
  blocked by this gate.
- Agent-surface changes should start from
  `docs/AGENT_ARCHITECTURE_ALIGNMENT.md` so mature patterns stay aligned across
  prompt, tools, manuals, memory, observability, and side-effect gates.
- New features should start from `docs/EXTENSION_PLAYBOOK.md` so the owner
  surface is explicit before code is added.
- Borrowed project patterns should be recorded in
  `docs/ATTRIBUTION_AND_REFERENCES.md` before they become public-facing claims.
- Multi-persona work should start from
  `docs/AGENT_PERSONA_MODEL_FOUNDATION.md`; do not encode persona routing only
  in prompt prose.

## Tests

Run the main local suite:

```powershell
npm run test:core
```

Run patch verification against the installed OpenClaw runtime:

```powershell
npm run test:patches
```

`scripts/TEST_IMAGEBOT_CONFIG_SOURCE.mjs` lints the prompt source and prevents
known prompt pollution such as stale spoiler/refusal wording from re-entering
the generated Telegram system prompt.
