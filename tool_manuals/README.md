---
id: tool_manuals_index
tools: tool_manual_search
keywords: tool manual, tool catalog, skill, rag, index, 工具说明书, 工具目录, 技能, 检索
when_to_read: Entry point for the tool manual library and manual-search behavior.
---

# Imagebot Tool Manuals

These files are the local tool-contract library for `tool_manual_search`.

Keep the global system prompt short. Put tool schemas, capability boundaries,
and usage details here, then retrieve only the relevant section when the model
needs it.

## Tool Catalog

- `image_generate`: create or edit images.
- `image`: load an additional image path/URL that is not already visible to the
  current multimodal model; do not re-inspect native prompt images.
- Provider-native/current-model search may exist without being a normal callable
  tool and remains the default public-search route. Tool-catalog invisibility is
  not a fallback condition; use explicit search only after an actual native
  error/empty/insufficient result or when the current model lacks native search.
- `zhihu`: Zhihu OpenAPI search, Chinese-community lookup, and hot-list lookup.
- `explicit_web_text_search`: bounded generic text-search fallback.
- `web_image_search`: public image-reference search.
- `danbooru_resource`: Danbooru tag/rating/score/favorite-count image lookup
  and optional local download.
- `reverse_image_search`: explicit source, artist, original-post, or same-image
  lookup from an image; not the default first step for ordinary identity questions.
- `download_image_url`, `download_image_urls`: safe public image attachment cache.
- `pixiv_resource`: Pixiv ranking/detail/download helper backed by `gallery-dl`.
- `public_video`: public video metadata, subtitles/transcripts, bounded download,
  and account-site placeholder.
- `telegram_media_spoiler`: Telegram native click-to-view media spoiler delivery
  flag for bot-local visual media.
- `generated_gallery`, `generated_gallery_resend`: find or resend archived
  generated images without regenerating.
- `image_skill`, `image_skill_save_reference`, `image_skill_note_preference`:
  local lightweight character/style reference skills for image generation.
- `meme_transform`: create captioned memes, reaction images, and sticker-style
  WebP outputs from bot-local media.
- `sticker_pack`: prepare, review, publish, inspect, download, copy/import,
  manage Telegram sticker sets, and add received stickers to managed/default
  sets through bounded actions.
- `media_transform`: sharp/libvips deterministic image utilities such as
  compress, convert, resize, crop, rotate, normalize, blur/sharpen, sticker
  WebP, and metadata stripping.
- `web_snapshot`: isolated public-web screenshot and visible-text capture.
- `desktop_media_control`: bounded Windows media-session status and playback
  control for local apps such as NetEase Cloud Music.
- `video_keyframes`, `media_brief`: read small videos, GIFs, and Telegram
  animations.
- `audio_transcribe`: probe/transcribe Telegram voice, audio, or video media.
- `memory_search`: bot-visible user, group, and window memory recall.
- `knowledge`, `knowledge_ingest`: lightweight registry search and local
  note/file ingest for persona, prompt library, memory, and user docs.
- `persona_search`: legacy Amadeus/Kurisu persona notes for explicit old-card
  references.
- `interaction_pipeline`: evaluate Telegram trigger, identity, and window-routing
  policy when group interaction behavior is unclear.
- `feature_catalog`, `feature_action`: manifest-driven mixed LLM/script
  features such as daily check-in.
- `group_adventure`: local d20 fantasy group adventure game with character
  sheets, daily runs, logs, and party ranking.
- `tool_manual_search`: retrieve this manual library.

## Retrieval Rule

- For ordinary chat, do not read manuals.
- Before nontrivial image generation/editing, search `image_generation.md`.
- Before reusing or saving character/style references, search `image_skills.md`.
- Before creating memes/sticker-style media, search `meme_tools.md`.
- Before nontrivial Telegram sticker-set work, search `sticker_pack.md`.
- Before media analysis, search `media_understanding.md`.
- Before transcribing audio, search `audio_transcription.md`.
- Before public search or reference lookup, search `search_and_references.md`.
- Before Pixiv rankings or Pixiv artwork downloads, search `pixiv_resource.md`.
- Before attaching found images, search `downloads_and_albums.md`.
- Before public video URL analysis/download, search `public_video.md`.
- Before resending a previous generated image, search `generated_gallery.md`.
- Before page-visual use, search `practical_tools.md` for `web_snapshot`.
- Before local desktop media playback control, search `desktop_control.md`.
- Before memory/persona-heavy replies, search `memory_and_persona.md`.
- Before broad local资料库 lookup or ingest, search `knowledge_library.md`.
- Before trigger, sender, or window-routing diagnosis, search
  `interaction_core.md`.
- Before mixed stateful features such as check-in, search `feature_core.md`.
- Before local group adventure/D&D-style game actions, search
  `group_adventure.md`.
- For Telegram delivery or group-window confusion, search `telegram_delivery.md`.

Tool manuals explain how to use tools. They do not grant tool availability; the
runtime must still expose the callable tools in the current model request.
