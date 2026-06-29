# Image Generation Routing Skill

Internal manual for `/ask`, `/draw`, and `/edit` image turns. Do not expose these mechanics.

## Core

`/ask` is unified: decide from the current delivered text/media whether this is chat, image reading, image editing/reference, or new image generation.

Users may call the generation backend "image2", "gpt-image-2", "image model", "shengtu model", or similar. In this bot those all mean the visible `image_generate` tool. If `image_generate` is available, use it; do not say there is no image2 tool just because the tool name differs. The `image` tool only analyzes images and must never be used as the generation backend.

Generation is stateless by default. Do not inherit old prompts, old generated images, old reference images, old styles, or another participant's image context unless the current turn explicitly points to them.

Prefer one model decision and one `image_generate` call. Search/reference only when it materially improves the result.

## Quality and Size

Mirror the ChatGPT web default: do not set `quality`, `size`, or `resolution` unless the user explicitly asks for a quality, speed, or format constraint.

- If the user asks for fast/draft/quick/low-cost/极速/草稿, use lower/provider-auto quality and a normal smaller size.
- If the user asks for high quality/final/refined/wallpaper/高清/精修/壁纸, set `quality: high` and an appropriate aspect ratio/size.
- Otherwise leave quality/size unset and let `gpt-image-2` choose its default.
- Use `aspectRatio` only when the user asks for a framing or the prompt clearly implies it.

## Local/Telegram Images

Use Telegram/local image paths only when the current text clearly asks to edit/use/reference a specific available image.

Priority:
1. `ReplyMediaPaths` when the user points at the replied image.
2. `CurrentMediaPaths` when the user points at the attached image.
3. `WindowRecentMediaPaths` only for explicit previous-image wording: previous/above/last/that image, 上一张, 上面, 刚才, 那张, 原图, 参考上面那张, 改刚才那张.

Fresh wording such as 重新画, 再画一张, 画另一张, 新图, start over means prompt-only generation unless a specific image is named.

## Public/Named Subjects

For named characters, IPs, products, places, memes, public people, brands, logos, artworks, current trends, or unfamiliar visual subjects:

- Prefer `web_search` when available to build a compact canonical brief. If it is unavailable/empty/absent, use model knowledge or one visible public-search fallback such as `explicit_web_text_search`, `web_image_search`, `zhihu_global_search`, or `browser`.
- Prefer official/canonical facts: source title, outfit, colors, silhouette, accessories, avoidable mistakes.
- Use `web_image_search` when the user asks for visual refs, the subject is likely unfamiliar, or exact visual fidelity matters. Prefer returned `localMedia` paths after inspecting the visible previews.
- Public image URLs from search must become local MEDIA paths first. If `web_image_search` did not provide `localMedia` for a useful candidate, use `download_image_url`, inspect the returned preview, then pass the local MEDIA path to `image_generate.images`.
- Do not inspect web image candidates with `image` by default; inspect only when ambiguity or strict accuracy makes it worth the delay.

## Tool Contract

- New original image: call `image_generate` with prompt only.
- Edit/reference available image: pass only the specific replied/current/explicit recent image path(s).
- Public reference image: inspect returned previews and pass local MEDIA paths.
- User says "draw/generate/make/paint", "shengtu", "hua yi zhang", or "gei image2 shengcheng": call `image_generate`, not `image`.
- Do not pass prior media, prior generated images, or old prompts unless the current turn explicitly asks for them.
- Do not pass `quality`, `size`, or `resolution` unless the user explicitly requested a quality/speed/format constraint.
- Call `image_generate` at most once per request.
- If generation fails, aborts, or times out, retry once only when the same local reference images are still required and the failure looks like transport/input delivery. Otherwise reply briefly.
- After success, include every returned `MEDIA:<path>` line exactly as plain lines so Telegram attaches the result.
