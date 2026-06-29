# Extension Playbook

Use this when adding new Amaduse features. The goal is to keep the bot fun and
capable without turning every request into a one-off patch.

Before changing prompt, tool, manual, memory, or workflow boundaries, read
`docs/AGENT_ARCHITECTURE_ALIGNMENT.md`. The short rule is: do not hide capability
to cover for a model mistake; make the tool contract, manual, code gate, and test
surface honest.

Also decide the layer first:

- OpenClaw compatibility belongs in `patches/`, `policy/runtime_patch_contract.json`,
  and patch tests.
- Agent tooling belongs in `plugins/`, `tool_manuals/`, `features/`,
  generated config, policies, and replay tests.

Most new features are agent tooling. A runtime patch is a last bridge, not the
place to hide product logic.

## Choose The Smallest Correct Surface

1. **Prompt/persona preference**
   - Use when the change is only about tone, default behavior, or role fidelity.
   - Edit `persona/active_system.md` or `config/imagebot/prompt/*.md`.
   - Do not hide tool contracts or deterministic behavior in persona text.

2. **Tool manual update**
   - Use when the tool already exists but the model lacks a clear contract.
   - Edit `tool_manuals/*.md`.
   - Manuals should say what the tool does, accepted inputs, returned shape, and
     notable limitations.
   - Keep manuals as usage contracts, not product decisions that force the model
     down one workflow.

3. **Script/control command**
   - Use for deterministic local actions such as status, restart, backup,
     model profile selection, or command catalog lookup.
   - Add or update `scripts/IMAGEBOT_COMMANDS.json`.
   - Route through `plugins/imagebot-creative-ops`.
   - Keep Telegram-visible commands small and under `/am*`.

4. **Manifest feature**
   - Use for playful or stateful group features where deterministic state and a
     model reaction both matter.
   - Add a manifest in `features/*.json`.
   - Implement generic support in `plugins/imagebot-feature-core` only when the
     manifest format cannot express the behavior cleanly.

5. **Model-selected plugin tool**
   - Use for capabilities the model should call from natural language: search,
     media handling, archive lookup, screenshots, RAG, prompt cards, and similar.
   - Add or update a plugin under `plugins/`.
   - Add a tool manual, config allowlist entry, and focused tests.
   - For desktop/app control, expose named adapter actions only. Do not expose
     raw shell, click, type, hotkey, coordinate, or unconstrained UIA primitives
     to the model.

6. **Background job**
   - Use for long-running work that should not block a Telegram turn.
   - Register through `plugins/imagebot-background-jobs`.
   - Keep job state observable and bounded; avoid arbitrary shell execution.

7. **Runtime patch**
   - Use only when OpenClaw has no stable config/plugin surface for the required
     Telegram behavior.
   - Update `patches/openclaw-2026.6.10-runtime/manifest.json`.
   - Add or update a regression test that protects the behavior.
   - Update `policy/runtime_patch_contract.json` with the bridged host surface,
     checked alternatives, and retirement condition.

## Add A Feature Checklist

1. Read the relevant current files instead of working from memory.
2. Pick one owner surface from the list above.
3. Keep model-facing text short: identity, available tools, and useful defaults.
4. Put deterministic behavior in scripts/plugins, not in prompt wording.
5. Add a focused test next to the existing test style.
6. For model-selected plugin tools, run `npm run health:features` so manifest,
   manual, allowlist, and test coverage stay aligned.
7. For multi-step Telegram interactions, add a fixture under
   `tests/telegram-scenarios`.
8. Run the smallest useful test first, then `npm run test:core` for broader
   changes.
9. Rebuild config when prompt, tool, feature, command, or plugin registration
   changes.
10. Do not commit secrets, Telegram memory, raw logs, generated media, or local
    browser/session state.
11. If a mature project, paper, SDK, or official doc shaped the design, record
    it in `docs/ATTRIBUTION_AND_REFERENCES.md`.

## Good Next Feature Candidates

These are high-value because they reduce future debugging cost:

- Telegram turn replay fixtures for trigger and window-routing bugs.
- Sanitized per-turn observability: trigger, session, tools, media delivery,
  retries, and final status.
- Capability policy docs or JSON so tool power is visible without reading a
  long script.
- Media lineage for generated, downloaded, transformed, and resent images.
- Feature manifest validation and a simple simulator.
- A small inline/gallery layer only after the core media lineage is reliable.

## Product Rule

If the model can already decide naturally, expose a clear tool and a short
manual. Add a slash command only when the action is truly deterministic or
operational.

If a bug keeps returning, add a replay fixture or test before adding another
prompt sentence. Prompt text is seasoning, not scaffolding.
