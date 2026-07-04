# Telegram Script Micro Features - 2026-07-02

This pass collects small group-chat features in the same family as the
pre-model text/sticker repeater: deterministic, low-cost, mostly script-owned
features that should avoid waking the LLM unless the user asks for explanation
or synthesis.

The list is biased toward Telegram group chat and Chinese/Asian bot ecosystems
(NoneBot, Koishi, Hoshino-style plugins), with Telegram-native feasibility
checked against the Bot API. It is a scouting note, not a runtime enablement
plan.

## Boundary Notes

- Features that need every normal group message, such as word clouds and message
  statistics, require privacy-mode-compatible message ingestion. Telegram
  exposes incoming message updates for text, photo, sticker, and other message
  kinds, but group-wide logging depends on the bot being allowed to read those
  messages.
- Script features should use bounded local storage with retention, per-group
  state, sender-id attribution, and opt-out/delete support where user history is
  recorded.
- Native Telegram actions are preferable when they exist: native poll, native
  dice, sticker `file_id` resend, reply/quote metadata, and inline buttons.
- Admin actions such as muting repeaters are out of scope unless the operator
  explicitly enables an admin module.
- Existing `chat_toolbox` candidates are not re-counted as new implementation
  work, but they are referenced when a discovered feature maps to that layer.

## Source Sweep

- Telegram Bot API: incoming updates include message kinds such as text, photo,
  and sticker; `getMe.can_read_all_group_messages` indicates whether privacy
  mode is disabled; native `sendPoll`, `sendDice`, and `sendSticker` cover some
  script outputs.
- `he0119/nonebot-plugin-wordcloud`: group word cloud, per-group mask shape, and
  daily/weekly/monthly/yearly scheduled word cloud.
- `Koishi-Plugin/chat-analyse`: command stats, message stats, ranking, activity
  charts, word cloud, similar-active users, mention tracking, chat review, data
  backup/restore, and precise cleanup.
- `koishijs/koishi-plugin-repeater`: auto repeater and interrupt repeater
  pattern.
- `CMHopeSunshine/nonebot-plugin-learning-chat`: learned group replies, sticker
  learning, repeater threshold, active speaking after cold periods, per-group
  config, and web management UI.
- `mkdryden/telegram-stats-bot`: Telegram group message logging plus tables and
  plots for counts, hours, days, week, history, user stats, correlations, message
  types, frequent words, and random logged messages.
- `LyoSU/quote-bot` and `julesvirallinen/telegram-quote-bot`: quote cards from
  replied messages, multi-message quotes, random/top quotes, tagged quotes, and
  sticker quotes.
- `jonowo/on9wordchainbot`: word-chain group game, trend generation, group
  leaderboard, rate limiting, and observability notes.
- `rubasace/ldrbot`: screenshot/text parsing for game score extraction and
  daily per-group leaderboards.
- `Telegram-Reminder-Bot`, `telegram_periodic_msg_bot`, birthday bots, and
  meetup organizer bots: reminders, timezone handling, birthday lists, periodic
  messages, random member/location selection, and native polls.

## Candidate Bundles

