---
id: recipe.gpt_image_2_prompt_blueprint
title: GPT Image 2 Prompt Blueprint
type: recipe
tags: image, gpt-image-2, image2, prompt, blueprint, quality, size
aliases: image2_blueprint, universal_image_prompt, shengtu_blueprint, gpt_image_prompt
tools: image_generate, prompt_library, image_skill_lookup
---

Use as the default drafting frame for non-trivial `gpt-image-2` / image2
requests before selecting a more specific recipe.

Prompt shape:

1. Purpose: what the image will be used for, such as avatar, academic figure,
   poster, sticker, product mockup, reference sheet, or photoreal scene.
2. Subject: the main object/person/character/action. Put it early.
3. Medium/style: photo, clean anime cel, vector infographic, 3D render, ink
   drawing, editorial poster, UI mockup, etc.
4. Composition: aspect/orientation, framing, viewpoint, foreground/background,
   and where text or empty space should sit.
5. Details: materials, expression, pose, lighting, palette, texture, props.
6. Constraints: exact text, identity/reference preservation, avoid/crop rules,
   and output format needs such as transparent PNG.

Model knobs:

- Leave quality/size unset for ordinary chat unless the user asks.
- Use low quality for fast drafts and ideation.
- Use medium/high for dense text, academic diagrams, portraits, identity edits,
  final posters, or high-resolution output.
- Prefer common sizes: square, portrait, landscape, widescreen, or phone poster.
  Avoid extreme aspect ratios beyond 3:1.

Source basis:

- OpenAI GPT Image Models Prompting Guide:
  https://developers.openai.com/cookbook/examples/multimodal/image-gen-models-prompting-guide
- OpenAI Image Generation API guide:
  https://developers.openai.com/api/docs/guides/image-generation
- OpenAI image generation tool guide:
  https://developers.openai.com/api/docs/guides/tools-image-generation
