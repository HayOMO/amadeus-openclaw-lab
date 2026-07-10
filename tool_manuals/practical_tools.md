---
id: practical_tools
tools: web_snapshot, web_card, media_transform, qr_tool, pdf_render, av_media, audio_transcribe, public_video, sticker_pack, text_toolkit, artifact, web_watch_add, web_watch_list, web_watch_check, web_watch_delete
keywords: webpage screenshot, web snapshot, url preview, public page, page visual, compress image, convert image, resize image, crop, sticker, remove exif, QR, barcode, PDF render, audio video, gif, extract audio, web watch, artifact, 网页截图, 链接预览, 页面截图, 压缩图片, 转格式, 改尺寸, 裁剪, 去元数据, 二维码, PDF截图, 音频, 视频, 动图, 网页监控, 工具产物
when_to_read: Before webpage screenshots, URL previews, image utility transforms, QR/PDF/audio-video utilities, artifact lookup, or public webpage watches.
---

# Practical Tools Contract

## Web

- `web_card`: fast URL preview; title, URL, description/headings, short text, screenshot.
- `web_snapshot`: public webpage screenshot + visible text + optional bounded actions.
- Allowed actions: `click_text`, `click_selector`, `fill_selector`, `press`, `scroll`, `wait`.
- For source lookup, an already-open interactive browser tab is usually the
  better continuation. `web_card` / `web_snapshot` are useful for quick URL
  triage, simple page reads, or saving a screenshot artifact. When comparing a
  saved page screenshot with the user's original image, compare them directly
  if both are already visible. Call `image` only for an extra path that is not
  present in the current visual context.
- Treat those actions as page-reading moves and perform them yourself for public
  pages. Use `click_text` for visible tabs, links, buttons, comments, images,
  albums, next/next page, expand, sort, language, or load more.
  Use `fill_selector` + `press` for a public search/filter box on the page.
  Use `wait` after navigation or a click.
- For "scroll down", "continue below", long pages, or lazy/infinite pages, call
  `web_snapshot` again with `scrollMode:"one_page"`, `scrollMode:"paged"`,
  `scrollMode:"bottom"`, or an absolute `scrollY`. Use the returned
  `scroll: y=current/max` to decide whether more page remains; continue with a
  bounded next pass when the user's answer depends on content below.
- `fullPage:true` captures the loaded document height; it is not a substitute
  for bounded scroll on lazy-loading pages.
- If the result says `risk_status` such as Cloudflare/captcha/login
  verification, that result is a blocked-source state rather than target-page
  evidence. Use another public source, hosted search, official API/page, or ask
  for manual verification.
- Public `http/https` only. No local/private/internal/file URLs.
- Ordinary public pages use a fresh Playwright context per call, so cookies and
  localStorage do not persist.
- Navigations and subresources are checked against the same public-network
  boundary.
- These lightweight readers are isolated and never inherit the Bot profile's
  cookies. The full `browser` tool defaults to `bot` and can explicitly select
  `isolated` when separate browser state is useful.
- Use `fullPage:true` only when needed.

## Image Utility

- `media_transform`: bot-local image transform.
- Actions: compress, convert, resize, crop, rotate, flip, flop, normalize, grayscale, blur, sharpen, sticker, strip_exif.
- Media inputs can be bot-local paths, `MEDIA:` lines, `media://...` URIs, or
  current/reply handles such as `current.image.0` / `reply.image.0` when those
  handles are listed in the current media context. The runtime resolves handles
  before the tool executes.
- Output includes `MEDIA:<path>` and model-visible preview.
- Tool outputs prepare sendable media; final Telegram delivery still requires
  the returned `MEDIA:` line in the final reply.
- Use for deterministic utility edits, not creative redraws.
- Telegram native spoiler is not an image transform; use `telegram_media_spoiler`.
- Max 3 calls per model turn; then stop and ask.

## PDF

- `pdf_render`: render 1-6 PDF pages into PNG/contact sheet.
- Use for scanned PDFs, figures, equations, tables, or layout-sensitive pages.
- For many pages, render selected pages or use `background:true`.

## Audio / Video

- `av_media`: probe, extract_audio, compress_video, to_gif.
- `audio_transcribe`: probe/transcribe bot-local voice, audio, or video media.
- `pdf_render`, `av_media`, `audio_transcribe`, and `qr_tool action=decode`
  accept the same bot-local path / `MEDIA:` / `media://...` / current-reply
  handle forms for their media input parameters.
- `public_video`: metadata, subtitles/transcripts, or bounded downloads for public video URLs.
- `sticker_pack`: prepare/review/publish local sticker candidates, inspect or
  download known Telegram sets, maintain managed/default set targets, add
  received stickers to those targets, and copy/import only as an explicit
  set-mirroring action.
- `video_keyframes` / `media_brief`: use for visual understanding of clips.
- Use `background:true` for slow media jobs.

## Text Toolkit

- `text_toolkit`: JSON format/minify, hash, base64, regex test, and small line
  diffs.
- Regex tests run in a bounded worker. If a pattern is too slow, report the
  timeout and ask for a narrower pattern instead of retrying variants.

## QR

- `qr_tool action=generate`: text/URL -> QR image.
- `qr_tool action=decode`: image -> decoded QR/barcode text.

## Artifacts

- Runtime artifact lookup is scoped to the current trusted chat/session/window.
  Another scope's artifact id behaves like no match. Local maintenance calls
  without runtime context can still inspect the legacy/global artifact log.

- `artifact action=recent/search/get`: recover recent web/media tool outputs.
- Use when user says 上次那个网页, 刚才截图, 压缩后的图, 工具产物.

## Web Watch

- `web_watch_add/list/check/delete`: manual public URL digest checks.
- No silent background notifications.
