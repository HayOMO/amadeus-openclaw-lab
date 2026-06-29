# Feature Expansion Plan

This plan captures the next product direction for Amaduse after the current
Telegram imagebot foundation. The target is a private, high-trust, high-fun
agent that can later grow into real local production work without turning every
feature into a fragile one-off.

## Operating Assumptions

- This is a private bot for the owner and trusted groups, not a public hosted
  bot.
- Optimize for capability and product feel first, with a few hard safety rails:
  no tokens, no arbitrary shell, no gateway self-administration, no owner browser
  profile, and no arbitrary local-path exfiltration.
- LLM behavior should stay flexible. Deterministic limits live in tools,
  scripts, queues, and send layers.
- Natural-language abilities should be model-selected tools. Slash commands are
  only for deterministic control/script actions.
- Long-running work should be able to run in background jobs when the tool can
  support it cleanly.

## References Checked

- Telegram Bot API: file delivery can reuse Telegram `file_id`, fetch public
  URLs, or upload multipart files; richer media/sticker/album work should stay
  aligned with Bot API surfaces.
- OpenClaw Telegram channel docs: Telegram routing is gateway-owned, replies are
  deterministic, group/topic sessions are isolated, and long polling uses
  grammY runner with per-chat/per-thread sequencing plus global agent
  concurrency.
- grammY runner docs: concurrent processing works best when sequential
  constraints are explicit for the dimensions that need ordering.

## Current Repo Surfaces To Reuse

- `plugins/imagebot-media-artifacts`: media context and lineage hooks.
- `plugins/imagebot-generated-gallery`: generated/downloaded image archive and
  resend.
- `plugins/imagebot-practical-tools`: web snapshot, media transform, QR, PDF,
  AV, text, artifact lookup, webpage watch.
- `plugins/imagebot-video-utils`: small video/GIF keyframe extraction.
- `plugins/imagebot-public-video`: public video metadata, subtitle/transcript,
  and bounded URL download.
- `plugins/imagebot-memory-search`: existing memory search and prewarm.
- `plugins/imagebot-turn-observer`: sanitized turn/tool/message observability.
- `plugins/imagebot-persona-search`: persona/lore reference search.
- `plugins/imagebot-background-jobs`: shared async job queue.
- `plugins/imagebot-feature-core`: stateful playful/script-like features.
- `tool_manuals/*`: model-facing tool contracts.
- `config/imagebot/settings.json`: allowlist, plugin registration, concurrency,
  and browser pool.

## Priority 1: Lightweight Image Skill Cache

Goal: make character/image generation smarter without a heavy skill framework.

Core idea:

- When Amaduse has drawn or referenced a character before, store a compact local
  character skill: aliases, reference image handles, source URLs, short visual
  traits, user preferences, and known prompt hints.
- On future named-character generation, the model can look up the local skill
  first and reuse references instead of searching from scratch.
- Image generation prompts stay short because `gpt-image-2` should receive a
  small prompt plus actual reference images where useful.

Suggested implementation:

- Add `plugins/imagebot-image-skills`.
- Store local state under `~/.openclaw/imagebot-image-skills`.
- Tools:
  - `image_skill_lookup`: find character/style/user preference snippets.
  - `image_skill_save_reference`: save a user-approved reference or search
    result into a character skill.
  - `image_skill_note_preference`: record lightweight per-user preferences such
    as "likes official outfit", "prefers softer color", or "avoid chibi".
  - `image_skill_recent`: inspect recent saved skills for debugging.
- Manual: `tool_manuals/image_skills.md`.
- Tests:
  - alias lookup;
  - path/root validation;
  - duplicate reference dedupe;
  - per-user preference isolation;
  - generated config allowlist.

First pass is lexical/tag based, with CJK alias/token matching. Add heavier
visual/semantic matching only after the saved skill format proves useful.

## Priority 2: Meme And Sticker Workbench

Goal: make common Telegram image play fast and fun, with LLM-guided decisions
but deterministic image processing.

Core idea:

- The LLM decides caption, crop intent, meme style, and whether a still/GIF/video
  conversion makes sense.
- The tool performs actual image/video operations with fixed limits and returns
  Telegram-sendable media.

Suggested implementation:

- Extend `plugins/imagebot-practical-tools` first unless the code becomes too
  large, then split into `plugins/imagebot-meme-tools`.
- Tools or actions:
  - add text caption/top-bottom meme text;
  - make 512px sticker-style WebP;
  - crop/resize to Telegram-friendly square/portrait variants;
  - GIF to sticker-like WebP/MP4 preview when feasible;
  - quick reaction image from replied media and short text.
- Use existing `media_transform` for simple resize/convert/compress.
- Add a focused `meme_transform` only if text layout/template logic becomes
  awkward inside `media_transform`.
- Tests:
  - static image caption;
  - sticker-size WebP output;
  - rejected non-bot-local input path;
  - background mode for heavier GIF/video conversion;
  - final `MEDIA:` output shape.

Telegram sticker-pack management now exists as a bounded tool. It prepares
static WebP stickers, accepts compliant TGS/WEBM sticker assets, tracks
managed/default target sets, and manages sticker sets created by this bot;
arbitrary Telegram administration remains outside this feature.

## Priority 3: Knowledge Library Upgrade

Goal: unify persona notes, long-term memory, user/group impressions, and future
drop-in document libraries without making every retrieval path bespoke.

Current state:

- Persona and memory already exist as separate searchable sources.
- Practical tools already store artifacts.
- The next problem is smoother source selection and faster lookup, not one giant
merged database.

Suggested implementation:

