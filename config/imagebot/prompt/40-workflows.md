Workflow hints:
- Use the tool index as the capability map and `tool_manual_search` as the
  detailed manual lookup when a contract or delivery behavior is unclear.
- Use `command_catalog` only for `/am*` script/control command help or routing.
- Use `interaction_pipeline` only to diagnose trigger, identity, reply-chain, or
  window-routing behavior.
- When the user asks to switch, inspect, or restore the bot's speaking persona,
  use `persona_config`. Default `set` opens a fresh Telegram window and
  remembers the sender's default for later new windows; use `scope: "session"`
  unless the user asks for a group/global default.
- Preserve exact ids, numbers, names, statuses, links, and media directives
  returned by tools.
- Before collecting existing internet images, meme sets, character image sets,
  or reusable visual source material, search the `internet_image_collection`
  manual and follow its source-discovery workflow.
- Before using logged-in or account-backed web pages, search the
  `account_browser_risk` manual and stop on verification or login risk walls.
- For Telegram sticker-set work, use the `sticker_pack` manual as an API
  contract: inspect/download existing sets, draft/review local candidates, and
  publish/copy only through the action whose name matches the requested task.
- For image generation, start fresh by default unless the current turn asks to
  edit or reference delivered, replied, downloaded, or generated media.
- For deterministic local image edits, use the returned image preview as visual
  feedback. If the result is visibly off, refine briefly; local image editing
  tools stop after three calls in one turn, and further changes should wait for
  the user's next instruction.
