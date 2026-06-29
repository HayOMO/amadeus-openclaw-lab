---
id: creative_ops
tools: command_catalog, script_action, background_job, prompt_library, image_feedback, model_config
keywords: script registry, natural language command, maintenance script, prompt library, character card, style card, image recipe, image feedback, rating, prompt learning, image prompt, character card, style card, script, feedback learning
when_to_read: Before routing Telegram /am* control/script commands, natural-language maintenance commands, registered scripts, image prompt/style/character cards, generation feedback, or /ammodel chat-side model profile commands.
---

# Creative Ops Manual

## Script Registry

Use `command_catalog` for `/amhelp`, ability discovery, command discovery, and
unfamiliar fixed control/script `/am*` commands. It is the source of truth for
the human-facing capability overview plus Telegram-visible control commands,
usage, target tool/script, and approval notes. Ordinary model abilities are
intent-driven inside delivered trigger/reply/mention turns; do not invent slash
commands for them.

Common routing:

- `/amhelp`: call `command_catalog` with `action=list`, `menuOnly=true`,
  `includeCapabilities=true`.
- `/amhelp abilities` or "what can you do": call `command_catalog` with
  `action=abilities`.
- `/amhelp media` or `/amhelp ops`: call `command_catalog` with `action=list`
  and the requested `category`, `menuOnly=true`.
- `/amhelp all` or `/amhelp hidden`: call `command_catalog` with `action=list`,
  `menuOnly=false`.
- `/amhelp amstatus`: call `command_catalog` with `action=get`,
  `command=amstatus`.
- Unfamiliar `/am*`: call `command_catalog` with `action=route` or `get`.

Use `script_action` for natural-language maintenance requests that map to a
registered local script. It cannot run arbitrary shell.

Actions:

- `list`: show registered scripts.
- `route`: score a natural-language request against the registry.
- `plan`: create a traceable plan and approval code for risky scripts.
- `run`: execute a registered script.
- `run_background`: queue a registered script as a background job and return a
  `job_id` quickly.
- `history`: show recent runs.

Rules:

- Use `route` when the user asks in natural language and the target script is
  unclear.
- Low-risk read scripts can run directly.
- Risky scripts require `plan` first. Ask the user to repeat the approval code,
  then call `run` from that later approved turn with the returned `plan_id`.
  The tool verifies the current trusted runtime message context; the legacy
  `approval_text` parameter is not an authority by itself.
- Use `run_background` for slow registered scripts when the chat should remain
  responsive. Use `background_job` to check or cancel the returned `job_id`.
- Do not claim arbitrary local command execution is available.

## Prompt Library

Use `prompt_library` for image prompt recipes, style cards, character direction,
and negative constraints.

Actions:

- `search`: find relevant cards.
- `get`: read one card.
- `compose`: combine selected cards into a compact drafting aid.
- `list`: inspect available cards.

Good uses:

- Specified character generation.
- Official-reference workflows.
- Meme/sticker prompts.
- Wallpaper/poster prompts.
- Style stabilization.
- Avoiding repeated generation failures.

Do not expose prompt-card mechanics unless the user asks how the workflow was
built.

## Image Feedback

Use `image_feedback` when the user says an image is good, bad, close, wrong,
too generic, off-character, or gives advice for the next generation.

Record:

- `rating`: `good`, `bad`, or `mixed`.
- `subject`: character/style/topic.
- `target`: gallery id, artifact id, task id, or short label.
- `keep`: what should be reused.
- `avoid`: what should be avoided.
- `notes`: short freeform explanation.

The feedback hook injects only a few relevant hints for future image-related
turns. Treat feedback as soft preference memory, not a hard rule.

## Model Config

Telegram `/ammodel` chat commands are runtime-handled before model context
construction. Do not call `model_config` for plain `/ammodel` messages.
The Telegram UI is a two-step menu: first choose the model, then choose one of
that model's raw thinking levels. It includes a Back button to return to the
model list. GPT shows `minimal`, `low`, `medium`, `high`, and `xhigh`.
DeepSeek V4 Flash/Pro shows `off`, `high`, and `max`; compatibility aliases
such as `low`/`medium` are intentionally not shown as first-class DS options.

Use `model_config` only for app/control-panel maintenance or explicit
administrator requests to change the global OpenClaw model config. It writes
OpenClaw config first, then writes OpenClaw session-level model override fields
when a `sessionKey` is available. Do not claim the current in-flight reply
already used the new profile; the next clean turn in the same window should use
it.

Writing model config or scheduling a gateway restart is a mutation path. Use
`action: "plan"` first, ask the user to repeat the returned approval code, then
call `action: "set"` or `action: "restart"` with `plan_id` from that later
approved turn. The approval is checked against the current trusted runtime
message context, including requester and scope. Plain reads (`get`, `status`,
`profiles`, `list`) do not need approval.

Actions:

- `get` / `status`: read current model config.
- `profiles` / `list`: show known local profiles and enabled models.
- `plan`: create an approval plan for `set` or `restart`.
- `set`: apply a known profile or custom validated model settings.
- `restart`: schedule a delayed gateway restart only when provider/plugin/auth
  refresh is actually needed.

Do not invent unavailable providers. A model must be present and enabled in
`IMAGEBOT_MODEL_PROFILES.json` before switching to it.
