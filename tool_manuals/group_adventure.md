---
id: group_adventure
tools: group_adventure
keywords: group adventure, dnd, d20, rpg, dungeon, character sheet, party, adventure log, fantasy game, 冒险, 地下城, 跑团, 角色卡
when_to_read: Before running or explaining the local group adventure game.
---

# Group Adventure

`group_adventure` is a local script game. The tool owns character sheets, daily
adventures, d20 rolls, HP, XP, gold, loot, logs, and party ranking. The model
hosts and narrates around the facts.

Default world: D20 fantasy / Dungeons & Dragons style. The world is config-based
and can be replaced later.

## Actions

- `adventure` / `daily` / `run`: run or read today's adventure for one user.
- `profile` / `sheet`: read one user's character sheet.
- `party` / `leaderboard`: show the ranked adventuring party.
- `log` / `recent`: show recent adventure events.

## Use

Pass Telegram identity when available:

```json
{
  "action": "adventure",
  "userId": "tg:123456",
  "userName": "alice",
  "displayName": "Alice",
  "chatId": "-100..."
}
```

Preserve exactly:

- d20 roll, DC, bonus, outcome;
- HP, XP, gold, renown, level, loot;
- already-adventured state for the same day;
- party ranking and log order.

Natural D&D-style narration is useful. Do not invent mechanical results that
are not in the tool output.
