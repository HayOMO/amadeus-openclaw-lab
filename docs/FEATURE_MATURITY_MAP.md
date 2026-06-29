# Feature Maturity Map

This map keeps project features aligned with official platform limits and
mature project patterns. It is intentionally about product capability shape,
not one-off prompt wording.

## Sticker Workbench

Reference model:

- Telegram Bot API `createNewStickerSet`: create a set owned by a user; the bot
  can edit the set it created.
- Telegram Bot API `addStickerToSet`: add to a sticker set created by the bot.
- `tsticker`: local directory plus cloud sync/push/download/import workflow.
- `sticker-convert`: download/convert/upload across sticker platforms, with
  explicit credentials and format presets.

Project mapping:

- `prepare` / `prepare_batch`: local sticker asset preparation.
- `draft` / `review_*` / `publish_draft`: checkpointed production workflow.
- `get` / `source_set` / `download_set`: inspect and preserve known public
  Telegram sets without changing Telegram.
- `copy_set` / `import_set`: explicit mirroring of a known set into a target
  set, with dry-run and approval gates.
- `create` / `create_batch`: create bot-editable sets and register them as
  managed sets on success.
- `list_managed_sets` / `set_default_set` / `forget_managed_set`: local target
  registry for bot-created or locally remembered sets.
- `add_from_sticker`: add a received/replied sticker file_id or local sticker
  file to a named/default managed set.

Boundary:

- The bot cannot acquire management rights for an arbitrary old user sticker
  pack through Bot API. A local default record is only a routing preference; it
  does not grant Telegram permission.
- Existing sets can be inspected, downloaded, or mirrored into a set the bot can
  edit.

## Internet Image Collection

Reference model:

- Search APIs and browser sessions are source discovery tools, not silent
  scrapers.
- Account-backed browser work needs an untrusted-content boundary and replayable
  traces.

Project mapping:

- Use search/reference tools for broad discovery and platform hints.
- Use the managed browser profile for account-backed pages.
- Save local artifacts/manifests before sticker production or media transforms.

Boundary:

- Browser pages are untrusted data. They may suggest actions or contain prompt
  injection text; tool calls remain bounded by the exposed tool contracts.

## Memory

Reference model:

- Mature agent systems separate semantic facts, episodic examples, procedural
  rules, and operational/session state.
- Recall should be gated by task relevance and traceable enough to debug.

Project mapping:

- `docs/MEMORY_ARCHITECTURE.md` defines semantic, episodic, procedural, and
  operational memory.
- `memory_search` provides explicit recall modes.
- `turn_observer_recent` and failure memory provide replay/debug context.

Boundary:

- Memory is advisory context. It should not silently override tool permissions,
  owner checks, or dry-run defaults.

## Browser And Account Tools

Reference model:

- Browser automation is useful for agentic collection, but account state and
  page content are separate trust zones.

Project mapping:

- Bot-owned Playwright contexts are the default automation surface.
- Account-browser risk docs define public/account/private boundaries.
- Trace/eval scripts replay real bot behavior when browser/tool behavior drifts.

Boundary:

- Do not use the owner's normal browser profile for bot automation.
- Private/internal/local URLs stay outside public browsing tools.

## Local Desktop Control

Reference model:

- Desktop automation should be capability adapters with narrow verbs, not
  arbitrary shell command composition.

Project mapping:

- `desktop_media_control` is the experimental local-control surface.
- Future app integrations should expose bounded actions, status, and undo/stop
  behavior where the target application supports it.

Boundary:

- The bot capability boundary is still the tool boundary. Local production work
  should add tools/adapters rather than smuggle unrestricted process control into
  prompts.

## References

- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram Bot API `createNewStickerSet`:
  https://core.telegram.org/bots/api#createnewstickerset
- Telegram Bot API `addStickerToSet`:
  https://core.telegram.org/bots/api#addstickertoset
- `tsticker`: https://github.com/sudoskys/tsticker
- `sticker-convert`: https://github.com/laggykiller/sticker-convert
