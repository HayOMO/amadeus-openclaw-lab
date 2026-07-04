---
id: chat_toolbox
tools: chat_toolbox
keywords: todo, notes, faq, quote, reminder, birthday, event, poll, vote, dice, coin, random, choice, shuffle, team split, lots, rock paper scissors, 8ball, text stats, links, bookmarks, countdown, habit, mood, karma, seen, tell, unit convert, timezone, glossary, snippet, queue, 群聊工具, 投票, 待办, 便签, 抽签, 骰子, 生日, 事件, 词条
when_to_read: Before using local Telegram group-chat utility features such as todos, notes, FAQs, quotes, reminders, birthdays, polls, randomizers, karma, seen/tell, glossary, snippets, queues, or small text helpers.
---

# Chat Toolbox Manual

`chat_toolbox` is a backlog prototype for a local Telegram chat utility
toolbox. It is not enabled in the main runtime config by default. Call it only
after it is deliberately added back to `allowedTools` and is visible in the
current tool list.

When enabled, it stores small group state under the configured local store and
never performs admin actions, mass DM, external API calls, shell execution, or
automatic scheduled sends.

Use it for lightweight group features collected from common bot ecosystems such
as Hubot/Sopel/Limnoria/Red-style bots and Telegram assistant bots.

## Scope

Default `scope` is `group`. Use `global` only for deliberately shared utility
state, and `session` only when a temporary window-local note is wanted.

## Grouped Primary Interface

Use grouped calls first. They keep the future schema small while preserving the
50 concrete backlog actions for traceability.

- `action=task`: todo add/list/done through `op=add|list|done`.
- `action=records`: notes, FAQs, quotes, bookmarks, glossary terms, and snippets
  through `kind=<note|faq|quote|bookmark|glossary|snippet>` plus `op`.
- `action=schedule`: reminders, birthdays, events, and countdowns through
  `kind=<reminder|birthday|event|countdown>` plus `op`.
- `action=poll`: local text poll create/vote/results through `op`.
- `action=random`: choice, dice, coin, number, shuffle, team split, lots, RPS,
  and eight-ball through `kind`.
- `action=text`: text stats, link extraction, unit conversion, and timezone
  conversion through `kind`.
- `action=wellness`: habit and mood helpers through `kind` plus `op`.
- `action=social`: karma, seen, and tell-message helpers through `kind` plus
  `op`.
- `action=queue`: generic queue join/list through `op`.

## Legacy Concrete Actions

Storage helpers:

- `todo_add`, `todo_list`, `todo_done`
- `note_save`, `note_search`
- `faq_add`, `faq_search`
- `quote_add`, `quote_random`
- `reminder_add`, `reminder_due`
- `birthday_add`, `birthday_next`
- `event_add`, `event_agenda`
- `bookmark_add`, `bookmark_search`
- `glossary_add`, `glossary_search`
- `snippet_save`, `snippet_search`
- `queue_join`, `queue_list`

Poll and group game helpers:

- `poll_create`, `poll_vote`, `poll_results`
- `choice`, `roll_dice`, `flip_coin`, `random_number`
- `shuffle`, `team_split`, `draw_lots`
- `rps`, `eight_ball`

Group memory/status helpers:

- `habit_checkin`, `habit_status`
- `mood_log`, `mood_summary`
- `karma_inc`, `karma_leaderboard`
- `seen_set`, `seen_get`
- `tell_add`, `tell_due`

Text and conversion helpers:

- `text_stats`
- `extract_links`
- `countdown`
- `unit_convert`
- `timezone_convert`

## Important Boundaries

- `reminder_add` records a reminder but does not schedule or send a future
  Telegram message. Use `reminder_due` to inspect due records.
- `tell_add` stores a message for a named target; `tell_due` returns and marks
  matching messages as delivered. The model must decide whether to speak them in
  the current triggered chat turn.
- `poll_*` is local text poll state, not Telegram native poll creation.
- Randomizers are for chat convenience, not gambling or real prizes.
- URLs in `bookmark_add` must be public `http` or `https` URLs.
- `unit_convert` intentionally supports a small fixed unit table only.

## Typical Calls

Create a poll:

```json
{
  "action": "poll",
  "op": "create",
  "question": "Which prompt set should we test?",
  "options": ["A", "B", "C"]
}
```

Vote:

```json
{
  "action": "poll",
  "op": "vote",
  "id": "poll_abc",
  "option": "B"
}
```

Make teams:

```json
{
  "action": "random",
  "kind": "team",
  "op": "split",
  "items": ["alice", "bob", "carol", "dave"],
  "teamCount": 2
}
```

Save a group FAQ:

```json
{
  "action": "records",
  "kind": "faq",
  "op": "add",
  "question": "How do we test images?",
  "answer": "Use the test group first, then promote good recipes."
}
```
