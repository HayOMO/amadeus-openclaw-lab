# Imagebot Telegram Command Layer

This file defines the command policy for the private Telegram imagebot.

## Principle

Only fixed control/script actions should become slash commands.

Ordinary model abilities do not need their own commands. Image generation,
image editing, PDF reading, video keyframes, webpage snapshots, QR utilities,
GitHub lookup, memory search, prompt cards, gallery lookup, and text/code
utilities are exposed as tools. The model should choose those tools from
delivered trigger messages, bot replies, mentions, configured prefixes, and
delivered/replied media when intent is clear.

This keeps the bot UI small and avoids duplicating the tool layer with a large
set of fragile `/amxxx` aliases.

## Source Of Truth

```text
scripts/IMAGEBOT_COMMANDS.json
```

Consumers:

- `scripts/APPLY_CHAT_BALANCE_MODE.ps1` reads only `menu=true` catalog commands
  into OpenClaw Telegram `customCommands` so local group trigger filtering
  passes only the visible deterministic control commands.
- `scripts/SYNC_IMAGEBOT_TELEGRAM_COMMANDS.ps1` syncs only `menu=true` commands
  to Telegram's visible command menu.
- `plugins/imagebot-creative-ops` exposes `command_catalog` for `/amhelp` and
  unfamiliar `/am*` routing. `/amhelp` also includes a short capability
  overview so humans know what the bot can do without turning every ability
  into a command.
- `tool_manuals/creative_ops.md` describes command-routing rules for the model.

## Visible Menu

The visible Telegram command menu is intentionally small:

- `/amnew`: open a clean chat window. Runtime-handled before normal model
  context construction.
- `/amhelp`: show a capability overview plus control commands.
- `/amstatus`: run the read-only gateway status script.
- `/ammodel`: inspect or switch model profile.
- `/ampersona`: inspect or switch speaking persona with Telegram buttons.
- `/amtools`: list/route/run registered scripts.
- `/amroll`: 掷骰，小型 pre-model 脚本命令。
- `/amcoin`: 抛一次或多次硬币，小型 pre-model 脚本命令。
- `/amchoose`: 从短列表里选一个。
- `/amshuffle`: 打乱短列表。
- `/amsplit`: 把名字或项目随机分组。
- `/amstats`: 统计命令参数或被回复文本消息。
- `/amlinks`: 从命令参数或被回复文本消息里提取链接。

`/amroll` 到 `/amlinks` 这批小功能刻意做成命令式：不唤醒模型，
不写群历史，执行范围有上限，就算坏了也只会坏在小脚本层。

Hidden but cataloged control scripts:

- `/amdeepstatus`: detailed status/security audit.
- `/ambackup`: memory/GitHub backup routing, approval for GitHub writes.
- `/amarchive`: archive generated/downloaded media cache.

Telegram command-menu sync is intentionally local-operator only:
`scripts/SYNC_IMAGEBOT_TELEGRAM_COMMANDS.ps1`.

## Explicit Non-Goals

These are not slash commands anymore:

- `/draw`, `/edit`, `/read`, `/describe`, `/search`.
- `/ampdf`, `/amvideo`, `/amqr`, `/amwebshot`, `/amwatch`, `/amtext`.
- `/amgallery`, `/amartifact`, `/ammemory`, `/amskills`, `/amfailures`.
- `/amgithub`, `/amdata`, `/amprompt`, `/dream`, `/failures`.
- `/ask`.

Use a delivered trigger message, reply to the bot, mention, or configured
prefix for those tasks. The model should call the corresponding visible tool
directly.
