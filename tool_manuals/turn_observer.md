---
id: turn_observer
tools: turn_observer_recent
keywords: turn observer, logs, debug, no response, stuck message, tool trace, 观测, 卡住, 没回复, 工具记录
when_to_read: When diagnosing missing replies, duplicate replies, media delivery confusion, or tool-call timing/order problems.
---

# Turn Observer

## Purpose

`turn_observer_recent` reads sanitized recent records for imagebot turns, tool calls, and outbound-message preparation.

Use it for diagnostics such as:

- a message seemed ignored;
- a tool was called repeatedly;
- a media send looked incomplete;
- you need the recent tool order for a session/run.

It is read-only. It does not retry, resend, edit messages, or change routing.

## Filters

Useful parameters:

- `count`: number of records.
- `kind` / `type`: record kind, such as `before_prompt_build`, `before_tool_call`, `after_tool_call`, `before_message_write`.
- `toolName` / `tool`: tool name.
- `sessionKey` / `session`: model window/session key.
- `runId` / `run`: run id.
- `status`: status field when present.

Records are sanitized: local paths, tokens, IPs, and long secrets are redacted. Text previews are short and intended for debugging only.
