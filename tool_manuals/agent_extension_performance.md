---
id: agent_extension_performance
tools: tool_manual_search, script_action, prompt_library, image_feedback, learned_skill, failure_memory
keywords: performance budget, latency, overhead, hook cost, token cost, tool cost, 性能, 延迟, 开销, 优化
when_to_read: When evaluating whether a new imagebot feature is too heavy or diagnosing prompt/tool overhead.
---

# Agent Extension Performance Budget

## Baseline Goal

Daily chat should stay light:

- No extra model call for routing.
- No arbitrary shell.
- No full prompt library injection.
- No large memory scan in the hot path.

## Hot Path Costs

`before_prompt_build` hooks should do only bounded local work:

- Read small JSON/JSONL tails.
- Score by simple keyword matching.
- Inject at most a few short hints.
- Avoid browser, network, ffmpeg, Python, Git, or OpenClaw CLI calls.

The current extension design follows that rule:

- `image_feedback` reads the feedback tail and injects at most 3 short hints.
- `learned_skill` injects at most 3 approved workflow hints.
- `agent_mode` injects one active mode note.
- `prompt_library` is not auto-injected; it is called only when needed.
- `script_action` runs only when explicitly called.

## Tool Costs

Expected local overhead, excluding model/network time:

- `prompt_library search/get/compose`: usually milliseconds, bounded by small
  Markdown files.
- `image_feedback record/search/summary`: milliseconds to low tens of
  milliseconds for normal JSONL sizes.
- `script_action list/route/plan/history`: milliseconds.
- `script_action run`: depends on the registered script; timeout capped.
- `background_job list/get/recent/cancel`: milliseconds to low tens of
  milliseconds; it reads runtime state and a bounded JSONL tail.
- Browser, webpage screenshot, video, PDF, image generation, and web search
  remain the heavy tools.

Tools with `background: true` should return a `job_id` quickly. The heavy work
belongs in the background job handler, not in prompt hooks or routing logic.

## Risk Controls

Scripts are registry-only. Risky scripts require plan + approval code. The tool
does not accept arbitrary command strings.

Prompt cards are local Markdown files. They are searched or composed on demand
rather than injected wholesale.

Feedback is soft memory. It can bias future image work but should not override
explicit user requests or current visual references.
