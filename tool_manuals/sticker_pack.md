---
id: sticker_pack
tools: sticker_pack, media_transform
keywords: Telegram sticker, sticker set, add stickers, create sticker set, WebP sticker, TGS, WEBM, sticker source set, download sticker set, draft stickers, review stickers, publish stickers, manage stickers
when_to_read: Before preparing, reviewing, publishing, downloading, searching, inspecting, copying, or managing Telegram sticker sets.
---

# Sticker Pack

`sticker_pack` is a Telegram sticker-set workbench. It can prepare local media,
draft/review/publish bot-created sets, inspect/search/download existing
Telegram sticker sets, and explicitly copy/import a known set when that is the
requested operation.

The tool wraps Telegram Bot API sticker management operations such as preparing
files, uploading sticker files, creating user-owned sets that this bot can
edit, adding to sets created/managed by this bot, reading a known set by name,
downloading sticker files through `getFile`, and editing metadata for stickers
in sets created by this bot.

## Exposed Actions

- `plan`: create a one-shot confirmation plan for a `dryRun:false`
  `delete_sticker` operation. Delete plans return an `approval_code`; the
  original requester must send that exact code in a later message before the
  tool runs `delete_sticker` with `plan_id`. Non-delete mutation plans remain
  accepted for compatibility, but ordinary sticker creation/add/upload/copy
  should rely on user alignment instead.
- `prepare`: convert one bot-local static image into transparent WebP, or one
  local GIF/ordinary video into a Telegram-compliant VP9 WebM video sticker.
  Static rendering keeps the subject aspect ratio unless `framing=cover` is
  requested; transparent padding is used for the square working canvas.
- `prepare_batch`: convert up to 20 bot-local images into sticker files and
  optionally return a contact sheet preview.
- `draft`: prepare selected local candidate images into a reviewable sticker
  draft.
- `get_draft`, `review_brief`, `review_draft`, `review_sheet`: inspect and
  mark draft items as keep/reject/pending with emoji and keywords.
- `list_managed_sets`: read the local registry of bot-created or locally
  remembered sticker sets.
- `set_default_set`: record a local default target set for a user and sticker
  type. This does not grant Telegram edit rights.
- `forget_managed_set`: remove one set from the local managed-set registry.
- `publish_draft`: publish kept draft items. Defaults to `dryRun:true`.
  `dryRun:false` requires trusted runtime context where `userId`/`ownerUserId`
  matches the current Telegram sender.
- `search_sets` / `search_sources`: search public web pages for Telegram
  `t.me/addstickers/...` set links and optionally verify them with
  `getStickerSet`.
- `source_set`: inspect a known Telegram sticker set and return sticker
  file_id/emoji/format inventory without downloading or publishing.
- `download_set`: download selected stickers from a known Telegram sticker set
  into the local sticker-pack downloads directory and write a `manifest.json`.
- `copy_set` / `import_set`: mirror selected stickers from a known Telegram set
  into a bot-created/user-owned set. Defaults to `dryRun:true`; `dryRun:false`
  requires `userId`/`ownerUserId` to match the current Telegram sender.
- `upload`: upload one compliant sticker file to Telegram for later use.
  Defaults to `dryRun:true`; `dryRun:false` requires `userId`/`ownerUserId` to
  match the current Telegram sender.
- `create`: create a user-owned Telegram sticker set that this bot can edit,
  with one sticker. Defaults to `dryRun:true`.
- `create_batch`: create a user-owned Telegram sticker set that this bot can
  edit, with multiple initial stickers. Defaults to `dryRun:true`.
- `add`: add one sticker to an existing bot-created/managed set. When
  `dryRun` is omitted and the runtime sender matches `userId` / `ownerUserId`,
  this defaults to the real add path; otherwise it remains fail-closed or
  dry-run according to the supplied parameters.
- `add_from_sticker`: add a received/replied sticker `file_id` or bot-local
  sticker file to a named or default managed set. When `dryRun` is omitted and
  the runtime sender matches `userId` / `ownerUserId`, this defaults to the
  real add path.
- `add_batch`: add multiple stickers to an existing bot-created/managed set.
  When `dryRun` is omitted and the runtime sender matches `userId` /
  `ownerUserId`, this defaults to the real add path.