- Add a small registry layer rather than moving all data:
  - `knowledge_source` records: id, kind, root/path, privacy label, index status.
  - Adapters for persona, memory, prompt library, artifact metadata, and a future
    user-provided docs folder.
- Tools:
  - `knowledge_search`: search selected source kinds with compact results.
  - `knowledge_recent`: recent indexed docs/artifacts.
  - `knowledge_ingest`: ingest files from bot workspace or user-delivered files.
- Keep existing `memory_search` and `persona_search` alive initially; the
  registry can route to them instead of replacing them.
- Speed approach:
  - cheap lexical search first;
  - optional local semantic index with background warming;
  - small top-k context, not huge raw dumps.
- Tests:
  - registry loads sources;
  - source privacy labels are preserved;
  - search result clipping;
  - missing/empty source fallback;
  - prewarm does not block gateway startup.

## Priority 4: Video, GIF, And Audio Understanding

Goal: make small Telegram videos/GIFs feel like normal multimodal context, while
keeping the first pass lightweight.

Current state:

- `video_keyframes` already extracts a contact sheet from small bot-local video.
- `av_media` already probes/compresses/extracts audio/converts short GIFs.

Suggested upgrades:

- Improve acceptance and routing for Telegram animations, GIF-like videos, video
  notes, and small clips.
- Add a "media brief" result that combines probe metadata plus keyframes.
- Add optional audio extraction output and local ASR transcription for voice,
  audio, and video media.
- Support background mode for clips likely to exceed normal response time.
- Tests:
  - static GIF/animation path;
  - video note/small MP4 path;
  - too-large rejection message;
  - background job path;
  - model-visible `MEDIA:` contact sheet output.

Public video URL support now exists behind `imagebot-public-video`: metadata,
captions/transcripts, and bounded downloads. Account-backed sites remain a
placeholder until a dedicated account connector exists.

## Priority 5: Background UX Polish

Goal: make long work feel alive without spamming.

Suggested implementation:

- Reuse `background_job`.
- Add small status text for long tools where OpenClaw/tool path supports it:
  queued, active, progress note, completed, failed.
- Prefer one editable status message per turn. Avoid multiple "working..."
  messages.
- Add timeout/stale-job summaries that tell the user what can be retried.
- Tests:
  - duplicate status suppression;
  - cancelled job;
  - failed job summary;
  - recent-job listing.

## Priority 6: LLM-Hosted Games And Playful Scripts

Goal: use deterministic engines for state and LLM for hosting, flavor, judging,
and social texture.

First candidates:

- Prompt duel / image prompt arena.
- Guess-the-image from cropped or blurred media.
- AI judge for "which one is more cursed".
- Lightweight daily experiment / lab omen variants.
- Simple card/collection extensions on top of gacha.

Later candidates:

- Poker or other multi-player card games, after model switching and faster
  provider support are easier.

Implementation path:

- Use `features/*.json` and `imagebot-feature-core`.
- Deterministic state and scoring in scripts.
- LLM gets structured facts and hosts naturally.
- Tests should simulate two users and repeated calls.

## Suggested Development Order

1. Add `imagebot-image-skills` MVP.
2. Extend or split meme/sticker workbench.
3. Add knowledge registry MVP while keeping current memory/persona search.
4. Upgrade video/GIF/media brief path.
5. Polish background UX for the long-running tools above.
6. Add one LLM-hosted game as a proof of the feature pattern.

This order builds reusable substrate first: media references, image operations,
knowledge lookup, background work, then games.

## MVP Status

Implemented in the first expansion pass:

- `imagebot-image-skills`: local character/style reference and preference cache.
- `imagebot-meme-tools`: `meme_transform` for caption, reaction, square, and
  sticker-style WebP outputs.
- `imagebot-sticker-pack`: static sticker preparation plus Telegram Bot API
  management for bot-created sticker sets.
- `imagebot-audio-transcribe`: bounded local audio/video probe and Whisper-style
  ASR transcription.
- `imagebot-public-video`: public video metadata, subtitle/transcript, and
  bounded download helper; account-backed site download is placeholder-only.
- `imagebot-group-adventure`: independent D20 fantasy group adventure game with
  character sheets, daily runs, logs, party ranking, and model-hosted narration.
- `imagebot-knowledge-library`: source registry, search, recent docs, and local
  text ingest; `knowledge_search` now supports `hybrid`, `keyword`, and
  explicit `semantic` modes with a local embedding index.
- `imagebot-video-utils`: `media_brief` combining probe metadata and keyframes.
- `imagebot-background-jobs`: `summary` action for compact queue/status review.
- `imagebot-turn-observer`: sanitized recent turn/tool/message records for
  debugging missing replies, repeated tools, and media send confusion.
- `scripts/REPLAY_TELEGRAM_TURNS.mjs`: deterministic trigger/window-routing
  replay fixtures for `/amnew`, prefixes, mentions, replies, and ignored media.
- `policy/capability_surface.json`: machine-readable boundary for allowed
  Telegram, filesystem, network, and diagnostic surfaces.
- `generated_gallery_search`: visual-similarity lookup over archived generated
  and downloaded images using lightweight aHash/dHash ranking.

Still pending:

- LLM-hosted games and deeper playful group systems.
- Account-backed media sources.

## Testing Policy

For each feature:

- one focused unit test for the plugin/tool;
- one config-source test update when allowlists/manuals change;
- one regression for any path/routing/security rule;
- end-to-end smoke in the test Telegram group only when media delivery changes.

Run:

```powershell
npm run build:config
npm run lint:config
npm run test:core
```

Run `npm run test:patches` only when runtime patch behavior or Telegram delivery
patch behavior changes.
