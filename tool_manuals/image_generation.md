---
id: image_generation
tools: image_generate, image, image_skill_lookup, image_skill_save_reference, image_skill_note_preference, generated_gallery_recent, generated_gallery_search, generated_gallery_resend, media_artifact_recent, media_artifact_lineage, explicit_web_text_search, web_image_search, reverse_image_search, download_image_url, download_image_urls, web_snapshot
keywords: draw, generate, image2, gpt-image-2, image model, edit image, reference image, redraw, prompt, character reference, 生图, 画图, 生成图片, 改图, 重画, 重新画, 参考图, 人设图, 官方人设, 原设画风, 上张图, 重新发, 串味
when_to_read: Before using image_generate or deciding whether an image request is new generation, edit/reference generation, resend, or found-image search.
---

# Image Generation Contract

## Use

- `image_generate`: new image, edit, redraw, derivative image.
- `image`: inspect images only; it does not draw.
- For complex image generation, use `prompt_library search` / `compose` before
  `image_generate` when the request matches a known recipe such as gpt-image-2
  blueprint, academic figure, anime character, Chinese/Asian social-media card,
  guofeng/hanfu board, photoreal scene, product asset, wallpaper/poster,
  sticker, or common negative failures.
- One user request -> at most one `image_generate` call.
- If image generation fails/times out/aborts: retry once only when the same local reference images are still required and the failure looks like transport/input delivery. Otherwise stop and reply briefly. No downgrade loop.
- Public URL references are not stable generation inputs in imagebot. Use `web_image_search` returned `localMedia` paths when present; otherwise download selected public URLs with `download_image_url`, inspect the returned preview, then call `image_generate` with local MEDIA paths. If the download/reference step fails, report that failure or choose another reference.
- Successful final reply includes every returned `MEDIA:<path>` line.

## Resend Is Not Regenerate

- User says resend / 上张图没出来 / 没发出来 / 再发一次:
  1. `generated_gallery_recent` or `generated_gallery_search`
  2. `generated_gallery_resend`
- Do not call `image_generate` for pure resend.

## Stateless New Image

- Fresh generation does not inherit old prompts, old generated images, old references, or another window.
- Pass images only when current user text points to a specific current/replied/lineage media handle.
- Fresh wording such as 重新画, 新图, 另画一张, start over means prompt-only unless a specific image is named.
- Use media handles from `[Imagebot media handles]`, not raw old local paths.

## Named Character / Person

- For named characters, public people, VTubers, mascots, OCs, products, places, logos, or unfamiliar visual subjects:
  1. `image_skill_lookup`
  2. public/current search if needed
  3. `web_image_search`
  4. inspect returned previews/localMedia
  5. download any useful candidate that lacks localMedia
  6. pass useful local reference image(s) to `image_generate.images`
- Default for specified characters: official/canonical design and original visual style.
- Text-only generation is acceptable only when no reliable reference is available or user asks for prompt-only.

## Local Image Skills

- `image_skill_lookup`: recall saved character/style references and user preferences.
- `image_skill_save_reference`: save a useful bot-local reference for future requests.
- `image_skill_note_preference`: record lightweight user preference for a character/style.

## Found Images

- User asks to find/search/send existing pictures: `web_image_search` + `download_image_url(s)`.
- Do not call `image_generate` for existing-image search.

## Quality

- Default: leave quality/size unset, match ChatGPT web-style defaults.
- User asks fast/draft: use lower/provider-auto quality when supported.
- User asks final/high/wallpaper: use high quality and requested aspect ratio when supported.

## Prompt Library Recipes

Use these prompt cards as on-demand skills, not permanent prompt text:

- `recipe.gpt_image_2_prompt_blueprint`: universal image2/GPT Image 2 prompt
  structure and size/quality habits.
- `recipe.academic_figure`: scientific diagrams, visual abstracts, teaching
  figures, and readable infographics.
- `recipe.anime_character_scene`: two-dimensional character scenes with
  reference-led identity.
- `recipe.asian_anime_tag_order`: Japanese/Niji/NovelAI-style anime tag order
  for identity, pose, full-body, and background control.
- `recipe.xiaohongshu_douyin_visual_note`: 小红书/抖音/公众号 covers,
  Chinese social cards, and creator-note layouts.
- `recipe.asian_social_portrait_grid`: 小红书/日系/韩系 portrait grids,
  social profile photos, and four/nine-grid photo sets.
- `recipe.guofeng_hanfu_moodboard`: 国风/汉服/妆造 proposal boards and
  Chinese fashion moodboards.
- `recipe.photoreal_scene`: realistic portraits and camera-like scenes.
- `recipe.product_template_asset`: product mockups, ads, posters, UI/social
  layout templates.
- `negative.common_image_generation_failures`: short targeted avoid list for
  non-anime image quality failures.
- `negative.chinese_asian_aesthetic_failures`: avoid western influencer/SaaS
  defaults, eurocentric face drift, generic oriental props, and unreadable
  dense Chinese text when an Asian social or guofeng aesthetic is requested.
