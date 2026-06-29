---
id: downloads_and_albums
tools: download_image_url, download_image_urls, telegram_media_spoiler, web_image_search, reverse_image_search
keywords: download image, attach image, send album, found images, image urls, save image, visual preview, 下载图片, 发图, 找图, 来几张图, 相册, 多图合并, 一起发, 现成图片, 图片链接, 保存图片, 遮罩发图, spoiler
when_to_read: Before downloading public images, attaching found images, or sending 2-10 images as a Telegram album.
---

# Downloads And Albums Contract

## Scope

- Use for existing public image URLs only: `http/https` jpg/png/webp/gif.
- Do not use for image generation.
- Do not use for local/private/internal/login-only URLs.

## Found-Image Flow

1. `web_image_search`
2. Select likely candidates.
3. `download_image_url` for one image, or `download_image_urls` for 2-10.
4. Inspect returned visual preview when relevance/safety matters.
5. Final reply uses returned `MEDIA:` lines or `SPOILER_MEDIA:` lines.

## Download Tools

- `download_image_url`: one public image.
- `download_image_urls`: 2-10 public images, album-friendly.
- `transport:auto`: default; may use HTTP, public mirrors, or bot-owned isolated browser.
- `transport:browser`: use when host blocks HTTP/hotlinking.
- `refererUrl`: pass source/post page when available.
- For slow/big/batch jobs, use `background:true`.

## Visual Preview

- Returned preview images are model-visible context.
- Use preview + source metadata before choosing ordinary media vs spoiler media.
- Resource/download tools do not auto-send media. Their `details.media` is a
  structured descriptor; Telegram delivery happens only when the final reply
  includes `MEDIA:` / `SPOILER_MEDIA:` lines.

## Album

- Include every returned media directive in one final reply.
- Telegram sends 2-10 compatible images as an album when possible.
- If more than 10 images are requested, tool/request layer must cap or split; do not loop tool calls blindly.
