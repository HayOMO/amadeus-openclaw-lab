---
id: telegram_delivery
tools: image_generate, download_image_url, download_image_urls, telegram_media_spoiler, generated_gallery, generated_gallery_resend, memory_search, persona_search
keywords: telegram reply, media attach, MEDIA line, SPOILER_MEDIA, native spoiler, album, send photo, resend image, no image sent, reply target, 发图, 发送图片, 附件, 相册, 合并发送, 遮罩, 打码, 剧透, spoiler, 没发图, 重发, 回复谁
when_to_read: Before a final Telegram reply that sends media, resends media, uses native spoiler, sends an album, or must pick a reply target.
---

# Telegram Delivery Contract

## Reply Target

- Reply to the triggering message/sender.
- If the trigger is a reply to a bot message from another window, stay in that bot-message window.
- Treat shared windows as group threads; no model-visible user is the window owner.
- Attribute text/media/intent to the current sender unless quoted metadata says otherwise.

## Attachment Directives

- `MEDIA:<path>` sends normal bot-local visual media.
- `SPOILER_MEDIA:<path>` sends bot-local visual media with Telegram native click-to-view cover.
- These directives are not prose. Do not wrap them in code fences.
- Do not expose local paths except as `MEDIA:` / `SPOILER_MEDIA:` directive lines.
- Resource tools may return `details.media.outbound=false`; that is model-visible
  media context, not a sent message. Send only by putting the appropriate
  directive in the final reply.

## Native Spoiler

- Tool: `telegram_media_spoiler`.
- Input: bot-local image/GIF/video path or `MEDIA:` line.
- Output: `SPOILER_MEDIA:<path>`.
- Purpose: Telegram delivery flag only.
- It does not inspect, censor, edit, approve, reject, or send pixels.

Use it for user wording such as: 遮罩发图, 打码发, 剧透图, spoiler, NSFW遮罩, 点开看.

## Resend

- If user says image did not arrive / was swallowed / resend / 再发一次 / 上张图没出来:
  1. `generated_gallery action=recent` or `generated_gallery action=search`
  2. `generated_gallery_resend`
- Do not call `image_generate` for pure resend.

## Failure

- If a media tool returns no media, failed, timed out, or aborted: say so briefly.
- Do not claim an image was sent unless a `MEDIA:` / `SPOILER_MEDIA:` directive or structured media result exists.
