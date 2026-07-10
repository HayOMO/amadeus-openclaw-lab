---
id: recipe.artist_style_reference
title: Artist Style Reference
type: recipe
tags: image, style, artist, reference, generation
aliases: artist_style, style_reference, painter_style, 画师风格
tools: image_skill, explicit_web_text_search, web_image_search, pixiv_resource, danbooru_resource, download_image_url, image_generate
---

Use when the user asks for a named artist, illustrator, studio, or highly
specific art style and no trusted local style card already covers it.

Workflow:

1. Search representative public works before generation. Prefer the artist's
   official pages, Pixiv/profile pages, portfolio/art-book pages, Danbooru
   artist-tag pages, or source pages with visible works.
2. Verify recurring style cues instead of relying on the name alone: linework,
   color palette, face/eye shape, lighting, composition, texture, rendering
   density, and common subject matter.
3. Convert those cues into prompt language. Use downloaded local references only
   when a visible reference will materially improve the result.
4. If the requested style conflicts with a specified character's official
   identity, keep identity cues explicit and let style affect rendering rather
   than replacing the character.

Avoid:

- Guessing a style from the artist name without looking at works.
- Using the current turn's generated image as a style base after a bad result.
- Letting a style reference overwrite required character design details.
