# Channel Adapter Contract

This contract defines the boundary for future Discord, QQ, WeChat, Slack, IRC,
or other channel adapters. It is a compatibility layer, not permission to add
account automation.

## Scope

A channel adapter may translate platform events into the existing imagebot
interaction model. It must not add a second memory system, bypass the
interaction trigger gate, or send cross-platform messages without an explicit
feature decision.

Supported adapter responsibilities:

- Normalize incoming messages into a channel-neutral envelope.
- Preserve platform identity and group/thread identity for window routing.
- Convert platform media references into bot-local media paths before tools see
  them.
- Expose delivery capabilities as explicit, audited send operations.
- Provide replay fixtures for trigger, media, identity, and permission behavior.

Out of scope until separately approved:

- Logged-in browser automation for account-backed platforms.
- Mass DM, unsolicited campaign, or follower/contact automation.
- Admin/moderation actions such as bans, kicks, mutes, or role changes.
- Cross-platform forwarding between private groups.
- Tunnels or public webhook exposure without the deployment security checklist.

## Message Envelope

Adapters should provide these normalized fields before the interaction pipeline:

```json
{
  "channel": "telegram|discord|qq|wechat|slack|irc|other",
  "chatId": "stable platform chat id",
  "threadId": "optional platform thread id",
  "senderId": "stable platform sender id",
  "senderName": "display name",
  "messageId": "stable platform message id",
  "replyToMessageId": "optional replied message id",
  "text": "message text after platform decoding",
  "media": [
    {
      "kind": "image|video|audio|file|sticker",
      "localPath": "bot-local media path",
      "mime": "image/png"
    }
  ],
  "timestamp": "ISO-8601 time"
}
```

Raw tokens, cookies, local profile paths, and platform authorization headers
must not appear in the envelope or tool-visible logs.

## Identity

Each adapter must map platform users to stable bot identities with an explicit
prefix such as `discord:123`, `qq:456`, or `wechat:abc`. The adapter must keep
group identity separate from user identity and must not merge identities across
platforms unless a separate user-controlled linking flow exists.

## Trigger Gate

Adapters must feed messages through the same trigger/window policy used by the
Telegram imagebot path:

- Replies to the bot can continue the active window.
- Mentions or configured trigger prefixes can open or route a window.
- Ordinary group chatter remains ignored unless a narrowly documented feature
  owns the exception.
- Media alone is not a trigger unless the current reply/session context allows
  it.

Adapter-specific shortcuts must be represented as replayable fixtures, not
hidden runtime branches.

## Media

Adapters must download or materialize platform media into a bot-local media
directory before exposing it to tools. Tool-visible media paths must stay under
configured media roots. External URLs are source references, not direct tool
inputs, unless a separate download tool validates them.

## Delivery

Delivery must be explicit and auditable. A send operation must record:

- target channel/chat/thread id;
- message id or platform delivery handle when available;
- sent media paths or artifact ids;
- error/retry status.

Adapters must not silently forward messages to another platform. Cross-platform
delivery needs a dedicated feature record, consent boundary, and tests.

## Permissions

Adapters may expose read/send capability only after the platform token/session
is configured by the operator. Admin actions, contact automation, large media
mirroring, and public webhooks require separate product and security decisions.

## Required Tests

Every adapter must include replay fixtures or unit tests for:

- trigger prefix, mention, reply-to-bot, and ignored group chatter;
- sender id, group id, and thread/window routing;
- media path normalization and path-boundary rejection;
- delivery success and delivery failure records;
- no token/cookie/local-path leakage in tool-visible output;
- rate-limit or retry behavior for platform send calls.

## Public Repository Rule

Public exports may include this contract, replay fixtures, and adapter templates.
They must not include platform tokens, account cookies, private group ids, or
operator-only deployment secrets.
