---
id: recipe.official_character_generation
title: Official Character Reference Generation
type: recipe
tags: image, character, reference, official, generation
aliases: character_reference, official_reference, canon_character
tools: web_image_search, image, download_image_url, image_generate
---

Use when the user asks for a named character, public person, VTuber, mascot, or
specific persona and no reliable reference image is already delivered.

Workflow:

1. Search for official/canonical references first.
2. Inspect at least one promising image before generation.
3. Pass selected reference images to `image_generate.images`.
4. Use the prompt mainly for requested action, composition, mood, and any user
   style changes. Let the reference image carry the original design/style.

Avoid:

- Text-only generation for a specified character.
- Passing old generated images as references unless the user explicitly asks to
  edit that exact generated image.
