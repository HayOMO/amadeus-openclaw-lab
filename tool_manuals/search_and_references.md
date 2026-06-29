---
id: search_and_references
tools: explicit_web_text_search, web_image_search, reverse_image_search, download_image_url, download_image_urls, pixiv_resource, public_video, zhihu_search, zhihu_global_search, zhihu_hot_list, web_snapshot
keywords: search, websearch, source, citation, current, latest, official, paper, reference, image reference, google, duckduckgo, zhihu, 联网, 搜索, 查资料, 来源, 引用, 最新, 官方, 论文, 文献, 知乎, 热榜, 搜图, 找图, 参考图, 人设图
when_to_read: Before public/current fact lookup, citation/source finding, Zhihu lookup, image reference search, or original-source lookup.
---

# Search And References Contract

## Text Search

- Prefer provider-native/current-model hosted search when the active runtime
  actually makes it available. Native hosted search may not appear as a normal
  tool named `web_search`; the visible tool list is only one signal. Count it
  as successful when the result is observable through sources, citations, or a
  trace. When native search is unavailable, unobservable, empty, or
  insufficient, continue with the explicit tools.
- Use `zhihu_search` for Zhihu station answers/articles.
- Use `zhihu_global_search` for Chinese/community web lookup, especially when the user asks in Chinese or the subject lives mainly in Chinese internet context.
- Use `zhihu_hot_list` for Zhihu hot-list/trending questions.
- Use `explicit_web_text_search` only as a bounded generic fallback when native search and Zhihu are unavailable or insufficient.
- Use one meaningful search round plus one fallback, then answer or report the limitation.

## Source-Site Hints

These are routing hints, not a fixed harness. Use them when the model is
uncertain, when source/origin matters, or when a first search is too broad.

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
- When snippets are insufficient or the page is JS/login-heavy, use
  `web_card` or `web_snapshot` as a browser reading fallback, then stop at
  verification/login/risk walls.

## Image Search

- `web_image_search`: find public image candidates by text. In imagebot
  foreground turns, it also tries to download visible candidates and return
  model-visible previews plus `localMedia` paths.
- `reverse_image_search`: source/artist/similar lookup from an existing image.
- These search tools return candidates/metadata. Use returned previews and
  `localMedia` paths when present; call `download_image_url` for a useful
  candidate that was not downloaded.
- For generation references, public `imageUrl` values must become bot-local
  downloaded paths first. Use returned `localMedia`/`MEDIA:` paths in
  `image_generate.images`; if the reference cannot be downloaded, choose
  another reference or report the reference failure.

## Pixiv Resources

- `pixiv_resource`: Pixiv rankings, artwork details, and bounded local media
  downloads through `gallery-dl`.
- Use Pixiv ranking mode strings directly when the user asks for Pixiv榜单.
- For downloaded Pixiv media, keep returned metadata exact and use returned
  `MEDIA:` paths for Telegram delivery.

## Found Image vs Generated Image

- User wants existing images: search + download.
- User wants new/redrawn/edited image: use references if useful, then `image_generate`.

## Page Visuals

- `web_snapshot`: public webpage screenshot + visible text + simple interactions.
- Use when snippets are insufficient or page layout/loaded image matters.

## Public Video URLs

- Use `public_video` for public video metadata, captions/transcripts, or bounded downloads.
- If the user asks what happens visually, download first and then use `media_brief`.

## Answering

- If searched, mention compact source names/links when useful.
- If search tool unavailable/rate-limited, fall back once or state the limitation.
