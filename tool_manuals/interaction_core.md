---
id: interaction_core
tools: interaction_pipeline, mars_forward_lookup
keywords: interaction, pipeline, trigger, mention, reply, group chat, window, session, identity, Telegram, /amnew, 助手, 唤醒, 窗口, 用户id, 群聊
when_to_read: When diagnosing why a group message should or should not trigger the bot, when window routing / sender identity is ambiguous, or when a user asks where a Telegram channel forward was already posted in the group.
---

# Interaction Core Manual

Interaction Core is the common contract for Telegram group interaction.

Use `interaction_pipeline` only when routing is unclear or the user asks why the
bot did or did not respond. It does not send messages and does not read hidden
chat history.

`interaction_pipeline action=evaluate` returns `pipeline`, a middleware-style
trace:

`receive -> identity -> command -> private_policy -> reply_to_bot -> mention -> trigger_prefix -> media -> permission -> rate_limit -> window_route -> decision`

Each stage has `name` and `status`. Treat this as the source of truth for
diagnostics. The rate-limit stage is diagnostic unless `enforceRateLimit=true`
or a future runtime layer enables enforcement.

## Group Trigger Rules

In groups, respond only when one of these is true:

- the message is an `/am*` control command;
- the message replies to a bot message;
- the message explicitly mentions the bot;
- the message starts with a configured prefix such as `助手`, `Amadeus`,
  `Makise`, or `Kurisu`.

Untriggered ordinary group messages should be ignored by the bot runtime.

## Passive Forward Rules

The Mars-forward detector is the narrow exception to the ordinary group trigger
gate. It runs before untriggered imagebot group messages are dropped, records a
bounded local fingerprint for Telegram channel forwards, and only wakes the
model when the current channel forward matches an earlier channel forward in the
same group/topic.

The first mechanical layer only accepts channel forwards. It records several
high-confidence keys when present:

- original channel id plus channel message id;
- canonicalized content URLs from text/caption entities or visible text;
- Telegram media `file_unique_id` for photos, image documents, animations, and
  videos.
- local visual hashes for cached image media. Exact visual-hash matches are
  strong mechanical evidence; near visual-hash matches are candidates for LLM
  review and do not receive a script-level reaction by themselves.

URL fingerprints intentionally ignore repeated footer/profile links, such as
the forwarded source channel's own `t.me/...` links, Telegram profile/invite
links, and X/Twitter follow/share intent links. Those links describe the source
or subscription footer, not the forwarded item.

The original channel is only one possible duplicate key. The visible lookup
target is the first same-group message recorded for the matched key, stored as
`record.first.chatId` plus `record.first.messageId`.

For media-bearing channel forwards, the runtime also tries to cache the media
body under `.openclaw/media/mars-forward` and precompute aHash/dHash/pHash
visual evidence when `sharp` is available. This cache is bounded and
disposable: the durable record is still the source/url/file_unique_id/visual
hash/message metadata. If the cached body is missing or the first same-group
message cannot be forwarded later, treat the result as suspected Mars unless
visible evidence is sufficient.

Forwarded group/chat/user messages, hidden-user forwards, copied text that is
not a channel forward, and unrelated repeated media are not Mars-forward trigger
candidates.

Exact channel-message, filtered canonical URL, or Telegram file-id duplicates may receive
a script-level fire reaction according to runtime config. Similar visual-image
candidates only wake review. The model receives a one-turn evidence block with
the first-seen record and current record, then decides whether a brief
duplicate/Mars quip fits the visible conversation.

Use `mars_forward_lookup` only for this Mars-forward state:

- `action=lookup` lists recent matching records for the current group/topic,
  with first/current message ids, preview text, mechanical keys, URLs, and media
  ids when available.
- `action=forward_first` forwards or copies the stored first same-group message
  back into the current group/topic. It refuses to send that first message into a
  different chat.
- If the user asks later, such as "where was this Mars", omit `messageId` unless
  you know the duplicate message id; the tool will pick the latest matching
  record in the current group/topic.
- The tool does not search the original channel and is not a sticker/image
  collection tool.

## Window Rules

- `/amnew` means open a fresh window for the sender.
- A reply to a bot message should use the replied bot message's window when a
  reply session key exists. This allows B to enter A's active window by replying
  to that bot message.
- A non-reply direct trigger uses the sender's own window.

## Identity Rules

Prefer stable Telegram user id over visible nickname. Usernames and display
names may change; ids should be preserved as `tg:<id>` when available.

## Optional Guards

`allowFrom` can be supplied for diagnostic sender allowlist checks. If it is
configured and the sender is not included, the decision reason becomes
`sender_not_allowed`.

`rateLimit` can be supplied as:

```json
{
  "enabled": true,
  "windowMs": 60000,
  "maxPerUser": 6,
  "maxPerChat": 30
}
```

Set `recordRateLimit=true` to record the evaluation in the in-memory diagnostic
limiter. Set `enforceRateLimit=true` to make a limited result return
`shouldRespond=false` with reason `rate_limited`.

Example:

```json
{
  "action": "evaluate",
  "text": "助手 签到",
  "userId": "12345",
  "displayName": "Alice",
  "chatId": "-100...",
  "isGroup": true,
  "botUsername": "YOUR_BOT_USERNAME"
}
```
