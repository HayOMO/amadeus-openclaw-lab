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

1. Search for official/canonical references first: official character pages,
   official art books, game/anime sites, publisher pages, or high-confidence
   source wikis when official pages are not reachable.
2. Verify the source title and at least one visible image: hair, eyes, outfit,
   silhouette, signature accessories, palette, and common wrong variants.
3. Pass selected reference images to `image_generate.images`.
4. Use the prompt mainly for requested action, composition, mood, and any user
   style changes. Let the reference image carry the original design/style.

Avoid:

- Text-only generation for a specified character.
- Passing old or current-turn generated images as references unless the user
  explicitly asks to edit that exact generated image.
