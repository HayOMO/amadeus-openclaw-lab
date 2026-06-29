---
id: agent_ops
tools: agent_mode, persona_config, learned_skill, failure_memory, evidence_pack, github_lookup, data_tool, turn_observer_recent
keywords: task mode, mode bundle, persona switch, active persona, speaking persona, learned workflow, skill proposal, approve skill, failure memory, slow tool, stuck tool, evidence pack, source notes, GitHub repo, releases, issues, pull requests, CSV, table, histogram, group count, data utility
when_to_read: Before changing task mode, switching or inspecting speaking persona, proposing/using learned workflows, diagnosing tool failures, replaying recent bot behavior, collecting evidence, reading public GitHub metadata, or doing lightweight table/data work.
---

# Agent Ops Manual

## Task Modes

Use `agent_mode` to set a lightweight behavior mode when the user asks the bot
to focus on a style of work. Modes do not grant new permissions; they only
change priority and tone.

Modes:

- `casual`: normal short group chat.
- `media`: media reading, transformation, gallery resend, and concise delivery.
- `web`: public web evidence, webpage screenshots, and source notes.
- `research`: definitions, source checks, evidence, and careful reasoning.
- `debug`: recent failures, tool diagnostics, and small reproducible checks.
- `creative`: prompts, references, variants, and visual direction.

Prefer `scope: "session"` when runtime context is available. Use group/global
only when the user explicitly wants a broader default.

## Persona Config

Use `persona_config` when the user asks to switch, inspect, or restore the
Telegram speaking persona profile.

Useful actions:

- `list`: show available profiles and the resolved active profile.
- `set`: switch by id, label, or alias. For example `persona: "千早爱音"`.
  In Telegram session context this opens a fresh imagebot window and remembers
  the sender's default persona for later new windows. Use
  `windowMode: "current_session"` only when an in-place experimental switch is
  explicitly requested.
- `get`: inspect one profile card or the current status.
- `clear`: return the selected scope to the base Amaduse persona.

Prefer `scope: "session"` for ordinary chat requests. Use `group` or `global`
only when the user explicitly asks for a broader default.

Persona resolution order is window lock, session record, sender default for new
windows, group/global record, then Amaduse fallback. This keeps a reply into an
older window on that window's persona even if the sender changed their own
default later.

Persona profile selection affects wording only. It does not grant tools, change
owner checks, change Telegram delivery, or create private memory tracks. User,
group, and window memory remain shared.

## Learned Skills

Use `learned_skill` when a repeated workflow should become reusable local
knowledge.

Workflow:

1. `action: "propose"` creates a pending skill. It is not active.
2. `action: "approve"` activates the skill after user approval.
3. `action: "search"` retrieves approved skills when relevant.

Do not silently approve a skill just because the model proposed it. Keep
instructions concrete and short, like a tool comment rather than a prompt wall.

## Failure Memory

Use `failure_memory` when the user asks why something got stuck, why a tool
failed, why image delivery was slow, or whether a failure pattern is recurring.

Useful actions:

- `recent`: list recent failed or slow tool calls.
- `search`: find failures by tool name or error text.
- `summary`: group recent failures by tool.

This is operational memory only. Do not reveal local paths, tokens, configs, or
unrelated logs.

## Turn Observer

Use `turn_observer_recent` when the user asks what the bot actually did in recent
turns, which tool was called, whether a tool result was slow/failed, or whether a
claim has trace evidence. It reads sanitized per-turn records from
`before_prompt_build`, `before_tool_call`, `after_tool_call`, and
`before_message_write` hooks.

Useful filters:

- `toolName`: narrow to one tool such as `sticker_pack` or `web_snapshot`.
- `kind`: narrow to hook kind.
- `sessionKey` / `runId`: inspect one window/run when available.

Use this as trace evidence, not as memory content. It should help reproduce bot
behavior without exposing raw secrets, local paths, or private logs.

## Evidence Packs

Use `evidence_pack` for public research or web tasks where the bot should keep
track of sources, screenshots, artifact ids, release links, issue links, or
short notes.

Workflow:

- `create` a pack at the start of a multi-step investigation.
- `add` source notes, artifact ids, screenshots, or URLs as evidence is found.
- `get` the pack before writing a final answer with traceable evidence.

Evidence packs are not background automations. They are a local notebook for the
current task.

## GitHub Lookup

Use `github_lookup` for public GitHub repository facts:

- `repo`: repository metadata.
- `releases`: recent releases.
- `issues`: public issues.
- `pulls`: public pull requests.
- `search_repos`: repository search.

It does not use private account access and cannot read private repositories.
Use the GitHub connector only when the user explicitly needs account/repo
actions beyond public lookup.

## Data Tool

Use `data_tool` for safe small text/table work:

- `csv_summary`: summarize columns and numeric fields.
- `table_markdown`: convert CSV-like text to a Markdown table.
- `numbers_summary`: count/min/max/mean/median/stdev.
- `histogram`: text histogram for numeric values.
- `group_count`: count values in one CSV column.

It does not run code and does not read arbitrary local files.
