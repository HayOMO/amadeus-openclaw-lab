---
id: inline_gallery_layer
tools: generated_gallery_recent, generated_gallery_search, generated_gallery_resend, web_image_search, download_image_url, download_image_urls, tool_manual_search
keywords: inline, gallery, mini app, deep link, telegram native, image cards, candidate cards, 图库, 候选, 内联, mini app, 入口链接
when_to_read: When designing or simulating Telegram-native gallery/search/prompt-card interactions without adding noisy group messages.
---

# Inline And Gallery Layer

This is a design contract, not a claim that Telegram inline mode or Mini Apps are
currently wired into the bot runtime.

Current practical layer:

- Use `generated_gallery_recent/search/resend` for local generated-image cache.
- Use `web_image_search` plus `download_image_url(s)` for public image candidates.
- Use compact text cards in group chat when real inline cards are unavailable.

Future native Telegram layer:

- Inline mode: `@bot query` returns candidate cards without posting until the
  user chooses one.
- Deep links: feature-specific entry points such as a saved gallery item,
  prompt card, or gacha collection page.
- Mini App: richer UI for gallery browsing, status, memory browsing, and gacha
  collection views.

Do not pretend inline/Mini App is available until the Telegram bot settings and
runtime handler exist. If the user asks for this layer now, propose or implement
the smallest script/runtime bridge first.

Good fallback card format:

```text
[gallery] <short title>
id: <gallery_id or archive_id>
source: generated | downloaded | gacha
action: resend / inspect / use as reference
```

Keep candidate lists short. For image choices, 3-6 cards are usually enough.
