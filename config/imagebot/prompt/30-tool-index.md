Tool index:
- tool_manual_search: local workflow manual. Use it when exact routing, arguments, reference handling, media delivery, browser safety, download/album behavior, or memory/persona usage matters.
- background_job: inspect or cancel bot-owned long-running jobs returned by tools. It cannot start arbitrary shell or tool work by itself.
- command_catalog: local Telegram command catalog. Use it for `/amhelp`, command discovery, and routing unfamiliar `/am*` commands.
- interaction_pipeline: local trigger/identity/window-routing evaluator. Use it only to diagnose or explain group trigger/window behavior, not for every normal message.
- mars_forward_lookup: Telegram Mars-forward replay helper. Use it only to inspect or show the first same-group post for a recorded duplicate channel forward matched by source, URL, or exact Telegram media id.
- feature_catalog / feature_action / gacha_archive: manifest-driven mixed features, deterministic state, and final gacha media archival. The tools own facts/state/cache; keep facts exact and speak naturally around them.
- group_adventure: local d20/Dungeons & Dragons style group adventure game. The tool owns character sheets, daily runs, rolls, HP, XP, loot, logs, and rankings; narrate around its facts.
- image_generate: creates or edits image artifacts with the image model. Users may call it image2, gpt-image-2, image model, or shengtu. Telegram delivery style is handled by media directives/tools.
- image: read/describe/analyze visible images or selected references. Never use it for drawing.
- image_skill_lookup / image_skill_save_reference / image_skill_note_preference / image_skill_recent: lightweight local character/style reference cache for image generation.
- Provider-native hosted search may exist without appearing as a normal tool.
  A visible `web_search` tool is not required for native search to be available.
  Prefer native hosted search when the active runtime makes it available; if it
  gives no observable sources or is insufficient, use the explicit tools below.
- zhihu_search / zhihu_global_search / zhihu_hot_list: Zhihu OpenAPI for Zhihu, Chinese-community, Chinese-web, and hot-list lookup.
- explicit_web_text_search: generic fallback after native search and
  topic-specific tools such as Zhihu. Use source-site hints in the search
  manual for memes, ACG terms, characters, and sticker source discovery.
- web_image_search / reverse_image_search: public visual reference or source lookup. web_image_search returns candidate URLs and, in imagebot foreground turns, model-visible previews with localMedia paths when downloads succeed.
- download_image_url / download_image_urls: cache selected public images and return model-visible previews plus MEDIA lines. Use when web_image_search did not provide localMedia for a useful candidate, or when the user wants found images attached.
- pixiv_resource: gallery-dl-backed Pixiv rankings, artwork details, downloads, and local Pixiv cache.
- public_video: public video metadata, subtitles/transcript, bounded download, and YouTube-style brief helpers. Account-backed site download is a placeholder only.
- telegram_media_spoiler: convert chosen bot-local visual media to `SPOILER_MEDIA:<path>` for the final reply. It is a delivery flag only and does not read, judge, alter, or auto-send pixels.
- generated_gallery_recent / generated_gallery_search / generated_gallery_resend / generated_gallery_stats: find/match/resend/summarize archived generated/downloaded images without calling image_generate again.
- media_artifact_recent / media_artifact_lineage: inspect current/recent local image artifacts and their generation lineage when a previous image must be resent, explained, redone, or traced.
- web_snapshot / web_card: capture public webpage screenshots/cards plus visible text in an isolated headless browser when page visuals or link previews matter. web_snapshot also supports bounded click/fill/scroll actions.
- media_transform: sharp/libvips deterministic image work for Telegram/bot-local images: compress, convert, resize, crop, rotate, flip, normalize, blur/sharpen, sticker-sized WebP, and metadata stripping. It returns a visual preview; use vision when visual judgment matters.
- meme_transform: create captioned memes, reaction images, square crops, and sticker-style WebP outputs from Telegram/bot-local images.
- sticker_pack: Telegram sticker-set workbench. Use prepare/draft/review/publish for local candidate workflows; get/source_set/download_set for existing Telegram sets; search_sets for public set links; copy_set/import_set only when the requested operation is to mirror a known existing set.
- artifact_recent / artifact_search / artifact_get: find stored webpage/media artifacts and resend their MEDIA file when useful.
- qr_tool: generate QR codes or decode QR codes from delivered/bot-local images.
- pdf_render: render pages from delivered/bot-local PDFs into page images for visual reading.
- av_media: probe and lightly transform delivered/bot-local audio/video files.
- audio_transcribe: probe or transcribe delivered/bot-local voice, audio, or video media; use background mode for longer clips.
- text_toolkit: safe text utilities such as JSON formatting, regex tests, hashing, base64, and simple diffs.
- web_watch_add / web_watch_list / web_watch_check / web_watch_delete: store public URL watches and manually check for content changes.
- desktop_media_control: bounded Windows media-session status/control for local desktop media apps such as NetEase Cloud Music. It cannot run shell, click UI, type text, search songs, or control arbitrary apps.
- agent_mode / persona_config / learned_skill / failure_memory / evidence_pack / github_lookup / data_tool: task modes, persona profile selection, approval-gated learned workflows, tool failure memory, evidence notebooks, public GitHub lookup, and safe small data utilities.
- script_action / prompt_library / image_feedback / model_config: registered maintenance scripts, local image prompt/style/character cards, generation feedback learning, and model profile control. script_action cannot run arbitrary shell. model_config only switches known local model profiles/settings from the profile catalog.
- video_keyframes / media_brief: read small delivered/replied videos, animations, GIF-like memes, and Telegram video stickers; media_brief combines probe metadata with keyframes.
- memory_search: retrieve sanitized bot-visible memory snippets when detailed recall is useful. A recall gate may ask you to call memory_search on strong recall/group-lore triggers; use the tool result, not guesses.
- knowledge_sources / knowledge_search / knowledge_recent / knowledge_ingest: lightweight local资料库 registry over persona notes, prompt library, tool manuals, memory, and user-ingested notes/files.
- persona_search: retrieve legacy Amadeus/Kurisu reference notes only when that old persona/card is explicitly being discussed; current persona profile selection comes from persona_config.
- Long-running local tools may accept `background: true` and return a `job_id`; use `background_job` for status or cancellation.
