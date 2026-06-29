# Agent, Persona, Model Foundation

This document is the local design contract for turning Amaduse from a single
Telegram bot into a small multi-persona agent system without splitting social
memory by persona.

## References

The implementation should stay close to these existing patterns:

- OpenClaw multi-agent routing: an agent owns workspace, `agentDir`, auth, and
  sessions.
- OpenClaw sub-agents: `sessions_spawn` is the native handoff/delegation tool.
- OpenAI Agents SDK: "agents as tools" keeps a manager agent in control, while
  handoffs transfer the active worker.
- AutoGen / Swarm: agents can delegate by emitting a handoff, with bounded
  shared context.
- CrewAI collaboration: delegation and asking another agent a question are tool
  surfaces, not special prompt magic.

The local rule is simpler than any framework: do not add an external
orchestrator until OpenClaw's native agent/session tools are insufficient.

## Core Vocabulary

- **Persona**: the character/role identity and voice layer. A persona changes
  expression, not what the bot remembers.
- **Agent**: the OpenClaw runtime unit used when a persona needs separate
  workspace, `agentDir`, auth/profile scope, or tool policy.
- **Model**: the backend used by an agent for a run. It is hardware, not
  identity.
- **Shared library**: tool manuals, prompt cards, public notes, features, and
  reusable skills.
- **Shared social memory**: user memory, group memory, curated window notes, and
  bot-visible continuity. These remain shared across personas.
- **Private runtime state**: workspace, authority, credentials/profile scope,
  and delivery permissions. These may differ by agent.

Therefore:

```text
one persona != one memory store
one model    = one swappable backend
subagent     = another runtime agent called through sessions_spawn
```

## Shared vs Private

Shared by default:

- `tool_manuals/`
- `prompt_library/`
- `features/`
- generic workflow notes
- user/group/window long-term memory under `shared:imagebot`
- tool failure memory that helps all personas avoid repeated tool mistakes
- public reference knowledge

Private by default:

- `workspace`
- `agentDir`
- session transcripts
- Telegram reply authority
- ops/script authority
- model profile preference
- persona source card

The important rule is simple: persona switching must not create a separate
memory bubble. If a future full persona agent is added, it can isolate runtime
authority while still reading and writing the shared imagebot memory layer.

The catalog source is `config/imagebot/agents.catalog.json`.

## Current Seed Layout

```text
imagebot
  Persona: neutral Telegram group speaker; no character persona in the main prompt
  Owns: final Telegram group replies, media delivery, ops commands
  Memory: shared:imagebot

persona_alt_seed
  Persona: legacy seed for future full-agent experiments, no copied memory
  Owns: future second persona experiments
  Memory: shared:imagebot
```

The production imagebot prompt stays structurally neutral, while persona profile
selection appends the resolved card. New imagebot windows default to Amaduse
unless the sender has persisted a different default. Session history is not
copied. Long-term memory is shared, not duplicated.

## Runtime Persona Profiles

`persona_config` is the current lightweight implementation for quick persona
profile changes inside imagebot. It reads `persona/persona_overlays.json`, stores
the selected profile in `~/.openclaw/agent-ops/personas.json`, and appends the
selected card during `before_prompt_build` without adding engineering labels.

For ordinary Telegram session switches, `set` opens a fresh imagebot window and
persists that sender's default for later new windows. Explicit
`windowMode: "current_session"` is still available for an in-place experimental
switch. Window locks win over sender defaults, so a user replying into another
user's older window keeps that window's persona.

This is not full persona-agent isolation. It changes the current speaking card
only; workspace, session history, Telegram authority, and tool policy remain
owned by `imagebot`, while long-term memory stays in the shared imagebot memory
layer. The `default` persona is Amaduse; `none` is the explicit no-profile
option.

Use session scope for ordinary "switch to X" chat requests. Group/global scopes
are broader defaults and should be explicit.

## Delegation Rules

When delegation is enabled later:

1. The current chat agent remains responsible for the final user-visible reply.
2. A sub-agent receives a compact task, relevant context, and optional
   attachments.
3. The sub-agent returns findings or a draft.
4. The caller decides what to send to Telegram.
5. Recursive delegation stays bounded by `maxSpawnDepth`, `maxChildrenPerAgent`,
   and `allowAgents`.

Recommended OpenClaw tools for this layer:

- `agents_list`: discover allowed persona agents.
- `sessions_spawn`: ask another persona to work.
- `sessions_yield`: wait for required child completions.
- `subagents`: inspect live delegated work.
- `sessions_history`: bounded/sanitized recall when a child result needs review.

## Model Switching

OpenClaw config writes are validated through `openclaw config set`. Config
model changes are still useful for launcher/control-panel defaults, but
already-open Telegram windows need a session-level override to switch
immediately. `/ammodel` is runtime-handled before normal model context
construction and writes two layers:

1. the current window gets `providerOverride`, `modelOverride`,
   `thinkingLevel`, and `liveModelSwitchPending`;
2. `~/.openclaw/imagebot/model-state.json` records the local default model
   profile for future imagebot windows.

New imagebot windows seed their session model from the local model-state file,
falling back to `config/imagebot/model-state.json` only as the tracked
repository seed. This preserves deliberate chat-side model choices without
letting ordinary Telegram model experiments dirty the checkout.

Model/key/provider setup can need a restart when a running process must load new
credentials or a newly installed provider plugin.

Current model profile source:

- `config/imagebot/model-state.json` (tracked seed)
- `~/.openclaw/imagebot/model-state.json` (local runtime state)
- `scripts/IMAGEBOT_MODEL_PROFILES.json`
- `scripts/SET_IMAGEBOT_MODEL_MODE.ps1`
- `model_config` tool in `imagebot-creative-ops`

Telegram `/ammodel` keeps a small runtime mirror for fast chat-side switching.
The chat UI is model-first: select a model, then select one of that model's raw
thinking levels, with a Back button to return to the model list. Keep the
runtime mirror and the profile catalog in sync when adding a model.

## DeepSeek Setup

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\SET_DEEPSEEK_API_KEY.ps1
```

The script:

1. Stores the key in `~/.openclaw/secrets/deepseek-api-key.token`.
2. Installs `@openclaw/deepseek-provider`.
3. Registers a file-backed secret provider in OpenClaw config.
4. Registers DeepSeek models and compatibility profile aliases.
5. Does not switch the default model.

After setup, the chat command can use:

```text
/ammodel
/ammodel model deepseek/deepseek-v4-flash
/ammodel model deepseek/deepseek-v4-flash think high
/ammodel model deepseek/deepseek-v4-pro think max
```

## Implementation Order

1. Keep `imagebot` stable.
2. Add DeepSeek provider and model profiles.
3. Keep persona/agent catalog and tests enforcing shared memory.
4. Only then enable `sessions_spawn` for a small allowlist.
5. Add persona cards as source-grounded profile cards, not memory stores.
6. Generate OpenClaw multi-agent config from the catalog instead of hand-editing
   `~/.openclaw/openclaw.json`.

Do not let prompts become the orchestration engine. Configuration, plugins, and
tests own the structure; prompts describe identity and preferences.
