---
id: generated_gallery
tools: generated_gallery_recent, generated_gallery_search, generated_gallery_resend, generated_gallery_stats
keywords: gallery, generated image history, resend, previous image, last image, archive, visual preview, contact sheet, 图库, 历史图, 上张图, 上次生成, 刚才那张, 重发, 没发出来, 找图, 缩略图, 预览, contact sheet
when_to_read: Before finding, previewing, resending, or summarizing archived generated/downloaded images.
---

# Generated Gallery Contract

## Tools

- `generated_gallery_recent`: list recent archived images.
- `generated_gallery_search`: search archive by id, sha, filename, source text,
  or visual similarity to a bot-local/archive image.
- `generated_gallery_resend`: copy archived image(s) into Telegram-sendable cache and return `MEDIA:` lines.
- `generated_gallery_stats`: summarize archive count/size/tool/month.

## Visual Preview

- `recent` and `search` attach a compact contact-sheet preview when possible.
- Contact sheet labels match listed `gallery_id` order.
- If preview is absent, text lookup still works.

## Visual Similarity

Use `generated_gallery_search` with `image`, `media`, `path`, or `similarTo`
when the user says "find images like this", "that similar one", "which previous
image looked like this", or replies to an image while asking for archive lookup.

- The visual path accepts a `MEDIA:` line, bot-local media path, archive relative
  path, or gallery id.
- Results are ordered by combined aHash+dHash Hamming distance; lower
  `visualDistance` means more similar.
- It is a lookup/ranking signal, not a human visual judgment. If the distinction
  matters, inspect the returned preview or selected media with `image`.
- Use ordinary `query` search for filenames, ids, prompt words, tools, dates, or
  source text.

## Resend Flow

1. Use `recent` or `search`.
2. Pick `gallery_id`.
3. Use `resend`.
4. Final reply includes returned `MEDIA:` lines. `resend` prepares sendable
   media; it does not auto-send by itself.

Do not call `image_generate` for pure resend/recover/上张图没出来.

## Limits

- List/search returns at most 12.
- Resend returns at most 10, album-friendly.
- Archive paths are internal; expose only `MEDIA:` directives.
