# Background Jobs Plan

## References Checked

- grammY runner: concurrent update processing with sequential constraints where ordering matters.
- python-telegram-bot JobQueue: scheduled/background jobs are a separate lifecycle from message handling.
- BullMQ / NestJS queues: job state, progress, retries, and lifecycle events should be observable outside the caller.
- FastAPI BackgroundTasks: accept the request quickly and do non-critical work after the immediate response; use heavier queues only when process isolation is needed.

## Local Design

The imagebot should keep one Telegram window/session serial for normal model turns, but long-running tool work can be detached into bot-owned background jobs.

Initial scope:

- In-process queue only; no Redis, database, Docker, or external worker.
- Append-only JSONL event log under `~/.openclaw/background-jobs`.
- Bounded concurrency, default 3 and hard-capped at 8.
- Job states: `queued`, `active`, `retrying`, `completed`, `failed`, `cancelled`.
- Runtime status and cancellation through the `background_job` tool.
- Jobs store a normalized runtime context with `scopeKey` and, when available,
  `actorKey`. Model-visible `background_job` calls default to the current
  chat/session/window scope for list/get/cancel; other scopes return
  `not_found`.
- Open-job dedupe keys are scoped so the same payload in two chats does not
  collapse into one job.

Non-goals for this patch:

- Do not intercept OpenClaw's built-in `image_generate` yet.
- Do not change Telegram window routing.
- Do not change media delivery behavior.
- Do not add arbitrary shell execution.

## Integration Rules

Future long-running tools should register a handler with the shared job manager and return a `job_id` quickly. The foreground turn can keep chatting or give status while the job writes progress events.

Good candidates:

- Web screenshots with slow pages.
- Bulk image downloads.
- Video keyframe extraction.
- Gacha/channel archive retries.
- Image generation, after the send/retry path is fully covered by tests.

Hot-path hooks must remain cheap. A prompt hook may inject a short list of active jobs for the current chat/session, but it must not scan large logs, start network work, or call another model.

## Image Generate Evaluation

Current local plugin API usage shows:

- plugins can register tools with `api.registerTool`;
- plugins can observe or modify tool calls with `before_tool_call` and `after_tool_call`;
- no stable local `callTool` / `executeTool` API is exposed in this repository for a plugin background worker to invoke OpenClaw's built-in `image_generate`.

Therefore the first full background pass covers owned tools only. Built-in
`image_generate` remains foreground until OpenClaw exposes a safe internal tool
call API or we build a tested external image client with the same auth/delivery
semantics. Hooking or re-dispatching `image_generate` indirectly would risk
breaking media delivery, lineage tracking, cancellation, and window routing.
