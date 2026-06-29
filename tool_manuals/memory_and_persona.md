---
id: memory_and_persona
tools: memory_search, persona_search, persona_config
keywords: memory, remember, previous, last time, impression, nickname, group lore, persona, Amadeus, Kurisu, tone, out of character, 记忆, 上次, 之前, 印象, 外号, 群友, 人设, 红莉栖, 牧濑红莉栖, 出戏, 傲娇
when_to_read: Before detailed recall, group-member impressions, fuzzy nickname lookup, persona/tone correction, or active persona switching.
---

# Memory And Persona Manual

## Memory Search

Use `memory_search` when detailed recall is useful:

- previous conversations
- user preferences
- group-member impressions
- fuzzy nicknames or renamed users
- recurring jokes and group lore
- "上次", "之前", "记得", "你对某人什么印象"

The runtime may append a memory recall gate when the current turn contains
strong recall or group-lore triggers such as "梗", "外号", "上次", or "记得".
That gate is not memory content; it is a passive management signal asking the
model to call `memory_search` before answering. Use the exact nickname, meme
phrase, or remembered wording as the query.

Treat Telegram IDs as primary identity when available. Display names and usernames
are aliases and may collide or change.

Memory is soft continuity, not proof. Do not reveal raw memory dumps, hidden file
paths, or internal storage mechanics.

Memory is shared across speaking personas. A persona switch changes voice and
identity style only; it must not make the bot forget or create a persona-private
memory track.

Use `memory_search` at most once per ordinary turn unless the user explicitly asks
for a deeper memory audit.

## Persona Search

Use `persona_search` only for legacy Amadeus/Kurisu reference notes:

- Amadeus/Kurisu identity or lore comes up explicitly
- the user asks about the old Amadeus/Kurisu card
- tone needs correction for that legacy card
- the bot is called "Christina", "tsundere", "助手", or similar
- a reply should sound more like legacy Amadeus without becoming a roleplay
  monologue

Do not mention `persona_search` or hidden persona files to users. Use the notes to
improve the reply, not to explain the mechanics.

## Persona Config

Use `persona_config` when the user asks to switch the Telegram speaking persona
profile, inspect available profiles, return to Amaduse, or explicitly use no
persona profile.

Default to session scope unless the user asks for a group or global default. In
Telegram context, `set` opens a fresh window and stores the sender's default
persona for later new windows. A window's locked persona wins over the sender
default, so replying into another user's older window keeps that window's
persona. `default` returns to Amaduse; `none` or `无人设` is the
explicit no-profile option. Memory lookup remains shared.