- `get`: read metadata for a known sticker set name or `t.me/addstickers/...`
  URL.
- `delete_sticker`: remove a sticker from a bot-created set. It defaults to
  `dryRun:true`; `dryRun:false` requires an explicit delete confirmation plan
  or trusted runtime mutation approval.
- `set_keywords`, `set_emoji_list`: manage sticker metadata in bot-created
  sets. These default to `dryRun:true`; `dryRun:false` requires `userId` /
  `ownerUserId` to match the current Telegram sender because a bare `fileId`
  has no owner semantics.
- `link`: normalize a set name and return its `t.me/addstickers/...` URL.

## Action Boundaries

Use the narrowest action that matches the task:

- `get` and `source_set` read Telegram metadata only.
- `download_set` writes local files only.
- `list_managed_sets` reads local registry state only.
- `set_default_set` and `forget_managed_set` mutate local registry state only.
- `draft` and `review_*` prepare local candidates for judgment.
- `upload`, `publish_draft`, `create`, `copy_set`, `import_set`,
  `delete_sticker`, `set_keywords`, and `set_emoji_list` are Telegram mutation
  paths and default to `dryRun:true`.
- `add`, `add_from_sticker`, and `add_batch` are Telegram mutation paths too,
  but user-aligned chat/runtime calls default to the real add path when
  `dryRun` is omitted. Use explicit `dryRun:true` for preview-only add checks.
- When the runtime passes the current Telegram sender id, `dryRun:false`
  owner-scoped actions require `userId` / `ownerUserId` to match that sender.
  Missing requester context fails closed.
- Do not ask for approval codes for ordinary create/add/upload/copy/publish
  flows. Deletion is the only sticker action that should require a separate
  confirmation step; ask the original requester to repeat the delete
  `approval_code` from `action=plan` in a later message.
- Telegram Bot API does not provide a way for this bot to attach itself to an
  arbitrary existing user sticker pack and gain edit rights. Use `get`,
  `source_set`, `download_set`, or `copy_set` for existing packs; use
  `set_default_set` only as a local routing preference for future add actions.
- `search_sets` finds Telegram sticker-set links; broader internet image
  collection still belongs to the web/image source tools.

For image preparation before this publishing step:

- use `meme_transform` or `media_transform` for deterministic local edits;
- use image/search/download tools for source collection;
- use the model's own visual judgment on downloaded or uploaded media.

## Parameters

- `userId` / `ownerUserId`: Telegram user id of the sticker-set owner.
- `name` / `setName`: sticker set name or base name. Names are normalized and
  must end with `_by_<bot_username>`. Telegram set short names are ASCII-only;
  non-ASCII base names are converted to a safe ASCII name with a short hash.
- `set_default_set` with `name` / `setName` records the local default target for
  later `add` / `add_from_sticker` calls. It does not call Telegram.
- `add_from_sticker` accepts `fileId`, `stickerFileId`, a Telegram sticker
  object in `sticker` / `telegramSticker` / `stickerObject`, or a bot-local
  `input` / `stickerPath`. If `name` / `setName` is omitted, the local default
  set for `userId` and `stickerType` is used.
- If the user is replying to an already sent Telegram sticker and asks to steal
  or save it, use `add_from_sticker` with the sticker `file_id` or the whole
  `ReplySticker` / `Sticker` object. Do not first convert it through
  `media_transform`; Telegram can add the existing `file_id` directly.
- If the user is replying to an ordinary image, generated image, or downloaded
  media, use `add`. If `name` / `setName` is omitted and the user has a managed
  default set, `add` uses that default.
- A short reply on replied/generated media with clear save/add intent should
  use `add_from_sticker` or `add` against the user's managed set. Decide this
  from the operation intent and runtime media context, not from a fixed phrase
  list.
- `sourceSet` / `sourceName` / `fromSet` / `source`: existing Telegram sticker
  set name or `t.me/addstickers/...` URL.
- `query` / `sourceQuery` / `theme`: search or draft theme text.
- `downloadDir` / `outputDir`: optional local output directory for
  `download_set`; it must stay under the sticker-pack downloads directory.
- The tool schema intentionally exposes only common fields. Supported aliases
  such as `media`, `image`, `prepared`, `stickerPath`, `publishMode`,
  `copyApproved`, `formatFilter`, and per-item `reason`/`note` are accepted by
  the tool code and documented here rather than kept in the global prompt.
