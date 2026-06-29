# Sticker Workflow Boundary

This document records the current sticker-workflow design. The active
model-facing contract lives in `tool_manuals/sticker_pack.md`; this file is for
maintainers.

## Decision

`sticker_pack` is a bounded Telegram sticker-set workbench, not a hidden
one-purpose publisher. The model-visible tool surface should expose real
capabilities, while the detailed workflow contract stays in the on-demand tool
manual.

Useful action groups:

- local preparation: `prepare`, `prepare_batch`;
- draft workflow: `draft`, `get_draft`, `review_brief`, `review_draft`,
  `review_sheet`, `publish_draft`;
- managed targets: `list_managed_sets`, `set_default_set`,
  `forget_managed_set`, `add_from_sticker`;
- existing Telegram sets: `get`, `source_set`, `download_set`;
- public set discovery: `search_sets`, `search_sources`;
- explicit mirroring: `copy_set`, `import_set`;
- direct publishing/management: `upload`, `create`, `create_batch`, `add`,
  `add_batch`, `delete_sticker`, `set_keywords`, `set_emoji_list`, `link`.
  `plan` creates a one-shot approval checkpoint for these Telegram mutation
  actions.

## Two-Layer Tool Description

The global prompt/tool schema should stay short:

- the tool index says what `sticker_pack` is for;
- the runtime schema exposes the available action names and common fields;
- `tool_manual_search` retrieves `sticker_pack.md` before nontrivial sticker
  work.

Detailed aliases, workflow order, Telegram limits, and side-effect rules belong
in `tool_manuals/sticker_pack.md`, not in the always-on prompt.

## Side-Effect Boundary

- `get` and `source_set` read Telegram metadata only.
- `download_set` writes local files and a manifest only.
- `list_managed_sets` reads the local managed-set registry.
- `set_default_set` and `forget_managed_set` write only the local managed-set
  registry; they do not grant Telegram edit rights.
- `draft` and `review_*` write local draft/review artifacts only.
- `upload`, `publish_draft`, `create`, `add`, `add_from_sticker`, `copy_set`,
  `import_set`, `delete_sticker`, `set_keywords`, and `set_emoji_list` can
  mutate Telegram. They default to `dryRun:true`.
- `dryRun:false` Telegram mutations require a consumed `sticker_pack action=plan`
  approval or trusted runtime mutation approval. Legacy model-supplied flags
  such as `directImportApproved`, `directUploadApproved`, and
  `directManagementApproved` remain compatibility markers and are not
  sufficient.
- Non-dry-run publish/copy/upload/create/add actions require `userId` /
  `ownerUserId` to match the current sender. Missing requester context fails
  closed.
- Successful create/add actions record the set in `managed-sets.json` for later
  default routing.

## Failure That Shaped This

The earlier implementation tried to avoid model mistakes by hiding
draft/review/source/copy actions. That shrank the bot's capability and made it
harder to diagnose whether the model misunderstood the task or the tool surface
was incomplete.

The current approach is more honest: expose the capability, name each action by
its actual side effect, and keep mutation defaults conservative.

## Managed Set Registry

Telegram Bot API lets a bot edit sticker sets it created for a user; it does
not let a bot attach itself to an arbitrary old user pack. The registry is
therefore local routing state:

- `create` / `create_batch` register a set after a successful non-dry-run
  `createNewStickerSet`.
- `add` / `add_from_sticker` register or refresh a set after a successful
  non-dry-run `addStickerToSet`.
- `set_default_set` records a user/type default target without contacting
  Telegram.
- `add_from_sticker` uses a provided `name` / `setName` or the local default to
  add a received `file_id` or bot-local sticker file.

## References Checked

- Telegram Bot API `getStickerSet`, `getFile`, `uploadStickerFile`,
  `createNewStickerSet`, and `addStickerToSet`.
- `tstickers`: downloads Telegram sticker packs from `t.me/addstickers` links
  and converts/caches files.
- `tsticker`: separates local directory sync/download/import/push style
  commands.
- `sticker-convert`: separates download, conversion/compression, and upload
  with explicit credentials and platform-specific limits.