| # | Bundle | Feature | Trigger shape | Script fit | Notes |
| ---: | --- | --- | --- | --- | --- |
| 1 | Text analytics | 24h word cloud | `词云`, `/wordcloud`, button | strong | Needs rolling message text log, Chinese tokenizer, stopword list, PNG render. |
| 2 | Text analytics | Weekly/monthly word cloud | scheduled or command | strong | Keep schedule disabled by default; command-only first. |
| 3 | Text analytics | Per-user word cloud | reply/user arg | medium | Privacy-sensitive; require explicit command and bounded window. |
| 4 | Text analytics | Custom word cloud mask | upload image + set mask | medium | Store per-group mask; needs image preprocessing. |
| 5 | Text analytics | Hot words table | `热词`, `/hotwords` | strong | Cheaper than image word cloud; good first implementation. |
| 6 | Text analytics | N-gram/catchphrase ranking | `口癖`, `群友语录统计` | medium | Useful for Chinese groups; filter short spam. |
| 7 | Message stats | Message count leaderboard | `今日龙王`, `/rank` | strong | Use sender-id counts; no model needed. |
| 8 | Message stats | Message type distribution | `群消息类型统计` | strong | Counts text/sticker/photo/voice/video/poll. |
| 9 | Message stats | Activity heatmap | `活跃时段` | medium | Render small chart image; day/hour buckets. |
| 10 | Message stats | Command usage stats | `命令统计` | strong | Helps prune tools and detect slow/unused commands. |
| 11 | Message stats | Personal activity card | `我的统计` | medium | User opt-out/delete path recommended. |
| 12 | Message stats | Group title/name history | `群名历史` | low | Telegram title events may be sparse; fun but lower value. |
| 13 | Social graph | Mention tracker | `谁@我`, `/whoatme` | medium | Needs mention extraction and per-user lookup. |
| 14 | Social graph | Reply graph | `谁最爱回谁` | medium | Use reply metadata only, not semantic inference. |
| 15 | Social graph | Similar-active users | `作息相似` | medium | Pure time-bucket similarity; avoid labeling relationships. |
| 16 | Quote/memory | Quote from replied message | reply + `记语录` | strong | Existing `chat_toolbox` quote storage covers text; extend to media/sticker later. |
| 17 | Quote/memory | Quote image card | reply + `/q` | medium | Render reply text/avatar/name into PNG; local fonts needed. |
| 18 | Quote/memory | Random quote | `来条语录` | existing | Already mapped to `chat_toolbox quote_random`; can add buttons. |
| 19 | Quote/memory | Top/rated quotes | buttons | medium | Needs reaction/rating state; avoid spam. |
| 20 | Quote/memory | Random historical message | `随机黑历史` | medium/high | Fun but privacy-sensitive; should require per-group enablement and deletion. |
| 21 | Repeater | Threshold text repeater | passive pre-model | existing | Implemented; keep different-sender rule and cooldown. |
| 22 | Repeater | Sticker repeater | passive pre-model | existing | Implemented with sticker identity; should use `file_id` resend. |
| 23 | Repeater | Interrupt repeater | passive pre-model | medium | Bot breaks a repeat chain with a different fixed response. Needs careful taste. |
| 24 | Repeater | Repeat checker alert | passive pre-model | medium | Admin mute is out of scope; alert/log only unless operator enables admin. |
| 25 | Learning reply | Learned QA reply | passive or command | high | Mature in NoneBot, but high privacy/noise risk. Keep opt-in and inspectable. |
| 26 | Learning reply | Learned sticker reply | passive or command | high | Same as above; can be funny, but needs blacklist and rate limit. |
| 27 | Learning reply | Cold-room active message | timer | high | Powerful but easy to annoy users; default off. |
| 28 | Native Telegram | Native poll wrapper | command + buttons | medium | Telegram supports native polls; safer than local polls when visible voting is desired. |
| 29 | Native Telegram | Native dice/emoji games | `骰子`, `篮球`, `足球` | strong | Telegram `sendDice` already randomizes server-side. |
| 30 | Native Telegram | Inline-button quick votes | message buttons | medium | Useful for yes/no, test result evaluation, image choice. |
| 31 | Scheduling | Group reminders | command | existing/medium | Existing `chat_toolbox` records due reminders only; true auto-send needs scheduler policy. |
| 32 | Scheduling | Periodic text messages | schedule config | medium/high | Useful but should be operator-configured, not model-created silently. |
| 33 | Scheduling | Birthday reminders | command | existing/medium | Existing candidate; auto-send disabled unless scheduler approved. |
| 34 | Scheduling | Meetup organizer | command | medium | Random member/location selection + native poll; avoid external sheets first. |
| 35 | Mini games | Word chain | command/passive game room | medium | Needs per-group game state, dictionary, timeout, leaderboard. |
| 36 | Mini games | Wordle-style daily puzzle | command | medium | Existing public pattern; local word list required. |
| 37 | Mini games | Screenshot score leaderboard | image upload | medium/high | OCR is optional; text parse first, OCR later. |
| 38 | Mini games | Daily puzzle score parser | pasted result text | strong | Good low-cost variant of OCR leaderboard. |
| 39 | Stickers/media | Sticker usage leaderboard | `贴纸排行` | strong | Count `file_unique_id`, show saved `file_id` preview. |
| 40 | Stickers/media | My favorite stickers | `我的贴纸统计` | medium | User-scoped stats; opt-out/delete path. |
| 41 | Stickers/media | Sticker quote/tag search | reply + tag | medium | Quote bot pattern supports sticker tagging; integrates with sticker_pack carefully. |
| 42 | Text tools | Word/char/line count | reply + `字数` | existing | Already in `chat_toolbox text_stats`; can add reply shortcut. |
| 43 | Text tools | Link extraction digest | reply/range | existing | Already in `chat_toolbox extract_links`; extend to rolling group digest later. |
| 44 | Text tools | Daily link digest | command | medium | Store public HTTP(S) links with titles; no private/local URLs. |
| 45 | Data controls | Stats retention policy | operator config | required | Needed before full analytics: max days, max messages, per-chat off switch. |
| 46 | Data controls | User opt-out/delete | command | required | Required for any passive logging beyond repeater state. |
| 47 | Data controls | Export/backup stats | operator command | medium | Koishi-style backup/restore, but local only. |
| 48 | Data controls | Precise cleanup | operator command | medium | Clean by date/chat/user/type; safer than manual file edits. |

## First Implementation Slice

Recommended order if we implement this family:

1. Add a `chat_stats` or `script_metrics` plugin that records bounded Telegram
   message metadata and text/sticker counters before model admission.
2. Ship cheap text outputs first: hot words, message count leaderboard, message
   type distribution, command usage stats, sticker leaderboard.
3. Add rendered images second: word cloud, activity heatmap, quote card.
4. Add opt-in higher-noise features last: learned replies, cold-room active
   messages, word-chain passive game room, OCR score boards.

## Must Not Do By Default

- No silent mass scheduling or periodic spam.
- No admin punishments such as mute/ban for repeat behavior.
- No cross-group sharing of learned replies or quotes unless explicitly
  configured.
- No indefinite raw message retention.
- No LLM wakeup for passive counters/repeaters.

## References

- Telegram Bot API: https://core.telegram.org/bots/api
- NoneBot word cloud: https://github.com/he0119/nonebot-plugin-wordcloud
- Koishi chat analyse: https://github.com/Koishi-Plugin/chat-analyse
- Koishi repeater: https://github.com/koishijs/koishi-plugin-repeater
- NoneBot learning chat: https://github.com/CMHopeSunshine/nonebot-plugin-learning-chat
- telegram-stats-bot: https://github.com/mkdryden/telegram-stats-bot
- LyoSU quote-bot: https://github.com/LyoSU/quote-bot
- Telegram quote bot: https://github.com/julesvirallinen/telegram-quote-bot
- On9 word chain bot: https://github.com/jonowo/on9wordchainbot
- LDRBot OCR leaderboard: https://github.com/rubasace/ldrbot
- Telegram Reminder Bot: https://github.com/dome272/Telegram-Reminder-Bot
- Telegram periodic message bot: https://github.com/ebellocchia/telegram_periodic_msg_bot
- Birthday reminder bot: https://github.com/Nikfilk2030/birthday_reminder_bot
- Telegram meetup organizer bot: https://github.com/Poeschl/Telegram-Orgabot
