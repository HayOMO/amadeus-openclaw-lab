# Deferred Tool Search V2

Date: 2026-07-01

## Decision

Amaduse Imagebot uses OpenClaw's built-in Tool Search runtime instead of a
project-local router.

Configured mode:

```json
{
  "tools": {
    "toolSearch": {
      "enabled": true,
      "mode": "directory",
      "searchDefaultLimit": 6,
      "maxSearchLimit": 12
    }
  }
}
```

`directory` mode keeps the full allowed tool surface available, but exposes only
a compact directory plus these control tools to the model:

- `tool_search`
- `tool_describe`
- `tool_call`

OpenClaw may also hydrate a few directly relevant tool schemas for convenience,
but this is only a schema exposure optimization. It is not the product routing
layer, and hidden catalog tools remain callable through `tool_call`.

## Why This Shape

The bot had 61 total allowed tools. An ordinary non-operator Telegram turn still
carried about 41 callable tools and roughly 46k characters of JSON schema. Owner
turns carried about 61 tools and roughly 67k characters of schema.

Keeping only the manual/search/index layer in prompt text helped behavior, but
it did not reduce provider-visible schema load. OpenClaw Tool Search solves that
at the runtime layer while preserving sender policy, denied tools, and plugin
contracts.

This matches the intended V2 design:

1. The model sees a compact capability directory.
2. The model searches the catalog when it needs a missing tool.
3. The model describes the chosen tool before using an unfamiliar schema.
4. The model calls the tool through OpenClaw, so existing sender/tool policies
   and hooks still apply.
5. The project-local `tool_manual_search` remains the workflow/manual layer for
   contracts that are larger than a JSON schema.

## Guardrails

- `settings.allowedTools` and `settings.deniedTools` remain the source of the
  capability boundary.
- `tools.toolsBySender` remains the source of ordinary-chat vs operator-only
  layering.
- Native hosted web search is still handled by OpenClaw/model runtime and is
  not represented as a fake `web_search` tool.
- `tools.toolSearch` is global because OpenClaw 2026.6.10 reads
  `config.tools.toolSearch`; do not add an agent-local mirror unless OpenClaw
  changes the runtime contract.

## Rollback

Set `config/imagebot/settings.json`:

```json
"toolSearch": {
  "enabled": false,
  "mode": "directory",
  "searchDefaultLimit": 6,
  "maxSearchLimit": 12
}
```

Then run:

```powershell
npm run build:config
powershell -ExecutionPolicy Bypass -File .\scripts\APPLY_CHAT_BALANCE_MODE.ps1
```

The full direct tool schema surface will return on new runs.

## Verification

Minimum local checks after changing V2:

```powershell
npm run lint:config
npm run test:core
```

For runtime verification, run an `openclaw agent` JSON turn and inspect the
trajectory. A compacted run should include `providerVisibleTools` in
`context.compiled`, while `tools` still records the full uncompacted capability
set.
