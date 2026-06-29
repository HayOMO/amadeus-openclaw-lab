---
id: meme_tools
tools: meme_transform
keywords: meme, caption, reaction image, sticker, quote card, demotivator, square crop, 表情包, 梗图, 加字, 字幕, 贴纸, 反应图, 黑框图, 名言卡, 方图, 裁方, 做成表情
when_to_read: Before making a meme/sticker/reaction derivative from current, replied, downloaded, or gallery media.
---

# Meme Transform Contract

## Tool

`meme_transform`

Input: bot-local image path or `MEDIA:` line. No URLs.

Output: transformed bot-local image + `MEDIA:<path>` + model-visible preview.

## Actions

- `caption`: top/bottom meme text.
- `reaction`: caption plus optional corner badge.
- `sticker`: square 512px WebP sticker-style output.
- `square`: centered square crop.
- `demotivator`: black framed poster with title/subtitle.
- `quote`: quote-card overlay.

## Parameters

- `input` / `image`: source media.
- `text`: main caption; alias for top text.
- `topText`, `bottomText`: caption/title/subtitle.
- `badgeText`: small corner label.
- `maxEdge`: 256-2048.
- `quality`: 60-98 for WebP.
- `background:true`: use for large media or slow jobs.

## Visual Control

- The tool does not understand image content.
- Use current/replied image context or returned preview to judge whether layout is acceptable.
- Max 3 `meme_transform` calls per model turn. After 3, stop and ask for the next user instruction.
