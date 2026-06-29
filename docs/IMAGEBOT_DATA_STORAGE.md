# Imagebot Data Storage

The repository is the reproducible source layer. Runtime data is intentionally
outside git so the bot can be rebuilt without committing private state, media,
tokens, logs, or memories.

## Main Roots

- Project source: `%USERPROFILE%\Desktop\Amadeus`
- OpenClaw runtime state: `%USERPROFILE%\.openclaw`

The Desktop may contain shortcuts to these roots, but it should not contain a
copied runtime data tree.

## Persistent Data

- Telegram/model state: `%USERPROFILE%\.openclaw\imagebot`
- Mars forward detector primary state:
  `%USERPROFILE%\.openclaw\imagebot\mars-forward-detector.sqlite`
- Mars forward detector legacy/import state:
  `%USERPROFILE%\.openclaw\imagebot\mars-forward-detector.json`
- Bot sessions and memory-adjacent state: `%USERPROFILE%\.openclaw\agents\imagebot`
- Curated operational memory logs: `%USERPROFILE%\.openclaw\agents\imagebot\ops-memory`
- Knowledge library: `%USERPROFILE%\.openclaw\knowledge-library`
  - Runtime ingested `user_docs` are scoped under
    `%USERPROFILE%\.openclaw\knowledge-library\user-docs\scopes`
  - Legacy/no-context local ingest records live under
    `%USERPROFILE%\.openclaw\knowledge-library\user-docs\admin`
- Gacha archive state: `%USERPROFILE%\.openclaw\feature-core\gacha-archive`
- Gacha archive send media: `%USERPROFILE%\.openclaw\media\gacha-archive`
- Generated/downloaded image archive: `%USERPROFILE%\.openclaw\media\archive`
- Mars forward media evidence cache: `%USERPROFILE%\.openclaw\media\mars-forward`
- Gallery visual/search index: `%USERPROFILE%\.openclaw\generated-gallery`
- Turn observer trace log: `%USERPROFILE%\.openclaw\turn-observer`

These are backup-worthy. The gallery archive keeps the media files and
`manifest.jsonl`; the generated-gallery state only keeps derived lookup data.

## Cache And Working Media

- General bot media workspace: `%USERPROFILE%\.openclaw\media`
- Telegram inbound media: `%USERPROFILE%\.openclaw\media\inbound`
- Image generation working files: `%USERPROFILE%\.openclaw\media\tool-image-generation`
- Downloaded working files: `%USERPROFILE%\.openclaw\media\downloaded`
- Gallery resend staging: `%USERPROFILE%\.openclaw\media\gallery-resend`
- Gallery preview cache: `%USERPROFILE%\.openclaw\media\gallery-preview`
- Practical-tools account browser profiles:
  `%USERPROFILE%\.openclaw\practical-tools\browser-profiles\account`
- Ordinary public `web_snapshot` / `web_card` calls and browser-backed image
  downloads use ephemeral Playwright contexts and do not keep a persistent
  profile.
- Temporary state: `%USERPROFILE%\.openclaw\tmp`

These may be large and useful during development, but they are not the primary
backup target unless a specific run needs to be preserved. Promote useful media
into the archive with `archive_media_cache` or
`scripts\ARCHIVE_IMAGEBOT_MEDIA_CACHE.ps1`.

## Retention Defaults

- Mars forward detector: configured for 100,000 entries with no age-based
  retention. Primary duplicate state is SQLite; old JSON state is imported once
  and kept as a compatibility fallback for tooling. It stores the original
  forward source as a duplicate fingerprint, but user-facing lookup/forwarding
  targets the first same-group message. Media evidence is cached under
  `.openclaw\media\mars-forward` with a 20 MiB per-file cap and a 100 GiB total
  cache cap; deleting cached media does not delete the
  source/url/file_unique_id/visual-hash index. Visual hashes are derived
  evidence used for exact and conservative similar-image candidates; they are
  small fields in the Mars detector record, not separate image bodies.
  Unaddressed channel forwards first take a light exact-fingerprint path; media
  download and visual hash computation are filled by a bounded background index
  queue unless an exact duplicate or addressed message needs immediate
  evidence.
- Gallery manifest lookup: configured to scan up to 1,000,000 manifest lines or
  512 MiB from the archive manifest.
- Gallery visual lookup: configured to index up to 100,000 entries.
- Archive media import: default single-file cap is 100 GiB.

These are runtime practicality limits, not deletion policies for the archived
media itself. Cache cleanup and temporary browser profile cleanup remain
separate from persistent archive retention.

## Manual Backup Shortlist

Back up these two roots for the current bot state and media archive:

```text
%USERPROFILE%\.openclaw
%USERPROFILE%\Desktop\Amadeus
```

For a smaller backup that keeps the most important bot-specific state, include:

```text
%USERPROFILE%\.openclaw\imagebot
%USERPROFILE%\.openclaw\agents\imagebot
%USERPROFILE%\.openclaw\knowledge-library
%USERPROFILE%\.openclaw\feature-core
%USERPROFILE%\.openclaw\imagebot\mars-forward-detector.sqlite
%USERPROFILE%\.openclaw\imagebot\mars-forward-detector.json
%USERPROFILE%\.openclaw\media\archive
%USERPROFILE%\.openclaw\media\mars-forward
```
