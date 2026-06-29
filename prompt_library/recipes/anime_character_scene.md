---
id: recipe.anime_character_scene
title: Anime Character Scene
type: recipe
tags: image, anime, character, erciyuan, illustration, reference
aliases: anime_scene, erciyuan, anime_character, niji_style, character_scene
tools: image_generate, image_skill_lookup, web_image_search, download_image_url, prompt_library
---

Use for two-dimensional / anime / manga / visual-novel character images,
especially when character identity, outfit, expression, or style consistency
matters.

Workflow:

1. For named characters, first use `image_skill_lookup` and reference search.
2. Let reference images carry canonical design; use text for scene, pose, mood,
   composition, and requested style changes.
3. Prefer one clear scene over many unrelated props.
4. Compose with a style card or a negative card when identity drift is likely.

Prompt shape:

- Character identity and reference rule: official/canonical design unless user
  asks otherwise.
- Scene/action: what the character is doing and where.
- Expression and pose: gaze, gesture, body framing, hands/props.
- Anime medium: clean cel, visual novel, manga page, key visual, soft pastel,
  chibi sticker, etc.
- Composition: bust/full-body, portrait/landscape, background complexity.
- Identity constraints: hair/eye color, outfit, signature accessories.

Avoid:

- "Beautiful anime girl" replacing the actual character.
- Random alternate costume when official outfit is requested.
- Overloaded backgrounds that steal focus.
- Carrying references from an old unrelated turn.

Source basis:

- OpenAI image guide on reference-led generation/editing:
  https://developers.openai.com/api/docs/guides/image-generation
- Midjourney docs on image/style references as a general mature pattern:
  https://docs.midjourney.com/hc/en-us/articles/33329261836941-Getting-Started-Guide
- Hugging Face Diffusers prompting guide:
  https://huggingface.co/docs/diffusers/en/using-diffusers/weighted_prompts
