# Telegram Chat New Bot Features - 2026-06-30

This pass is restricted to features that are useful inside Telegram chat. Items
already covered by the repo and obvious conflicts such as admin actions, mass
DM, account automation, piracy/resource mirroring, trading, and music playback
are skipped and not counted. These items are backlog candidates, not enabled in
the main runtime config.

Status meanings:

- `todo_candidate`: backlog candidate with a local `chat_toolbox` prototype,
  test coverage, and manual notes. It is not exposed in the main runtime config.
- `skipped_existing`: useful but already existed locally, so not counted here.
- `skipped_conflict`: useful in some bots but outside this bot boundary.

## Merged Evaluation Bundles

The prototype keeps every concrete action below for traceability, but future
evaluation should review the features as 9 grouped bundles rather than 50
separate buttons:

| Bundle | Primary grouped call | Concrete actions covered |
| --- | --- | --- |
| Task state | `chat_toolbox action=task op=add/list/done` | `todo_add`, `todo_list`, `todo_done` |
| Group records | `chat_toolbox action=records kind=note op=save/search` | notes, FAQs, quotes, bookmarks, glossary, snippets |
| Schedule/date | `chat_toolbox action=schedule kind=reminder op=add/due` | reminders, birthdays, events, countdown |
| Local polls | `chat_toolbox action=poll op=create/vote/results` | `poll_create`, `poll_vote`, `poll_results` |
| Randomizers/games | `chat_toolbox action=random kind=dice op=roll` | choice, dice, coin, number, shuffle, teams, lots, RPS, eight-ball |
| Text utilities | `chat_toolbox action=text kind=stats op=run` | text stats, link extraction, unit conversion, timezone conversion |
| Wellness/status | `chat_toolbox action=wellness kind=habit op=checkin/status` | habit and mood helpers |
| Social memory | `chat_toolbox action=social kind=karma op=inc/leaderboard` | karma, seen, tell-message helpers |
| Generic queue | `chat_toolbox action=queue op=join/list` | `queue_join`, `queue_list` |

## Source Order

Sources were taken from popular public bot projects and topic pages, biased
toward chat utility features that can map safely to Telegram group chat:

- GitHub bot topic sorted by stars: https://github.com/topics/bot?o=desc&s=stars
- Red-DiscordBot README: https://github.com/Cog-Creators/Red-DiscordBot
- Limnoria README: https://github.com/ProgVal/Limnoria
- Sopel README: https://github.com/sopel-irc/sopel
- EverydayWechat README: https://github.com/sfyc23/EverydayWechat
- Hubot README: https://github.com/hubotio/hubot

## Backlog Candidate Feature Table

