---
id: feature_core
tools: feature_catalog, feature_action, gacha_archive
keywords: feature, mixed bot, check-in, checkin, sign-in, daily, stateful, points, streak, leaderboard, gacha, waifu, collection, archive, cache, 签到, 打卡, 抽卡, 抽老婆, 十连, 图鉴
when_to_read: Before routing or executing manifest-driven mixed features such as daily check-in, points, streaks, lightweight group games, waifu gacha, or final gacha media archival.
---

# Feature Core Manual

Feature Core is for mixed bot features:

- The tool owns deterministic facts, state, cache, and hard limits.
- The model decides when to call tools and how to respond in character.
- Script-like features return factual text; preserve it exactly.
- Do not turn ordinary tool abilities into slash commands.

For the independent D20 fantasy group adventure game, use
`group_adventure` and read `group_adventure.md`; it is not a feature_core
handler.

## Tools

Use `feature_catalog` to discover or route feature-like requests:

- `action=list`: list available features.
- `action=get`, `feature=<id>`: inspect one feature.
- `action=route`, `query=<user text>`: route an ambiguous feature request.
- `action=validate`: validate feature manifests without executing handlers.

Run `feature_catalog action=validate` after adding or changing feature manifests.
It reports missing ids, unknown handlers, duplicate action ids, duplicate
triggers, invalid cooldowns, and unsupported risk/permission labels.

Use `feature_action` to execute a feature:

- `feature=checkin`, `action=checkin`: record today's check-in.
- `feature=checkin`, `action=status`: read one user's check-in status.
- `feature=checkin`, `action=leaderboard`: read check-in leaderboard.
- `feature=waifu_gacha`, `action=draw`: draw one Danbooru-backed anime image card.
- `feature=waifu_gacha`, `action=ten_pull`: draw ten cards.
- `feature=waifu_gacha`, `action=daily`: draw or read today's fixed card.
- `feature=daily_fortune`, `action=draw`: draw/read today's deterministic lab omen.
- `feature=daily_fortune`, `action=status`: read one user's daily-fortune status.
- `feature=daily_fortune`, `action=leaderboard`: read daily-fortune leaderboard.
- `feature=waifu_gacha`, `action=collection`: read one user's collection.
- `feature=waifu_gacha`, `action=profile`: read one user's pity/rarity/recent-draw profile.
- `feature=waifu_gacha`, `action=stats`: read aggregate gacha lab statistics.
- `feature=waifu_gacha`, `action=leaderboard`: read collection leaderboard.

For slow feature calls, especially gacha/cache/channel work, pass
`background: true` and use `background_job` to check the returned `job_id`.

Use `gacha_archive` only for manual repair/backfill after a final sendable
gacha media path exists. Normal waifu gacha calls archive media automatically
inside `feature_action`.

Manual `gacha_archive` also supports `background: true`.

- Input must be a bot-local media path or a `MEDIA:` line.
- Do not pass external URLs.
- Archive the final sendable file unchanged.
- If content should be hidden behind Telegram's native click-to-view cover, pass `spoiler=true`. Do not pixel-censor the original.
- The tool writes a local archive/index. Direct `gacha_archive` calls are local-cache only unless `sendToChannel=true` is explicitly passed; normal waifu gacha internals pass that flag for the configured archive channel.
- The returned `MEDIA:` line points at a Telegram-sendable local media copy under the bot media directory. Use that line for final Telegram delivery; the canonical archive path remains in tool details.

## Waifu Gacha

`feature_action` returns full Danbooru posts as the card images. The post
image is the card itself. Do not use generated gallery or `image_generate` for
gacha result art unless the user separately asks to redraw or generate a
derivative image.

Recommended delivery sequence:

1. Call `feature_action`.
2. Use `replyText` as the factual message body.
3. Send `albumMedia` / `MEDIA:` lines when present. These files have already
   been downloaded, locally cached, and posted to the configured archive channel
   by the script layer.
4. If `albumMedia` is empty but `resultImages` exists, use the image URL(s) as a
   fallback and briefly mention archive/cache failure only if relevant.

For manual archive repair/backfill, call `gacha_archive` with the final sendable
media path and compact metadata: `batchId`, `postId`, `name`, `rarity`, `score`,
`pageUrl`, `sourceUrl`, `primaryTags`, `archiveTags`, `characterTags`,
`copyrightTags`, `artistTags`, `tagString`, `safeStatus`, `spoiler`, `userId`,
`chatId`. The archive tool formats Telegram captions itself, including
searchable `#hashtags`, so pass factual metadata and do not hand-write channel
tags.

One gacha request is capped at 10 draws. If a user asks for more, the tool
returns one ten-pull and includes `requestLimit` plus a cap notice in
`replyText`. If the same ten-pull or multi-draw tool call is repeated shortly
after, the tool returns a compact duplicate marker with `suppressFinalReply`,
not the full previous result/media.

Rarity is rolled first, then the tool searches `1girl` plus that rarity's score
band. Default rates are `N 40%`, `R 50%`, `SR 8%`, `SSR 1.67%`, and `UR 0.33%`;
UR has a 300-draw hard pity. Default score bands are `N 20-30`, `R 31-50`,
`SR 51-100`, `SSR 101-299`, and `UR 300+`. Do not re-judge rarity from
popularity after the post is returned.

Model-facing results are compact. Full-ish post metadata is stored locally for
archive repair, cache replay, and later data analysis.

Use `profile` or `stats` for data-analysis style questions before reading raw
history. `profile` is per user; `stats` summarizes the current gacha state.

## Identity

Pass Telegram identity when available:

```json
{
  "feature": "checkin",
  "action": "checkin",
  "userId": "tg:123456",
  "userName": "alice",
  "displayName": "Alice",
  "chatId": "-100..."
}
```

Preserve these facts exactly after `feature_action` or `gacha_archive`:

- dates, gained points, total points, streak, rank, already-checked-in state
- card name, rarity, score band, affinity, new/duplicate state
- collection score, shards, and counts
- Danbooru post id, page URL, image URL, score, fav count, and primary tags
- request limits, duplicate-request status, archive id, channel status, and
  `MEDIA:` lines

Natural comments are fine. Do not invent or alter numeric/tool results.
