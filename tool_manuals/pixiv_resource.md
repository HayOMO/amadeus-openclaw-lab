---
id: pixiv_resource
tools: pixiv_resource
keywords: pixiv, ranking, rank, daily, weekly, monthly, r18, r18g, artwork, illust, gallery-dl, resource, download, ピクシブ
when_to_read: Before using Pixiv rankings, Pixiv artwork URLs, or cached Pixiv media.
---

# Pixiv Resource

`pixiv_resource` is a read-only Pixiv helper backed by `gallery-dl`.

Use it for:

- Pixiv rankings: daily, weekly, monthly, male, female, original, rookie,
  daily_ai, daily_r18, male_r18, female_r18, weekly_r18, r18g, and other Pixiv
  ranking mode strings.
- Pixiv artwork/detail URLs.
- Bounded original-media download into the bot-local Pixiv cache.
- Resending recent Pixiv cache files.

Common calls:

- Ranking metadata only:
  `{"action":"ranking","mode":"daily","count":10}`
- Ranking with bookmark gate:
  `{"action":"ranking","mode":"daily","count":10,"minBookmarkCount":500}`
- Ranking plus media for visual choice/comparison:
  `{"action":"ranking","mode":"daily","count":10,"downloadCount":5,"visionCount":3}`
- Specific artwork download:
  `{"action":"download","illustId":123456789,"downloadCount":1}`
- Recent local cache:
  `{"action":"recent","count":10}`

Notes:

- The tool returns exact metadata and `MEDIA:` / `SPOILER_MEDIA:` paths. Keep
  those facts exact. Download actions also include a small image context block
  for returned images when practical.
- For ranking media, prefer one `ranking` call with `downloadCount` instead of
  repeated single-artwork downloads. Ranking media downloads use bounded
  concurrency and fetch candidate first images in ranking order.
- For a specific artwork, `downloadCount` means max files/pages to download.
  `downloadCount:1` should return only the first page unless `range` overrides
  it.
- `downloadCount`, `downloadConcurrency`, and `visionCount` are capped to avoid
  flooding Telegram or Pixiv.
- `minBookmarkCount` / `minBookmarks` / `minFavCount` / `minFavorites` filter
  metadata before ranking media download, so low-bookmark candidates are not
  downloaded.
- The tool has a built-in account-safety exact tag filter. By default it skips
  Pixiv items tagged `loli` only in adult/R18 Pixiv contexts, before media
  download or cache writes.
- The tool does not visually judge image content. It maps Pixiv's own adult
  ranking/artwork metadata to Telegram native spoiler delivery by returning
  `SPOILER_MEDIA:` and `details.media.sensitiveMedia=true`.
- `details.media.outbound=false` means the tool does not auto-send media. If the
  user asked to receive the image, use the returned `MEDIA:` or `SPOILER_MEDIA:`
  line in the final reply after reading the metadata/image context.
- For Pixiv backend problems, upgrade `gallery-dl` before changing tool logic.