| # | Popular source/context | New Telegram-chat feature | Status | Prototype/reference implementation |
| ---: | --- | --- | --- | --- |
| 1 | Limnoria/Sopel utility bot commands | Group todo add | todo_candidate | `chat_toolbox action=todo_add`, tested in `scripts/TEST_CHAT_TOOLBOX_PLUGIN.mjs`, documented in `tool_manuals/chat_toolbox.md`. |
| 2 | Limnoria/Sopel utility bot commands | Group todo list | todo_candidate | `chat_toolbox action=todo_list`, scoped to Telegram group state. |
| 3 | Limnoria/Sopel utility bot commands | Mark todo done | todo_candidate | `chat_toolbox action=todo_done`, local state mutation only. |
| 4 | Hubot/Limnoria factoid style utilities | Save group note | todo_candidate | `chat_toolbox action=note_save`, local small-note storage. |
| 5 | Hubot/Limnoria factoid style utilities | Search group notes | todo_candidate | `chat_toolbox action=note_search`, bounded local search. |
| 6 | Common support/FAQ bot pattern | Add group FAQ | todo_candidate | `chat_toolbox action=faq_add`, stores question and answer. |
| 7 | Common support/FAQ bot pattern | Search group FAQ | todo_candidate | `chat_toolbox action=faq_search`, returns matched answers. |
| 8 | IRC/Discord quote plugins | Add quote | todo_candidate | `chat_toolbox action=quote_add`, optional author. |
| 9 | IRC/Discord quote plugins | Random quote | todo_candidate | `chat_toolbox action=quote_random`, scoped quote pool. |
| 10 | EverydayWechat timed reminder pattern | Record reminder | todo_candidate | `chat_toolbox action=reminder_add`, inspect-only; does not auto-send. |
| 11 | EverydayWechat timed reminder pattern | Inspect due reminders | todo_candidate | `chat_toolbox action=reminder_due`, no hidden delivery. |
| 12 | EverydayWechat daily message/date pattern | Birthday tracker add | todo_candidate | `chat_toolbox action=birthday_add`, MM-DD storage. |
| 13 | EverydayWechat daily message/date pattern | Next birthdays | todo_candidate | `chat_toolbox action=birthday_next`, sorted local list. |
| 14 | Group calendar/agenda bot pattern | Add group event | todo_candidate | `chat_toolbox action=event_add`, ISO-like date required. |
| 15 | Group calendar/agenda bot pattern | Group agenda | todo_candidate | `chat_toolbox action=event_agenda`, sorted upcoming events. |
| 16 | Red-style community bot utilities | Create local text poll | todo_candidate | `chat_toolbox action=poll_create`, local poll state, not Telegram native poll. |
| 17 | Red-style community bot utilities | Vote in local poll | todo_candidate | `chat_toolbox action=poll_vote`, one vote per user id. |
| 18 | Red-style community bot utilities | Poll results | todo_candidate | `chat_toolbox action=poll_results`, local count summary. |
| 19 | Hubot choose/random scripts | Choose one option | todo_candidate | `chat_toolbox action=choice`, item picker. |
| 20 | IRC/Discord fun commands | Roll dice | todo_candidate | `chat_toolbox action=roll_dice`, bounded sides/count. |
| 21 | IRC/Discord fun commands | Flip coin | todo_candidate | `chat_toolbox action=flip_coin`. |
| 22 | IRC/Discord fun commands | Random number | todo_candidate | `chat_toolbox action=random_number`, bounded min/max. |
| 23 | IRC/Discord fun commands | Shuffle list | todo_candidate | `chat_toolbox action=shuffle`. |
| 24 | Discord/IRC group helper commands | Split teams | todo_candidate | `chat_toolbox action=team_split`. |
| 25 | Discord/IRC group helper commands | Draw lots | todo_candidate | `chat_toolbox action=draw_lots`. |
| 26 | IRC/Discord mini-game commands | Rock paper scissors | todo_candidate | `chat_toolbox action=rps`. |
| 27 | IRC/Discord mini-game commands | Eight-ball answer | todo_candidate | `chat_toolbox action=eight_ball`, toy answer only. |
| 28 | Sopel/Limnoria utility commands | Text stats | todo_candidate | `chat_toolbox action=text_stats`, chars/words/lines. |
| 29 | Sopel/Limnoria URL utilities | Extract links from text | todo_candidate | `chat_toolbox action=extract_links`. |
| 30 | Common bookmark/link bot pattern | Save bookmark | todo_candidate | `chat_toolbox action=bookmark_add`, public HTTP/HTTPS only. |
| 31 | Common bookmark/link bot pattern | Search bookmarks | todo_candidate | `chat_toolbox action=bookmark_search`. |
| 32 | EverydayWechat date/countdown message pattern | Countdown to date | todo_candidate | `chat_toolbox action=countdown`. |
| 33 | Habit/check-in community bots | Habit check-in | todo_candidate | `chat_toolbox action=habit_checkin`, local day record. |
| 34 | Habit/check-in community bots | Habit status | todo_candidate | `chat_toolbox action=habit_status`. |
| 35 | Mood/status bot pattern | Mood log | todo_candidate | `chat_toolbox action=mood_log`. |
| 36 | Mood/status bot pattern | Mood summary | todo_candidate | `chat_toolbox action=mood_summary`. |
| 37 | IRC/Discord karma plugins | Karma increment/decrement | todo_candidate | `chat_toolbox action=karma_inc`. |
| 38 | IRC/Discord karma plugins | Karma leaderboard | todo_candidate | `chat_toolbox action=karma_leaderboard`. |
| 39 | IRC seen plugins | Seen record | todo_candidate | `chat_toolbox action=seen_set`. |
| 40 | IRC seen plugins | Seen lookup | todo_candidate | `chat_toolbox action=seen_get`. |
| 41 | IRC tell plugins | Tell message add | todo_candidate | `chat_toolbox action=tell_add`, local pending message. |
| 42 | IRC tell plugins | Tell message due | todo_candidate | `chat_toolbox action=tell_due`, returns and marks delivered. |
| 43 | Sopel/Limnoria utility commands | Unit conversion | todo_candidate | `chat_toolbox action=unit_convert`, fixed safe unit table. |
| 44 | Sopel/Limnoria utility commands | Timezone conversion | todo_candidate | `chat_toolbox action=timezone_convert`, offset-minute based. |
| 45 | Factoid/glossary bot pattern | Glossary term add | todo_candidate | `chat_toolbox action=glossary_add`. |
| 46 | Factoid/glossary bot pattern | Glossary search | todo_candidate | `chat_toolbox action=glossary_search`. |
| 47 | Hubot/Sopel custom reply snippets | Save reusable snippet | todo_candidate | `chat_toolbox action=snippet_save`. |
| 48 | Hubot/Sopel custom reply snippets | Search reusable snippets | todo_candidate | `chat_toolbox action=snippet_search`. |
| 49 | Red music queue idea adapted safely | Queue join | todo_candidate | `chat_toolbox action=queue_join`, generic local queue, no music playback. |
| 50 | Red music queue idea adapted safely | Queue list | todo_candidate | `chat_toolbox action=queue_list`, generic local queue display. |

## Skipped Examples

- Red moderation/admin actions, reaction roles, ban sync, and slow mode:
  skipped as admin/control actions.
- Red music playback and stream alerts: skipped because Telegram chat has no
  current voice-session/music runtime in this project.
- EverydayWechat auto-send and auto-reply-all: adapted only as local reminder
  and note/state features; hidden automatic delivery is skipped.
- Resource sharing/movie index/mirroring: skipped as copyright and storage risk.

## Verification

```powershell
node scripts/TEST_CHAT_TOOLBOX_PLUGIN.mjs
npm run lint:config
node scripts/TEST_AGENT_ARCHITECTURE_CONTRACT.mjs
```
