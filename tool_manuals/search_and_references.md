---
id: search_and_references
tools: explicit_web_text_search, web_image_search, danbooru_resource, reverse_image_search, download_image_url, download_image_urls, pixiv_resource, public_video, zhihu, web_snapshot
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
- Use `zhihu action=search` for Zhihu station answers/articles.
- Use `zhihu action=global_search` for Chinese/community web lookup, especially when the user asks in Chinese or the subject lives mainly in Chinese internet context.
- Use `zhihu action=hot_list` for Zhihu hot-list/trending questions.
- Use `explicit_web_text_search` only as a bounded generic fallback when native search and Zhihu are unavailable or insufficient.
- Requests whose answer depends on live external state require retrieval before
  answering. Treat the query wording as a task description, not as a fixed
  trigger list; form a direct search query from the actual subject and the
  missing fact.
- Search results are leads. If a result points at a relevant public source but
  the snippet does not answer the question, read the source with `web_card` or
  `web_snapshot`. Prefer reading a few high-value sources over looping many
  wording variants.
- Match retrieval depth to the question. Simple lookup may need one source;
  source-sensitive, disputed, current, or recommendation-like asks often need
  2-4 source reads/cards/snapshots before answering.
- For decision asks based on public current state such as schedules, prices,
  odds, availability, rankings, or event status, retrieve the public state first
  and then give bounded analysis. Ask only for private preferences or risk
  tolerance after the public facts are established.

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
- When snippets are insufficient, the source itself matters, or the page is
  JS/login-heavy, use `web_card` or `web_snapshot` as the browser reader.
  Click visible tabs/buttons and scroll when those actions reveal the requested
  public content. Treat verification/login/risk walls as blocked source states.

## Image Search

- Route by source first. Pixiv requests should use `pixiv_resource`; Danbooru,
  booru tags, ratings, `score`, `favcount`, or bookmark/favorite thresholds
  should use `danbooru_resource`; source pages and image grids should be read
  with `web_card` / `web_snapshot`; generic public image search is fallback.
- `danbooru_resource`: Danbooru-native image search/read/download. Use this
  when the user asks for Danbooru/booru-style anime images, exact tags, ratings,
  `score`, `favcount`, or bookmark/favorite thresholds.
- `web_image_search`: generic public image candidates by text. It is not a
  Pixiv/Danbooru/native-source replacement. Use it when no better source-specific
  route fits, or for quick broad visual candidates from the open web.
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

- `web_card`: compact page skim with title, URL, headings, preview text, and a
  screenshot.
- `web_snapshot`: page reading with screenshot, visible text, and bounded
  interactions.
- Typical reading calls: open the URL; click a visible tab/link/button such as
  comments, images, next, expand, or load more; scroll with `scrollMode` or
  `scrollY`; then read the returned visible text, screenshot, actions, and
  scroll metrics.
- Do not ask the user to click, scroll, or turn a public page for you when the
  control is visible and the task depends on it; use another bounded
  `web_snapshot` pass.

## Public Video URLs

- Use `public_video` for public video metadata, captions/transcripts, or bounded downloads.
- If the user asks what happens visually, download first and then use `media_brief`.

## Answering

- If searched, mention compact source names/links when useful.
- If search tool unavailable/rate-limited, fall back once or state the limitation.
