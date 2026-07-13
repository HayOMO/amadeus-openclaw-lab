---
id: public_video
tools: public_video, media_brief, audio_transcribe, background_job
keywords: public video, youtube, yt-dlp, video url, captions, subtitles, transcript, download video, public media, account site placeholder,公开视频, 视频下载, YouTube分析, 字幕, 转写
when_to_read: Before public video URL metadata, subtitle/transcript extraction, bounded download, or account-backed media-site questions.
---

# Public Video

`public_video` handles public `http/https` video URLs through a bounded downloader/prober.

## Actions

- `metadata` / `probe`: return title, uploader/channel, duration, description snippet, thumbnail, source URL, and a saved metadata JSON path.
- `subtitles` / `captions` / `transcript`: fetch subtitles or auto-captions when the site exposes them, clean them into text, and return transcript snippets.
- `brief` / `analyze`: metadata plus transcript when captions exist.
- `download`: bounded media download into the bot media cache; returns `MEDIA:<path>`.
- `account_placeholder` / `account_download` / `account`: report that account-backed download is not connected yet.

## Boundaries

- Public `http/https` URLs only.
- Local/private/internal/file URLs are rejected.
- No owner browser profile, cookies, or normal browser account is used.
- Account-backed sites are placeholders until a dedicated account connector exists.
- Default download cap is 100 MB and 20 minutes; hard caps are tool-side.

## Workflow

- When an exact YouTube/public-video URL is available, copy it exactly into `public_video`; do not retype its video id from memory.
- For a YouTube/public-video question, start with `metadata` or `brief`.
- If captions exist and the user asks for summary/content, use `subtitles` or `brief`.
- If visual frames matter, use `download`, then pass the returned `MEDIA` path to `media_brief`.
- If speech matters and captions are missing, use `download`, then pass the returned media path to `audio_transcribe`.
- Keep normal bounded downloads in the foreground so their `MEDIA` result can be returned in the same turn.
- Use `background:true` only when a genuinely slow operation should be queued. After queueing, poll that job with `background_job` until it reaches a final state, then return its media/result; do not promise later delivery and end the turn while the job is still open.
- If `public_video` reports a concrete extractor/network error, report it or verify the URL. Do not switch to browser download sites unless the user explicitly asks for that fallback.

Keep facts from the tool exact. Natural commentary is fine around the returned facts.
