---
id: recipe.asian_anime_tag_order
title: Asian Anime Tag Order
type: recipe
tags: image, anime, japanese, niji, novelai, tag, character, erciyuan
aliases: anime_tag_order, novelai_tags, niji_prompt, japanese_anime_prompt, danbooru_style
tools: image_generate, image_skill_lookup, prompt_library
---

Use when the user wants anime/manga-style images and the request benefits from
tag-like structure rather than prose.

Prompt order:

1. Quality/style lane: clean anime cel, visual novel, manga cover, niji style,
   soft watercolor anime, retro anime, chibi, mecha, key visual.
2. Subject count and identity: solo, 1girl/1boy equivalent, named character or
   reference-led identity.
3. Core traits: hair color/style, eye color, outfit, signature accessories,
   body framing.
4. Pose/composition: upper body, full body, sitting, looking at viewer, dynamic
   pose, depth of field, boots/shoes when full body matters.
5. Scene/background: indoors/outdoors, classroom, train station, shrine,
   city night, market street, spring sakura, summer festival, etc.
6. Mood/lighting: gentle, lively, melancholic, cinematic backlight, soft pastel.

Rules:

- Put identity-critical tags early.
- If full body matters, explicitly include shoes/boots/feet and framing.
- If background matters, specify it; some anime models default to sparse
  backgrounds.
- For old-model look with strict new-model following, use a style/reference
  image when available instead of trying to summon it with vague style words.

Avoid:

- Dumping every tag you know.
- Generic "anime girl" when a specific character is requested.
- English/Japanese/Chinese mixed word salad if one clear language works.

Source basis:

- Niji 7 prompting guide:
  https://nijijourney.com/ja/blog/niji-7-prompting
- NovelAI character consistency tutorial:
  https://docs.novelai.net/ja/image/tutorial-charactercreation/
- NovelAI image-generation intro:
  https://docs.novelai.net/ja/image/tutorial-imgintro/
- Japanese community note on Midjourney V7 anime-style prompting:
  https://note.com/guriham_lab/n/n98eb76678b91
