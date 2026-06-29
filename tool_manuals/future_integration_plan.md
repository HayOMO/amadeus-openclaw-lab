---
id: future_integration_plan
tools: tool_manual_search
keywords: integration, prompt slimming, tool manual search, dynamic tools, system prompt, migration, 全局改造, 提示词瘦身, 工具说明书
when_to_read: Human-facing implementation plan for the next refactor pass.
---

# Future Integration Plan

## Current Anchor

This plan has mostly landed as the project-local progressive-disclosure layer:
short prompt index, `tool_manual_search`, and `tool_manuals/*.md`.

For current design decisions, use `docs/AGENT_ARCHITECTURE_ALIGNMENT.md` first.
This file remains historical context for why the prompt/manual split exists.

## Target Shape

Use full safe tool availability every Telegram turn, but remove detailed tool
workflows from the global system prompt.

Keep the system prompt to four small blocks:

1. persona identity and tone index
2. Telegram group identity/attribution rules
3. one-line tool catalog plus "read a manual before nontrivial tool use"
4. privacy and delivery boundary

Detailed routing lives in `tool_manuals/*.md`.

## New Plugin

Add `plugins/imagebot-tool-manual-search` with one tool:

- `tool_manual_search(query, focus?, count?)`

It reads `tool_manuals`, splits by sections, keyword-scores the front matter and
headings, and returns compact snippets. Later it can use the same semantic
embedding style as `memory_search`, but keyword search is enough for the first
pass.

Keep this tool always visible together with memory/persona. It is a manual, not a
permission system.

## Runtime

Remove the Telegram regex-based dynamic `toolsAllow` narrowing. It is too fragile:
when it guesses wrong, the model literally cannot call the needed tool.

The allowlist should remain enforced by config:

- allow chat/media/search/image tools
- deny shell, file write/edit, gateway control, cron, and unrelated
  local-control tools
- keep session/subagent delegation denied in the production tool policy until
  `config/imagebot/agents.catalog.json` is used to generate a small tested
  persona-agent allowlist

## Prompt Slimming

Move these details out of the global prompt:

- image generation routing
- public reference search workflow
- download/album rules
- video/GIF/sticker details
- browser fallback rules
- detailed memory/persona usage rules

Leave only short reminders and let the model call `tool_manual_search` when it
needs exact procedure.

## Tool Descriptions

Custom tool descriptions can be shortened after manuals exist. Built-in schemas
still need enough parameter structure for function calling, so do not remove tool
schemas themselves.

## Rollout

1. Add manuals.
2. Add `tool_manual_search` plugin.
3. Add it to allowlists.
4. Slim `APPLY_CHAT_BALANCE_MODE.ps1`.
5. Re-apply config. Restart only when provider/plugin/auth process state needs
   a process refresh.
6. Test: normal chat, image generation, image edit, sticker, video, search, Zhihu,
   download album, memory recall.