- `title`: sticker set title.
- `input`: one bot-local image/GIF/video/sticker path, `MEDIA:` line, `media://...` URI,
  or current/reply media handle such as `current.image.0` or `reply.image.0`
  when the current runtime context lists that handle.
- `inputs`: array of bot-local image/sticker paths, `MEDIA:` lines,
  `media://...` URIs, or current/reply media handles.
- `items`: per-sticker objects with `input`, `fileId`, `emoji`, `emojiList`,
  `keywords`, `format` / `stickerFormat`, and optional framing/compression
  settings.
- `emoji` / `emojiList`: 1-20 Unicode emoji for Telegram `InputSticker`.
- `keywords`: optional Telegram search keywords for regular/custom emoji
  stickers.
- `format` / `stickerFormat`: `static`, `animated`, or `video`.
  `animated` means Telegram `.TGS`; `video` means `.WEBM`. TGS input must
  already be compliant. GIF, animated WebP/APNG, MP4, MOV, M4V, AVI, MKV, and
  ordinary WebM sources are video inputs, not TGS animations.
- `framing`: `smart`, `contain`, or `cover`.
- `padding`, `trim`, `trimThreshold`, `quality`: local static-sticker rendering
  controls.
- `dryRun:true`: validate and show the normalized Telegram operation without
  mutating Telegram. Most Telegram mutation actions default to dry run; add
  actions default to real execution only when the current runtime sender is
  aligned with `userId` / `ownerUserId`.
- `targetAction`: with `action=plan`, the Telegram mutation action to confirm.
  Prefer using it only for `delete_sticker`. Ordinary publish/create/add/copy
  and upload actions should use trusted runtime user alignment.
- `plan_id`: one-shot sticker mutation plan id returned by `action=plan`.
- `directImportApproved`, `directUploadApproved`, and
  `directManagementApproved`: legacy model-supplied flags. They are kept for
  compatibility visibility but do not authorize `dryRun:false`; use
  user-aligned runtime context for non-delete actions and a delete plan for
  `delete_sticker`.

## Telegram Limits

- `create_batch` accepts up to 50 initial stickers.
- `add_batch` accepts up to 50 stickers per call.
- Regular sticker sets can hold up to 120 stickers.
- Static stickers use PNG/WebP input and are exported as transparent WebP under
  Telegram's static sticker size limit. The local working canvas is 512x512 for
  compatibility, while the visible subject is fit proportionally and padded with
  transparent pixels by default.
- Telegram Bot API treats sticker set type (`regular`, `mask`,
  `custom_emoji`) separately from sticker file format (`static`, `animated`,
  `video`). Mixed-format publishing should pass the correct `format` per
  `InputSticker`; `.tgs` files are `animated`, not `video`.
- Animated stickers use TGS with MIME `application/x-tgsticker`; video stickers
  use WEBM with MIME `video/webm`. Moving local media is converted with FFmpeg
  to VP9 WebM: no audio, at most 3 seconds and 30 FPS, one side exactly 512px,
  the other at most 512px, and at most 256 KB. Existing WebM files are checked
  and re-encoded when needed. TGS remains pass-through because it is vector
  Lottie data rather than a normal video container.

## Notes

- Sticker actions accept bot-local files only; URLs must be downloaded by other
  tools first.
- A sticker `file_id` received by this bot can be reused by this bot without
  reuploading. Telegram file IDs are bot-scoped, so IDs from another bot are not
  interchangeable.
- Successfully creating a set, or successfully adding to a set through Bot API,
  registers that set in `managed-sets.json`; manual defaults remain local
  records until a real Telegram mutation succeeds.
- `.tgs` is gzip-compressed Lottie JSON. It is not a normal video file and may
  not open in desktop media players; treat it as a Telegram sticker asset.
- `get` is metadata lookup for a known set. It is not keyword search.
- `download_set` uses Telegram `getFile` for each sticker and stores the
  original `.webp`, `.tgs`, or `.webm` asset when Telegram returns that path.
- Telegram Bot API requires `InputSticker.format` to be `static`, `animated`, or
  `video`, and `emoji_list` to contain 1-20 emoji.
