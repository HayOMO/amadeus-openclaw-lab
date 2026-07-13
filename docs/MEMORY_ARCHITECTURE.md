# Imagebot Memory Architecture

This project uses a small Telegram-bot memory stack. It borrows the useful
shape of mature agent memory systems without importing their full runtime.

Public claim standard: this is project-specific engineering over mature memory
patterns, not an original memory algorithm. The distinctive part is the local
combination of user memory, group shared memory, window notes, recall gate, and
curator workflow for a Telegram imagebot.

The current backend decision and measured comparison with OpenClaw builtin
memory and Honcho are recorded in
`docs/MEMORY_BACKEND_EVALUATION_2026-07-10.md`.

## Reference Patterns

- LangGraph / LangMem
  ([docs](https://docs.langchain.com/oss/python/concepts/memory)): split memory
  into semantic facts, episodic examples, and procedural rules.
- Letta / MemGPT ([blog](https://www.letta.com/blog/agent-memory/)): keep small
  core memory in prompt, and retrieve larger recall or archival memory with
  tools.
- GitHub Copilot Memory
  ([blog](https://github.blog/ai-and-ml/github-copilot/building-an-agentic-memory-system-for-github-copilot/)):
  share validated memories across agents instead of making each agent relearn
  the same context.
- Zep ([site](https://www.getzep.com/),
  [paper](https://arxiv.org/html/2501.13956v1)): separate raw episodes from
  extracted facts and community/group context.
- Mem0 ([site](https://mem0.ai/), [repo](https://github.com/mem0ai/mem0)):
  extract, evaluate, and manage salient memories instead of replaying all chat
  history.

## Local Layers

1. Core prompt layer
   - Tool index and manuals say when to use `memory_search`.
   - The model is expected to call memory tools for prior conversations,
     nicknames, group lore, recurring jokes, preferences, and user impressions.

2. Recall gate layer
   - `imagebot-memory-search` registers a `before_prompt_build` hook.
   - On strong recall/group-lore triggers, it appends a short instruction that
     asks the model to call `memory_search` once before answering.
   - The gate does not inject memory content. It preserves model/tool
     separation and keeps retrieval observable.

3. Curator layer
   - `scripts/CONSOLIDATE_IMAGEBOT_MEMORY.mjs` distills window/session
     transcripts into user, group, and window memory files.
   - The curator keeps raw window notes separate from stable user/group memory.
   - The curator runs with a neutral no-persona instruction and defaults to the
     `deep` profile (`openai/gpt-5.6-sol` with high reasoning) unless overridden
     for a run.
   - Semantic index prewarm supports fuzzy recall, while keyword recall remains
     available immediately.

## Shared Across Personas

Persona profile selection does not create memory stores. All current and future
persona cards read and write the same imagebot social memory layer:

- `~/.openclaw/agents/imagebot/sessions/sessions.json.telegram-imagebot-memory/users/`
- `~/.openclaw/agents/imagebot/sessions/sessions.json.telegram-imagebot-memory/group/shared.md`
- `~/.openclaw/agents/imagebot/sessions/sessions.json.telegram-imagebot-memory/windows/`

This follows the useful part of mature agent memory systems: keep long-term
memory as a durable shared substrate, and keep role/persona prompts as a
separate expression layer. If a future full persona agent gets separate runtime
authority, it should still use `shared:imagebot` memory unless there is a
specific product reason to isolate it.

## Current Memory Types

- User memory: per-Telegram-user stable preferences, aliases, impressions, and
  durable facts.
- Group memory: shared lore, recurring jokes, group-specific references, and
  common context.
- Window memory: episodic transcript notes for recent or closed windows.
- Operational memory: tool failures and approved workflow skills live in
  `agent_ops`, not in social/group memory.

## Runtime Policy

- Use memory as soft continuity, not proof.
- Do not reveal memory mechanics, hidden files, scores, or local paths.
- If memory is weak or absent, say uncertainty naturally instead of inventing.
- Prefer one `memory_search` call for ordinary turns; do deeper audits only when
  explicitly requested.

## Why Not Full Graph Memory Yet

Graph memory is useful for entity resolution and conflicting facts, but this bot
currently has only two small Telegram groups and local-first requirements. The
current stack favors debuggability, low latency, and simple files. Entity graph
or contradiction tracking can be added later if group lore grows large enough
to make keyword/semantic recall ambiguous.

The same rule applies to Honcho: adopt it when automatic peer modeling,
cross-session multi-agent awareness, or measured recall quality makes the
additional service and derivation pipeline worthwhile. Until then, the scoped
local backend preserves the stronger Telegram privacy boundary with less
latency and fewer moving parts.

See `MEMORY_BACKEND_DECISION_ZH.md` for the concise Chinese explanation and
`MEMORY_BACKEND_EVALUATION_2026-07-10.md` for measured results and migration
gates.
