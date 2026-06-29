---
id: background_jobs
tools: background_job
keywords: background job, queue, async, long-running, status, cancel, retry, progress, 后台任务, 队列, 状态, 取消, 并发
when_to_read: When a long-running tool returns or mentions a background job id, when checking whether work is still running, or when cancelling stuck work.
---

# Background Jobs

## Overview

`background_job` inspects bot-owned long-running work. It does not start arbitrary work and cannot run shell commands.

Use it to:

- list active/queued/retrying jobs;
- inspect a specific `job_id`;
- cancel a job that is clearly stale or no longer wanted;
- check recent completed/failed jobs.

Long-running tools that support `background: true` include:

- `script_action run_background`;
- `web_snapshot`, `media_transform`, `pdf_render`, `av_media`, `audio_transcribe`, `web_watch_check`;
- `video_keyframes`, `media_brief`, `meme_transform`;
- `public_video` for subtitle extraction or bounded downloads;
- `web_image_search`, `download_image_url`, `download_image_urls`, `reverse_image_search`;
- `feature_action`, `gacha_archive`.

## Actions

- `summary`: show a compact queue/active/recent/stale summary.
- `list`: show current open jobs by default. Optional `state` can be `open`, `queued`, `active`, `retrying`, `completed`, `failed`, or `cancelled`.
- `recent`: show recent jobs from the append-only event log.
- `get`: read one job by `job_id`.
- `cancel`: cancel one queued or active job by `job_id`.

## Scope

Runtime calls are scoped to the current trusted chat/session/window. A group or
window can list, inspect, and cancel only its own background jobs; another
scope's `job_id` returns `not_found`.

Duplicate keys are also scoped. Reusing the same `dedupe_key` in two different
groups creates independent jobs, while reusing it inside the same scope returns
the still-open job.

## Contract

Long-running tools may return a `job_id` instead of a final artifact. Preserve the id exactly when reporting status.

If a user asks whether work is still alive, call `background_job` before guessing. If a job failed, report the failure reason plainly and continue with any available fallback.
