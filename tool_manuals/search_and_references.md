---
id: search_and_references
tools: explicit_web_text_search, web_image_search, danbooru_resource, reverse_image_search, download_image_url, download_image_urls, pixiv_resource, public_video, zhihu, web_snapshot
keywords: search, websearch, source, citation, current, latest, official, paper, reference, image reference, google, duckduckgo, zhihu, 联网, 搜索, 查资料, 来源, 引用, 最新, 官方, 论文, 文献, 知乎, 热榜, 搜图, 找图, 参考图, 人设图
when_to_read: Before public/current fact lookup, citation/source finding, Zhihu lookup, image reference search, or original-source lookup.
---

# Search And References Contract

## Text Search

- Provider-native/current-model hosted search may be available even when there
  is no visible tool literally named `web_search`.
- `explicit_web_text_search`: bounded generic public text search. Returns
  source leads: title, URL, snippet, and related metadata.
- `zhihu action=search`: Zhihu station answers/articles.
- `zhihu action=global_search`: Chinese/community web lookup.
- `zhihu action=hot_list`: Zhihu hot-list/trending questions.
- `web_card`: compact page card for a public URL.
- `web_snapshot`: page screenshot, visible text, scroll metrics, and bounded
  page action results for a public URL.

## Source-Site Hints

These are source hints, not a workflow.

- ACG terms, character attributes, fandom memes, and Japanese/Chinese otaku
  context: try `zh.moegirl.org.cn`, `zh.wikipedia.org`, `bgm.tv`, Bilibili,
  Bangumi-style fan pages, and official/game/anime wiki pages when applicable.
- Chinese internet memes and community claims: try Zhihu first when it is a
  discussion/source question, then public search leads for Bilibili, Weibo,
  Baidu Tieba, Xiaohongshu, Toutiao/Sohu/blog mirrors, and Wikipedia-style
  summaries.
- Sticker/source-material collection: combine the theme with `表情包`, `梗图`,
  `贴纸`, `合集`, `出处`, `原图`, `无水印`, and platform hints such as
  `site:weibo.com`, `site:tieba.baidu.com`, `site:xiaohongshu.com`, or
  `site:bilibili.com`.
- `web_card` / `web_snapshot` provide page-level evidence when a source page is
  more useful than a search snippet.

## Image Search

- `danbooru_resource`: Danbooru-native image search/read/download. Supports
  Danbooru/booru tags, ratings, `score`, `favcount`, and bookmark/favorite
  thresholds.
- `web_image_search`: generic public image candidates by text. Returns image
  URLs, source URLs, dimensions, source engine, and preview/download metadata
  when available.
- `reverse_image_search`: fast source/artist/similar lookup from an existing
  image, especially anime, game, illustration, and Pixiv-style material. It is
  not a general photo-understanding or place-identification tool. Accepts
  current/reply media handles or local media paths. Omitting `providers` uses
  the default SauceNAO/IQDB route; explicit providers can add sources such as
  ascii2d. Similar-only candidates do not prove that the depicted subject,
  place, or source is the same as the input image.
- Google Lens / Google Images through the full `browser` tool is the broadest
  general visual-search capability, especially for photos, objects, products,
  and places. Google login is not required for this capability. This is a
  capability distinction, not a mandatory fallback step. If it yields no exact or strong
  match, keep the uncertainty instead of promoting a merely similar result to
  an identification.
- `download_image_url` / `download_image_urls`: store selected direct public
  image URLs in bot-local media and return `MEDIA:` paths plus preview data.
- `pixiv_resource`: Pixiv ranking, artwork details, and bounded local media
  downloads through `gallery-dl`.

## Pixiv Resources

- Pixiv ranking modes and artwork IDs are passed through the tool schema.
- Downloaded Pixiv media returns metadata and `MEDIA:` paths for Telegram
  delivery.

## Found Image vs Generated Image

- Existing-image tasks use search/download tools.
- New/redrawn/edited-image tasks use `image_generate`; downloaded references
  can be passed as local media paths.

## Page Visuals

- `web_card`: compact page skim with title, URL, headings, preview text, and a
  screenshot.
- `web_snapshot`: page reading with screenshot, visible text, and bounded
  interactions.
- Page tools return page-level evidence and optional screenshots/artifacts.

## Public Video URLs

- `public_video`: public video metadata, captions/transcripts, and bounded
  downloads.
- `media_brief`: visual/media summary over bot-local downloaded video/audio
  media.

## Answering

- Tool results contain candidate source names, URLs, metadata, local media
  paths, and limitation/error fields.
