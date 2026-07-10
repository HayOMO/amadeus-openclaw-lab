---
id: media_understanding
tools: image, media_brief, video_keyframes, audio_transcribe, public_video, reverse_image_search, web_image_search, image_generate, meme_transform
keywords: read image, describe image, sticker, meme, gif, video, animation, keyframes, source image, OCR, 看图, 识图, 读图, 描述图片, 表情包, 贴图, 动图, 视频, 抽帧, 出处, 来源, 识别梗图
when_to_read: Before analyzing Telegram images, stickers, GIFs, animations, short videos, or image-source questions.
---

# Media Understanding Contract

## Static Images / Stickers

- The runtime routes inbound images by current session model capability.
  Native-vision chat models can consume images directly; text-only models use
  `image` first to receive textual visual context.
- When an image is already visible in the current native multimodal input,
  inspect it directly for visible facts, text, style, objects, identity,
  composition, and safety. Do not call `image` again as a first step, a
  confidence check, or a second description pass.
- Use `image` only to load an additional image path/URL that is not present in
  the current visual context, or when the current model did not receive usable
  visual input. A separate focused question about an already visible image does
  not by itself justify another tool call.
- Telegram static stickers are usually `.webp` and follow this image path.
- Replied Telegram stickers can expose `ReplySticker` metadata plus a
  `ReplyMediaPaths` local file. Use `ReplySticker.format` / `isVideo` to tell
  static WebP, animated TGS, and video WEBM stickers apart.
- Start with observable facts; mark uncertain identity/source guesses.
- Pure meme/sticker reactions can be brief group-chat replies.

## Vision Context Gate

- Telegram image media and tool-result image previews pass through one local
  vision-context gate before they enter model visual context.
- Tools that return bot-local image paths through `MEDIA:` or `details.media`
  may have compact image previews attached automatically, so inspect the visible
  image when it is present instead of relying only on path text.
- This is not a general NSFW block: ordinary adult NSFW without a loli signal can
  still be inspected when allowed by the surrounding workflow.
- The guard is intentionally narrow: it matches loli text/tag signals, not broad
  non-loli wording.
- When the guard withholds an image, rely on the safety-review note and visible
  text only; do not infer or describe hidden image details.
- If the local image preflight fails, Telegram image attachments are also
  withheld from visual context and replaced with a safety-review note.

## Edit / Redraw / Meme

- User asks to edit/redraw/create from the image: use `image_generate`.
- User asks to make a meme/sticker/reaction derivative: use `meme_transform`.
- User asks source/artist/original: use `reverse_image_search`.

## Videos / GIFs / Animations

- `media_brief`: probe metadata + keyframe contact sheet.
- `public_video`: for public video URLs before local frame/audio analysis.
- `audio_transcribe`: speech-to-text for voice/audio/video when the user asks what was said.
- `video_keyframes`: contact sheet only.
- Use for Telegram animations, GIF-like memes, video notes, short clips, and
  Telegram video stickers saved as `.webm`.
- For slow clips, pass `background:true`.
- If extraction fails, say briefly; do not loop extraction attempts.
