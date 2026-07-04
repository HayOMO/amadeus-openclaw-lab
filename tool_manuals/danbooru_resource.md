---
id: danbooru_resource
tools: danbooru_resource
keywords: danbooru, booru, donmai, rating, favcount, score, anime image, 鎼滃浘, 鎵惧浘
when_to_read: Before Danbooru-native image search, Danbooru post lookup, or Danbooru media download.
---

# Danbooru Resource

`danbooru_resource` reads Danbooru through the official `posts.json` API.

Use it for:

- Danbooru-native tag searches instead of generic image search.
- Quality gates such as `minScore` and `minFavCount` / `minBookmarkCount`.
- Rating-specific searches: `any`, `general`, `sensitive`, `questionable`,
  `explicit`, `sfw`, or `nsfw`.
- Optional local media download with `downloadCount`.

Common calls:

- Search metadata:
  `{"action":"search","tags":["1girl","blue_archive"],"minScore":200,"count":10}`
- Popular/favorite gate:
  `{"action":"search","tags":["1girl"],"minFavCount":500,"order":"favcount","count":10}`
- Explicit search:
  `{"action":"search","tags":["1girl"],"rating":"explicit","minFavCount":200,"count":6}`
- Download selected leading posts:
  `{"action":"search","tags":["1girl"],"minFavCount":500,"downloadCount":3}`
- Detail:
  `{"action":"detail","postId":123456}`
- Credential check:
  `{"action":"auth_check"}`

Notes:

- Default and only configured host is full Danbooru:
  `https://danbooru.donmai.us`. Do not route this tool to mirror hosts.
- Credentials are optional but useful for authenticated Danbooru API limits.
  Store them with `scripts/SET_DANBOORU_SECRET.ps1`.
- The tool does not force safe-only results. Non-general ratings return
  `SPOILER_MEDIA:` when downloaded.
- `minBookmarkCount` is an alias for Danbooru favorite count because users often
  describe it as bookmarks/favorites.
